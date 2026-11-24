import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ERROR_CODES, toQuantity, toUnitCost, uuidv7 } from '@iv2/shared-domain';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';
import { resolvePolicy } from '../iam/public/index.js';
import { stockBalances, stockLotBalances, stockLots, stockMovements } from './db/index.js';
import { assignOpeningLots, postMovements } from './public/index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('inventory hybrid cutover for existing shelf stock integration', () => {
  let pool: Pool;

  beforeAll(() => {
    if (!testDbUrl) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    pool = createPool(testDbUrl);
  });

  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function setupNonLotSkuWithStockFixture() {
    const db = createDb(pool);
    const outboxDispatcher = new OutboxDispatcher(db);
    const app = buildApp({ pool, db, outboxDispatcher, nodeEnv: 'test' });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Warehouse Lead',
        email: 'lead@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'BOX', name: 'Boxes' },
    });
    expect(uomRes.statusCode).toBe(201);
    const uomId = uomRes.json().data.id as string;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Yogurt Cup' },
    });
    expect(prodRes.statusCode).toBe(201);
    const productId = prodRes.json().data.id as string;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'YOG-1',
        name: 'Yogurt 150g',
        unitOfMeasureId: uomId,
        trackLots: false,
        trackExpiry: false,
      },
    });
    expect(skuRes.statusCode).toBe(201);
    const skuId = skuRes.json().data.id as string;
    const skuVersion = skuRes.json().data.version as number;

    const locRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Warehouse', type: 'WAREHOUSE' },
    });
    expect(locRes.statusCode).toBe(201);
    const locationId = locRes.json().data.id as string;

    return { db, app, cookie, skuId, skuVersion, locationId };
  }

  it('returns recent Purchase Order receipt cost suggestions for a SKU and Location, and redacts costs when unauthorized', async () => {
    const { db, app, cookie, skuId, locationId } = await setupNonLotSkuWithStockFixture();

    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('8.50'),
          referenceType: 'PURCHASE_ORDER',
          referenceId: uuidv7(),
          actorId: 'lead',
          idempotencyKey: uuidv7(),
        },
      ]);
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('10.25'),
          referenceType: 'PURCHASE_ORDER',
          referenceId: uuidv7(),
          actorId: 'lead',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${skuId}/recent-receipt-costs?locationId=${locationId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.skuId).toBe(skuId);
    expect(body.locationId).toBe(locationId);
    expect(body.suggestedUnitCost).toBe('10.2500');
    expect(body.recentReceipts).toHaveLength(2);
    expect(body.recentReceipts[0].recentUnitCost).toBe('10.2500');
    expect(body.recentReceipts[1].recentUnitCost).toBe('8.5000');

    // Redaction check when user lacks cost-viewing permission
    const restrictedPolicy = resolvePolicy(
      { id: 'u2', email: 'clerk@example.com', name: 'Clerk' },
      { canViewCosts: false },
    );
    const redacted = restrictedPolicy.redactCosts(body);
    expect('suggestedUnitCost' in redacted).toBe(false);
    expect('recentUnitCost' in redacted.recentReceipts[0]).toBe(false);
  });

  it('supports Guided Opening Split via assignOpeningLots (full split, partial cycle-count, validation, and idempotency)', async () => {
    const { db, app, cookie, skuId, locationId } = await setupNonLotSkuWithStockFixture();

    // Receive 10 unlotted units @ $11.0000
    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          quantityDelta: toQuantity('10'),
          unitCost: toUnitCost('11.00'),
          referenceType: 'PURCHASE_ORDER',
          referenceId: uuidv7(),
          actorId: 'lead',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // Enable trackLots + trackExpiry on SKU with positive stock
    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { trackLots: true, trackExpiry: true },
    });
    expect(enableRes.statusCode).toBe(200);

    // Reject if sum > current positive unlotted stock (11 > 10)
    const overAssignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-lots/assign-opening',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId,
        locationId,
        lots: [{ lotCode: 'LOT-OVER', expDate: '2027-05-01', quantity: '11', unitCost: '11' }],
      },
    });
    expect(overAssignRes.statusCode).toBe(422);

    // Reject if trackExpiry is true and expDate is missing
    const missingExpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-lots/assign-opening',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId,
        locationId,
        lots: [{ lotCode: 'LOT-NOEXP', quantity: '4', unitCost: '11' }],
      },
    });
    expect(missingExpRes.statusCode).toBe(422);
    expect(missingExpRes.json().error.code).toBe(ERROR_CODES.EXPIRY_DATE_REQUIRED);

    // Partial cycle-count assignment: assign 4 units to LOT-A, leaving 6 unlotted
    const partialKey = uuidv7();
    const partialRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-lots/assign-opening',
      headers: { cookie, 'idempotency-key': partialKey },
      payload: {
        skuId,
        locationId,
        lots: [{ lotCode: 'LOT-A', expDate: '2027-03-01', quantity: '4', unitCost: '10.50' }],
      },
    });
    expect(partialRes.statusCode).toBe(201);
    const partialData = partialRes.json().data;
    expect(partialData.assignedQuantity).toBe('4.0000');
    expect(partialData.remainingUnlottedQuantity).toBe('6.0000');
    expect(partialData.movements).toHaveLength(2);
    expect(partialData.movements[0].lotId).toBeNull();
    expect(partialData.movements[0].quantityDelta).toBe('-4.0000');
    expect(partialData.movements[1].quantityDelta).toBe('4.0000');
    expect(partialData.movements[0].movementGroupId).toBe(partialData.movements[1].movementGroupId);

    // Stock balance on_hand must remain 10.0000, unlottedOnHand = 6.0000
    const balRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}&view=per-location`,
      headers: { cookie },
    });
    expect(balRes.statusCode).toBe(200);
    expect(balRes.json().data[0].onHand).toBe('10.0000');
    expect(balRes.json().data[0].unlottedOnHand).toBe('6.0000');

    // Assign remaining 6 units across 2 lots via inventory/public seam
    const seamKey = uuidv7();
    const seamResult = await db.transaction(async (tx) =>
      assignOpeningLots(tx, {
        skuId,
        locationId,
        actorId: 'lead',
        idempotencyKey: seamKey,
        lots: [
          { lotCode: 'LOT-B', expDate: '2027-04-01', quantity: toQuantity('2'), unitCost: toUnitCost('11.00') },
          { lotCode: 'LOT-C', expDate: '2027-06-01', quantity: toQuantity('4'), unitCost: toUnitCost('11.50') },
        ],
      }),
    );
    expect(seamResult.assignedQuantity).toBe('6.0000');
    expect(seamResult.remainingUnlottedQuantity).toBe('0.0000');
    expect(seamResult.movements).toHaveLength(3);

    // Idempotency replay on inventory/public seam
    const replayResult = await db.transaction(async (tx) =>
      assignOpeningLots(tx, {
        skuId,
        locationId,
        actorId: 'lead',
        idempotencyKey: seamKey,
        lots: [
          { lotCode: 'LOT-B', expDate: '2027-04-01', quantity: toQuantity('2'), unitCost: toUnitCost('11.00') },
          { lotCode: 'LOT-C', expDate: '2027-06-01', quantity: toQuantity('4'), unitCost: toUnitCost('11.50') },
        ],
      }),
    );
    expect(replayResult.replayed).toBe(true);
    expect(replayResult.movements).toHaveLength(3);

    // Verify DB state: stock_balances.onHand still 10.0000, stock_lot_balances sum to 10.0000
    const [balRow] = await db
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.skuId, skuId));
    expect(balRow?.onHand).toBe('10.0000');

    const lotBalRows = await db
      .select({ lotCode: stockLots.lotCode, onHand: stockLotBalances.onHand, unitCost: stockLotBalances.unitCost })
      .from(stockLotBalances)
      .innerJoin(stockLots, eq(stockLotBalances.lotId, stockLots.id))
      .where(eq(stockLots.skuId, skuId))
      .orderBy(asc(stockLots.lotCode));
    expect(lotBalRows).toEqual([
      { lotCode: 'LOT-A', onHand: '4.0000', unitCost: '10.5000' },
      { lotCode: 'LOT-B', onHand: '2.0000', unitCost: '11.0000' },
      { lotCode: 'LOT-C', onHand: '4.0000', unitCost: '11.5000' },
    ]);

    const seamMovements = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.idempotencyKey, seamKey))
      .orderBy(asc(stockMovements.sliceIndex));
    expect(seamMovements).toHaveLength(3);
    expect(seamMovements.map((m) => m.sliceIndex)).toEqual([0, 1, 2]);
    expect(seamMovements[0]!.lotId).toBeNull();
    expect(seamMovements[0]!.quantityDelta).toBe('-6.0000');
    expect(seamMovements[1]!.wacUnitCost).toBe('11.0000');

    // Assigning again when unlotted stock is 0 returns 422
    const emptyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-lots/assign-opening',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId,
        locationId,
        lots: [{ lotCode: 'LOT-D', expDate: '2027-07-01', quantity: '1', unitCost: '11' }],
      },
    });
    expect(emptyRes.statusCode).toBe(422);
  });

  it('supports Prospective Cutover: enforces lot capture on new receipts and drains positive unlotted stock first on outbound issue', async () => {
    const { db, app, cookie, skuId, locationId } = await setupNonLotSkuWithStockFixture();

    // 1. Existing unlotted stock: 10.0000 @ $10.0000
    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          quantityDelta: toQuantity('10'),
          unitCost: toUnitCost('10.00'),
          referenceType: 'PURCHASE_ORDER',
          referenceId: uuidv7(),
          actorId: 'lead',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // 2. Prospective cutover: enable trackLots + trackExpiry without assigning opening lots
    const enableRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { trackLots: true, trackExpiry: true },
    });
    expect(enableRes.statusCode).toBe(200);

    // 3. New receipt without lot info is rejected (LOT_CODE_REQUIRED)
    await expect(
      db.transaction(async (tx) => {
        await postMovements(tx, [
          {
            type: 'RECEIPT',
            skuId,
            locationId,
            quantityDelta: toQuantity('5'),
            unitCost: toUnitCost('14.00'),
            referenceType: 'PURCHASE_ORDER',
            referenceId: uuidv7(),
            actorId: 'lead',
            idempotencyKey: uuidv7(),
          },
        ]);
      }),
    ).rejects.toThrow();

    // 4. New receipt with lot info succeeds
    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('14.00'),
          lotInput: { lotCode: 'LOT-NEW-1', expDate: '2027-12-31' },
          referenceType: 'PURCHASE_ORDER',
          referenceId: uuidv7(),
          actorId: 'lead',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // 5. Outbound issue of 12.0000 drains 10.0000 unlotted first, then 2.0000 from LOT-NEW-1
    const issueRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/issues',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId,
        locationId,
        quantity: '12',
      },
    });
    expect(issueRes.statusCode).toBe(201);
    const movements = issueRes.json().data;
    expect(movements).toHaveLength(2);
    expect(movements[0].lotId).toBeNull();
    expect(movements[0].quantityDelta).toBe('-10.0000');
    expect(movements[1].lotCode).toBe('LOT-NEW-1');
    expect(movements[1].quantityDelta).toBe('-2.0000');

    const balRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}&view=per-location`,
      headers: { cookie },
    });
    expect(balRes.statusCode).toBe(200);
    expect(balRes.json().data[0].onHand).toBe('3.0000');
    expect(balRes.json().data[0].unlottedOnHand).toBe('0.0000');
  });
});

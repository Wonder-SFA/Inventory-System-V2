import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  ERROR_CODES,
  type StockMovement,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';
import { stockBalances, stockLotBalances, stockMovements } from './db/index.js';
import { postMovements } from './public/index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('inventory FEFO allocation, multi-lot ledger splits & concurrency integration', () => {
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

  async function setupLotSkuFixture() {
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
      payload: { name: 'Fresh Milk', description: 'Perishable dairy' },
    });
    expect(prodRes.statusCode).toBe(201);
    const productId = prodRes.json().data.id as string;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'MILK-1L',
        name: 'Fresh Milk 1L',
        unitOfMeasureId: uomId,
        trackLots: true,
        trackExpiry: true,
      },
    });
    expect(skuRes.statusCode).toBe(201);
    const skuId = skuRes.json().data.id as string;

    const locRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Cold Room A' },
    });
    expect(locRes.statusCode).toBe(201);
    const locationId = locRes.json().data.id as string;

    return { db, app, cookie, skuId, locationId };
  }

  it('allocates positive unlotted stock first, skips expired lots, splits across FEFO/FIFO lots with dual costs, and replays idempotently', async () => {
    const { db, app, cookie, skuId, locationId } = await setupLotSkuFixture();

    await db.transaction(async (tx) => {
      // 1. Positive unlotted stock (e.g. from prospective cutover): 2 units @ $10.0000
      await postMovements(tx, [
        {
          type: 'ADJUSTMENT',
          skuId,
          locationId,
          quantityDelta: toQuantity('2'),
          unitCost: toUnitCost('10'),
          reasonCategory: 'STOCK_COUNT',
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // 2. Expired lot (should be skipped): 5 units @ $8.0000
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-EXPIRED', expDate: '2026-04-01' },
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('8'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // 3. Earliest non-expired lot: 3 units @ $12.0000
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-EARLY', expDate: '2026-06-01' },
          quantityDelta: toQuantity('3'),
          unitCost: toUnitCost('12'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // 4. Later non-expired lot: 4 units @ $15.0000
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-LATE', expDate: '2026-07-01' },
          quantityDelta: toQuantity('4'),
          unitCost: toUnitCost('15'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // Total onHand = 2 + 5 + 3 + 4 = 14
    // WAC = (2*10 + 5*8 + 3*12 + 4*15) / 14 = (20 + 40 + 36 + 60) / 14 = 156 / 14 = 11.1429

    // Check FEFO preview endpoint before dispatch
    const previewRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-lots/fefo-preview?skuId=${skuId}&locationId=${locationId}&quantity=7&today=2026-05-01`,
      headers: { cookie },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json().data;
    expect(preview.slices).toHaveLength(3);
    expect(preview.slices[0]).toMatchObject({ lotId: null, quantity: '2.0000', isUnlotted: true });
    expect(preview.slices[1]).toMatchObject({ lotCode: 'LOT-EARLY', quantity: '3.0000' });
    expect(preview.slices[2]).toMatchObject({ lotCode: 'LOT-LATE', quantity: '2.0000' });

    const issueIdemKey = uuidv7();
    const firstIssue = await db.transaction(async (tx) => {
      return postMovements(tx, [
        {
          type: 'ISSUE',
          skuId,
          locationId,
          quantityDelta: toQuantity('-7'),
          today: '2026-05-01',
          pickingMode: 'AUTO_FEFO',
          negativeStockPolicy: 'STRICT_BLOCK',
          actorId: 'user-1',
          idempotencyKey: issueIdemKey,
        },
      ]);
    });

    expect(firstIssue.movements).toHaveLength(3);
    const groupId = firstIssue.movements[0]!.movementGroupId;
    expect(groupId).toBeTruthy();

    expect(firstIssue.movements[0]).toMatchObject({
      lotId: null,
      sliceIndex: 0,
      movementGroupId: groupId,
      quantityDelta: '-2.0000',
      unitCost: '11.1429',
      wacUnitCost: '11.1429',
    });
    expect(firstIssue.movements[1]).toMatchObject({
      lotCode: 'LOT-EARLY',
      sliceIndex: 1,
      movementGroupId: groupId,
      quantityDelta: '-3.0000',
      unitCost: '12.0000',
      wacUnitCost: '11.1429',
    });
    expect(firstIssue.movements[2]).toMatchObject({
      lotCode: 'LOT-LATE',
      sliceIndex: 2,
      movementGroupId: groupId,
      quantityDelta: '-2.0000',
      unitCost: '15.0000',
      wacUnitCost: '11.1429',
    });

    // Idempotent replay with same idempotencyKey
    const replayIssue = await db.transaction(async (tx) => {
      return postMovements(tx, [
        {
          type: 'ISSUE',
          skuId,
          locationId,
          quantityDelta: toQuantity('-7'),
          today: '2026-05-01',
          pickingMode: 'AUTO_FEFO',
          negativeStockPolicy: 'STRICT_BLOCK',
          actorId: 'user-1',
          idempotencyKey: issueIdemKey,
        },
      ]);
    });

    expect(replayIssue.movements.map((m: StockMovement) => m.id)).toEqual(
      firstIssue.movements.map((m: StockMovement) => m.id),
    );

    const [bal] = await db
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.skuId, skuId));
    expect(bal!.onHand).toBe('7.0000'); // 14 - 7 = 7
    expect(bal!.weightedAverageCost).toBe('11.1429');

    const persistedRows = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.idempotencyKey, issueIdemKey));
    expect(persistedRows).toHaveLength(3);
  });

  it('handles shortfall differently under STRICT_BLOCK vs FLEXIBLE_UNASSIGNED', async () => {
    const { db, skuId, locationId } = await setupLotSkuFixture();

    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-ONLY', expDate: '2026-08-01' },
          quantityDelta: toQuantity('3'),
          unitCost: toUnitCost('20'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // STRICT_BLOCK rejects cleanly
    await expect(
      db.transaction(async (tx) => {
        return postMovements(tx, [
          {
            type: 'ISSUE',
            skuId,
            locationId,
            quantityDelta: toQuantity('-5'),
            today: '2026-05-01',
            pickingMode: 'AUTO_FEFO',
            negativeStockPolicy: 'STRICT_BLOCK',
            actorId: 'user-1',
            idempotencyKey: uuidv7(),
          },
        ]);
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: ERROR_CODES.INSUFFICIENT_LOT_STOCK,
    });

    // FLEXIBLE_UNASSIGNED writes shortfall slice with lotId = null and emits warning
    const flexResult = await db.transaction(async (tx) => {
      return postMovements(tx, [
        {
          type: 'ISSUE',
          skuId,
          locationId,
          quantityDelta: toQuantity('-5'),
          today: '2026-05-01',
          pickingMode: 'AUTO_FEFO',
          negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    expect(flexResult.movements).toHaveLength(2);
    expect(flexResult.movements[0]).toMatchObject({
      lotCode: 'LOT-ONLY',
      sliceIndex: 0,
      quantityDelta: '-3.0000',
      unitCost: '20.0000',
    });
    expect(flexResult.movements[1]).toMatchObject({
      lotId: null,
      sliceIndex: 1,
      quantityDelta: '-2.0000',
      unitCost: '20.0000',
      wacUnitCost: '20.0000',
    });
    expect(flexResult.warnings.some((w) => w.code === 'NEGATIVE_ON_HAND_STOCK')).toBe(true);

    const [bal] = await db
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.skuId, skuId));
    expect(bal!.onHand).toBe('-2.0000');
    expect(bal!.weightedAverageCost).toBe('20.0000');
  });

  it('prevents deadlocks under concurrent multi-lot dispatches', async () => {
    const { db, skuId, locationId } = await setupLotSkuFixture();

    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-1', expDate: '2026-06-01' },
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('10'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId,
          locationId,
          lotInput: { lotCode: 'LOT-2', expDate: '2026-07-01' },
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('12'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    const [resA, resB] = await Promise.all([
      db.transaction((tx) =>
        postMovements(tx, [
          {
            type: 'ISSUE',
            skuId,
            locationId,
            quantityDelta: toQuantity('-4'),
            today: '2026-05-01',
            pickingMode: 'AUTO_FEFO',
            negativeStockPolicy: 'STRICT_BLOCK',
            actorId: 'user-1',
            idempotencyKey: uuidv7(),
          },
        ]),
      ),
      db.transaction((tx) =>
        postMovements(tx, [
          {
            type: 'ISSUE',
            skuId,
            locationId,
            quantityDelta: toQuantity('-4'),
            today: '2026-05-01',
            pickingMode: 'AUTO_FEFO',
            negativeStockPolicy: 'STRICT_BLOCK',
            actorId: 'user-2',
            idempotencyKey: uuidv7(),
          },
        ]),
      ),
    ]);

    expect(resA.movements.length).toBeGreaterThanOrEqual(1);
    expect(resB.movements.length).toBeGreaterThanOrEqual(1);

    const [bal] = await db
      .select()
      .from(stockBalances)
      .where(eq(stockBalances.skuId, skuId));
    expect(bal!.onHand).toBe('2.0000');

    const lotBals = await db
      .select()
      .from(stockLotBalances)
      .where(eq(stockLotBalances.locationId, locationId));
    const totalLotOnHand = lotBals.reduce((sum, b) => sum + Number(b.onHand), 0);
    expect(totalLotOnHand).toBe(2);
  });
});

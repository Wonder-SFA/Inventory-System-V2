import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  ERROR_CODES,
  type StockBalance,
  type StockMovement,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';
import { resolvePolicy } from '../iam/public/index.js';
import { stockLotBalances, stockLots } from './db/index.js';
import {
  closeTransferDiscrepancy,
  dispatchTransfer,
  postMovements,
  receiveTransfer,
  releaseReservation,
  reserveStock,
} from './public/index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('inventory stock ledger, projected balances, WAC & concurrency integration', () => {
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

  async function setupFixture() {
    const db = createDb(pool);
    const outboxDispatcher = new OutboxDispatcher(db);
    const app = buildApp({ pool, db, outboxDispatcher, nodeEnv: 'test' });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Warehouse Clerk',
        email: 'clerk@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    // Create Unit of Measure
    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'PCS', name: 'Pieces' },
    });
    expect(uomRes.statusCode).toBe(201);
    const uomId = uomRes.json().data.id as string;

    // Create Product
    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Cotton T-Shirt', description: 'Classic tee' },
    });
    expect(prodRes.statusCode).toBe(201);
    const productId = prodRes.json().data.id as string;

    // Create 2 SKUs
    const sku1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        unitOfMeasureId: uomId,
        code: 'TSHIRT-RED-M',
        name: 'Cotton T-Shirt - Red M',
        defaultSellingPrice: '25.0000',
      },
    });
    expect(sku1Res.statusCode).toBe(201);
    const sku1Id = sku1Res.json().data.id as string;

    const sku2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        unitOfMeasureId: uomId,
        code: 'TSHIRT-BLU-L',
        name: 'Cotton T-Shirt - Blue L',
        defaultSellingPrice: '30.0000',
      },
    });
    expect(sku2Res.statusCode).toBe(201);
    const sku2Id = sku2Res.json().data.id as string;

    // Create 2 Locations
    const loc1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Warehouse' },
    });
    expect(loc1Res.statusCode).toBe(201);
    const loc1Id = loc1Res.json().data.id as string;

    const loc2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Downtown Store' },
    });
    expect(loc2Res.statusCode).toBe(201);
    const loc2Id = loc2Res.json().data.id as string;

    return { app, db, outboxDispatcher, cookie, sku1Id, sku2Id, loc1Id, loc2Id };
  }

  it('posts manual stock adjustments, computes WAC, handles negative-stock WAC reset/preservation, and emits warnings', async () => {
    const { app, outboxDispatcher, cookie, sku1Id, loc1Id } = await setupFixture();
    const events: string[] = [];
    outboxDispatcher.registerConsumer('test-stock-adj', async (ev) => {
      events.push(ev.eventType);
    });

    // 1. Validation: quantityDelta = 0 -> 422
    const zeroRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '0',
        reasonCategory: 'STOCK_COUNT',
      },
    });
    expect(zeroRes.statusCode).toBe(422);

    // 2. Validation: > 4 decimal places -> 422 DECIMAL_PRECISION_EXCEEDED
    const precisionRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '1.12345',
        reasonCategory: 'STOCK_COUNT',
      },
    });
    expect(precisionRes.statusCode).toBe(422);
    expect(precisionRes.json().error.code).toBe(ERROR_CODES.DECIMAL_PRECISION_EXCEEDED);

    // 3. Initial positive adjustment: +10 @ 10.0000 -> onHand = 10.0000, WAC = 10.0000
    const adj1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '10',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '10.0000',
        note: 'Initial count',
      },
    });
    expect(adj1Res.statusCode).toBe(201);
    const adj1 = adj1Res.json().data as StockMovement;
    expect(adj1.type).toBe('ADJUSTMENT');
    expect(adj1.quantityDelta).toBe('10.0000');
    expect(adj1.unitCost).toBe('10.0000');
    expect(adj1Res.json().warnings).toBeUndefined();

    // 4. Second positive adjustment: +10 @ 14.0000 -> onHand = 20.0000, WAC = 12.0000
    const adj2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '10.0000',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '14.0000',
      },
    });
    expect(adj2Res.statusCode).toBe(201);

    // Verify balance & margin
    const bal1Res = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${loc1Id}&skuId=${sku1Id}`,
      headers: { cookie },
    });
    expect(bal1Res.statusCode).toBe(200);
    const bal1 = bal1Res.json().data[0] as StockBalance;
    expect(bal1.onHand).toBe('20.0000');
    expect(bal1.weightedAverageCost).toBe('12.0000');
    expect(bal1.totalValue).toBe('240.0000');
    expect(bal1.sellingPrice).toBe('25.0000');
    expect(bal1.grossMargin).toBe('13.0000');
    expect(bal1.valuationStatus).toBe('NORMAL');
    expect(bal1.zeroOrNegativeFlag).toBe(false);

    // 5. Negative adjustment pushing stock below zero: -25 DAMAGED -> onHand = -5.0000
    //    WAC must be preserved at 12.0000, warnings must include NEGATIVE_ON_HAND_STOCK and ZERO_OR_NEGATIVE_AVAILABLE_STOCK
    const negRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '-25',
        reasonCategory: 'DAMAGED',
        note: 'Water damage',
      },
    });
    expect(negRes.statusCode).toBe(201);
    const warnings = negRes.json().warnings as Array<{ code: string }>;
    expect(warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['NEGATIVE_ON_HAND_STOCK', 'ZERO_OR_NEGATIVE_AVAILABLE_STOCK']),
    );

    const balNegRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?zeroOrNegativeOnly=true`,
      headers: { cookie },
    });
    expect(balNegRes.statusCode).toBe(200);
    expect(balNegRes.json().data).toHaveLength(1);
    const balNeg = balNegRes.json().data[0] as StockBalance;
    expect(balNeg.onHand).toBe('-5.0000');
    expect(balNeg.weightedAverageCost).toBe('12.0000');
    expect(balNeg.valuationStatus).toBe('ESTIMATED_NEGATIVE_STOCK');
    expect(balNeg.zeroOrNegativeFlag).toBe(true);

    // 6. Partial recovery remaining <= 0: +3 @ 20.0000 -> onHand = -2.0000, WAC still preserved at 12.0000
    const partialRecRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '3',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '20.0000',
      },
    });
    expect(partialRecRes.statusCode).toBe(201);

    const balPartialRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${loc1Id}&skuId=${sku1Id}`,
      headers: { cookie },
    });
    expect(balPartialRes.json().data[0].onHand).toBe('-2.0000');
    expect(balPartialRes.json().data[0].weightedAverageCost).toBe('12.0000');
    expect(balPartialRes.json().data[0].valuationStatus).toBe('ESTIMATED_NEGATIVE_STOCK');

    // 7. Full recovery > 0: +7 @ 18.0000 -> onHand = 5.0000, WAC resets to incoming 18.0000!
    const fullRecRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '7',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '18.0000',
      },
    });
    expect(fullRecRes.statusCode).toBe(201);

    const balRecRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${loc1Id}&skuId=${sku1Id}`,
      headers: { cookie },
    });
    const balRec = balRecRes.json().data[0] as StockBalance;
    expect(balRec.onHand).toBe('5.0000');
    expect(balRec.weightedAverageCost).toBe('18.0000');
    expect(balRec.totalValue).toBe('90.0000');
    expect(balRec.valuationStatus).toBe('NORMAL');

    await outboxDispatcher.drainOutbox();
    expect(events.filter((e) => e === 'StockAdjusted')).toHaveLength(5);
  });

  it('enforces idempotency replay and conflict on manual adjustments', async () => {
    const { app, cookie, sku1Id, loc1Id } = await setupFixture();
    const idemKey = uuidv7();
    const payload = {
      skuId: sku1Id,
      locationId: loc1Id,
      quantityDelta: '5.0000',
      reasonCategory: 'STOCK_COUNT',
      unitCost: '10.0000',
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': idemKey },
      payload,
    });
    expect(res1.statusCode).toBe(201);

    // Same key + same payload -> replay
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': idemKey },
      payload,
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json().data.id).toBe(res1.json().data.id);

    // Same key + different payload -> 409 IDEMPOTENCY_KEY_CONFLICT
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': idemKey },
      payload: { ...payload, quantityDelta: '6.0000' },
    });
    expect(res3.statusCode).toBe(409);
    expect(res3.json().error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);
  });

  it('protects referenced SKUs and Locations from hard deletion (409 RESOURCE_IN_USE)', async () => {
    const { app, cookie, sku1Id, loc1Id } = await setupFixture();

    const adjRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '5',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '10.0000',
      },
    });
    expect(adjRes.statusCode).toBe(201);

    const delSkuRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delSkuRes.statusCode).toBe(409);
    expect(delSkuRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    const delLocRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${loc1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delLocRes.statusCode).toBe(409);
    expect(delLocRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);
  });

  it('supports company-wide valuation aggregation, keyset pagination on movements, and cost redaction', async () => {
    const { app, cookie, sku1Id, loc1Id, loc2Id } = await setupFixture();

    // Loc 1: +10 @ 10.0000 ($100)
    await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '10',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '10.0000',
      },
    });

    // Loc 2: +20 @ 16.0000 ($320)
    await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc2Id,
        quantityDelta: '20',
        reasonCategory: 'STOCK_COUNT',
        unitCost: '16.0000',
      },
    });

    // Loc 2: -5 DAMAGED (leaves 15 @ 16.0000 = $240)
    await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc2Id,
        quantityDelta: '-5',
        reasonCategory: 'DAMAGED',
      },
    });

    // Company-wide: onHand = 25, totalValue = 100 + 240 = 340.0000, WAC = 340 / 25 = 13.6000
    const cwRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?view=company-wide&skuId=${sku1Id}`,
      headers: { cookie },
    });
    expect(cwRes.statusCode).toBe(200);
    expect(cwRes.json().data).toHaveLength(1);
    const cw = cwRes.json().data[0] as StockBalance;
    expect(cw.locationId).toBeNull();
    expect(cw.locationName).toBeNull();
    expect(cw.onHand).toBe('25.0000');
    expect(cw.totalValue).toBe('340.0000');
    expect(cw.weightedAverageCost).toBe('13.6000');
    expect(cw.grossMargin).toBe('11.4000');

    // Verify cost redaction policy strips unitCost, weightedAverageCost, totalValue
    const restrictedPolicy = resolvePolicy(
      { id: 'u1', email: 'u1@example.com', name: 'Viewer' },
      { canViewCosts: false },
    );
    const redacted = restrictedPolicy.redactCosts(cw);
    expect('weightedAverageCost' in redacted).toBe(false);
    expect('totalValue' in redacted).toBe(false);

    // Keyset pagination on stock-movements: limit=2
    const page1Res = await app.inject({
      method: 'GET',
      url: '/api/v1/stock-movements?limit=2',
      headers: { cookie },
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json();
    expect(page1.data).toHaveLength(2);
    expect(page1.page.hasMore).toBe(true);
    expect(page1.page.nextCursor).toBeTruthy();

    const page2Res = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-movements?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor)}`,
      headers: { cookie },
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json();
    expect(page2.data).toHaveLength(1);
    expect(page2.page.hasMore).toBe(false);
    const allIds = [...page1.data, ...page2.data].map((m: StockMovement) => m.id);
    expect(new Set(allIds).size).toBe(3);
  });

  it('rejects direct SQL UPDATE and DELETE on inventory.stock_movements via DB trigger', async () => {
    const { app, db, cookie, sku1Id, loc1Id } = await setupFixture();

    const adjRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: loc1Id,
        quantityDelta: '5',
        reasonCategory: 'STOCK_COUNT',
      },
    });
    expect(adjRes.statusCode).toBe(201);
    const movementId = adjRes.json().data.id as string;

    await expect(
      db.execute(
        sql`UPDATE inventory.stock_movements SET quantity_delta = 999 WHERE id = ${movementId}`,
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.execute(sql`DELETE FROM inventory.stock_movements WHERE id = ${movementId}`),
    ).rejects.toThrow(/append-only/);
  });

  it('executes concurrent multi-line balance updates locking overlapping pairs in opposite input order with zero deadlocks', async () => {
    const { db, sku1Id, sku2Id, loc1Id, loc2Id } = await setupFixture();

    const runBatch = async (reverse: boolean) => {
      const lines = [
        {
          type: 'RECEIPT' as const,
          skuId: sku1Id,
          locationId: loc1Id,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('10'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT' as const,
          skuId: sku2Id,
          locationId: loc2Id,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('20'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT' as const,
          skuId: sku1Id,
          locationId: loc2Id,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('12'),
          actorId: 'user-1',
          idempotencyKey: uuidv7(),
        },
      ];
      const orderedLines = reverse ? [...lines].reverse() : lines;

      return db.transaction(async (tx) => {
        return postMovements(tx, orderedLines);
      });
    };

    const [r1, r2] = await Promise.all([runBatch(false), runBatch(true)]);
    expect(r1.movements).toHaveLength(3);
    expect(r2.movements).toHaveLength(3);

    const { rows } = await pool.query<{ on_hand: string }>(
      `SELECT on_hand FROM inventory.stock_balances WHERE sku_id = $1 AND location_id = $2`,
      [sku1Id, loc1Id],
    );
    expect(rows[0]?.on_hand).toBe('10.0000');
  });

  it('supports reserveStock, releaseReservation, dispatchTransfer (cost snapshot), receiveTransfer, and closeTransferDiscrepancy', async () => {
    const { db, sku1Id, loc1Id, loc2Id } = await setupFixture();
    const transferOrderId = uuidv7();

    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          quantityDelta: toQuantity('20'),
          unitCost: toUnitCost('10'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // Reserve 5 units -> available = 15
      const res = await reserveStock(tx, [
        { skuId: sku1Id, locationId: loc1Id, quantity: toQuantity('5') },
      ]);
      expect(res.balances[0]?.available).toBe('15.0000');

      // Release 2 units -> reserved = 3, available = 17
      const rel = await releaseReservation(tx, [
        { skuId: sku1Id, locationId: loc1Id, quantity: toQuantity('2') },
      ]);
      expect(rel.balances[0]?.reserved).toBe('3.0000');
      expect(rel.balances[0]?.available).toBe('17.0000');

      // Dispatch 10 units from loc1 to loc2 -> snapshots WAC 10.0000
      const disp = await dispatchTransfer(tx, [
        {
          skuId: sku1Id,
          sourceLocationId: loc1Id,
          destinationLocationId: loc2Id,
          quantity: toQuantity('10'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      expect(disp.dispatchedLines[0]?.dispatchUnitCost).toBe('10.0000');

      // Source receives new stock at 30.0000 while transfer is in transit!
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          quantityDelta: toQuantity('10'),
          unitCost: toUnitCost('30'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // Receive 8 of the 10 in-transit units at loc2 using snapshotted dispatchUnitCost = 10.0000
      const rec = await receiveTransfer(tx, [
        {
          skuId: sku1Id,
          destinationLocationId: loc2Id,
          quantity: toQuantity('8'),
          dispatchUnitCost: disp.dispatchedLines[0]!.dispatchUnitCost,
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      expect(rec.balances[0]?.onHand).toBe('8.0000');
      expect(rec.balances[0]?.inTransit).toBe('2.0000');
      expect(rec.balances[0]?.weightedAverageCost).toBe('10.0000');

      // Close discrepancy for remaining 2 units
      const closed = await closeTransferDiscrepancy(tx, [
        {
          skuId: sku1Id,
          destinationLocationId: loc2Id,
          quantity: toQuantity('2'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
        },
      ]);
      expect(closed.balances[0]?.inTransit).toBe('0.0000');
    });
  });

  it('supports lot-tracked dispatchTransfer via FEFO with per-lot in_transit and dual cost snapshots', async () => {
    const { app, db, cookie, sku1Id, loc1Id, loc2Id } = await setupFixture();
    const skuLookup = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie },
    });
    const skuVersion = (skuLookup.json() as { data: { version: number } }).data.version;
    const toggleRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: skuVersion, trackLots: true, trackExpiry: true },
    });
    expect(toggleRes.statusCode).toBe(200);

    const transferOrderId = uuidv7();

    await db.transaction(async (tx) => {
      // Receive 4 units of LOT-EARLY (exp 2027-01-01) @ 10.0000
      // and 6 units of LOT-LATE (exp 2027-06-01) @ 20.0000
      const recLots = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          lotInput: { lotCode: 'LOT-EARLY', expDate: '2027-01-01' },
          quantityDelta: toQuantity('4'),
          unitCost: toUnitCost('10'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          lotInput: { lotCode: 'LOT-LATE', expDate: '2027-06-01' },
          quantityDelta: toQuantity('6'),
          unitCost: toUnitCost('20'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      const earlyLotId = recLots.movements[0]!.lotId!;
      const lateLotId = recLots.movements[1]!.lotId!;

      // Dispatch 7 units -> FEFO should take 4 from LOT-EARLY @ 10.0000 and 3 from LOT-LATE @ 20.0000
      // Source WAC = (4*10 + 6*20) / 10 = 16.0000
      const disp = await dispatchTransfer(tx, [
        {
          skuId: sku1Id,
          sourceLocationId: loc1Id,
          destinationLocationId: loc2Id,
          quantity: toQuantity('7'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      expect(disp.movements).toHaveLength(2);
      expect(disp.movements[0]?.lotId).toBe(earlyLotId);
      expect(disp.movements[0]?.quantityDelta).toBe('-4.0000');
      expect(disp.movements[0]?.unitCost).toBe('10.0000');
      expect(disp.movements[0]?.wacUnitCost).toBe('16.0000');
      expect(disp.movements[1]?.lotId).toBe(lateLotId);
      expect(disp.movements[1]?.quantityDelta).toBe('-3.0000');
      expect(disp.movements[1]?.unitCost).toBe('20.0000');
      expect(disp.movements[1]?.wacUnitCost).toBe('16.0000');

      expect(disp.dispatchedLines[0]?.lots).toEqual([
        {
          lotId: earlyLotId,
          lotCode: 'LOT-EARLY',
          expDate: '2027-01-01',
          quantity: '4.0000',
          dispatchUnitCost: '10.0000',
          dispatchWacUnitCost: '16.0000',
          currency: 'USD',
        },
        {
          lotId: lateLotId,
          lotCode: 'LOT-LATE',
          expDate: '2027-06-01',
          quantity: '3.0000',
          dispatchUnitCost: '20.0000',
          dispatchWacUnitCost: '16.0000',
          currency: 'USD',
        },
      ]);
    });

    // Verify destination stock_lot_balances.in_transit
    const { rows: lotBals } = await pool.query<{
      lot_code: string;
      location_id: string;
      on_hand: string;
      in_transit: string;
    }>(
      `SELECT l.lot_code, b.location_id, b.on_hand, b.in_transit
       FROM inventory.stock_lot_balances b
       JOIN inventory.stock_lots l ON l.id = b.lot_id
       WHERE l.sku_id = $1
       ORDER BY l.lot_code ASC, b.location_id ASC`,
      [sku1Id],
    );
    const srcEarly = lotBals.find((r) => r.lot_code === 'LOT-EARLY' && r.location_id === loc1Id);
    const dstEarly = lotBals.find((r) => r.lot_code === 'LOT-EARLY' && r.location_id === loc2Id);
    const srcLate = lotBals.find((r) => r.lot_code === 'LOT-LATE' && r.location_id === loc1Id);
    const dstLate = lotBals.find((r) => r.lot_code === 'LOT-LATE' && r.location_id === loc2Id);

    expect(srcEarly?.on_hand).toBe('0.0000');
    expect(dstEarly?.in_transit).toBe('4.0000');
    expect(srcLate?.on_hand).toBe('3.0000');
    expect(dstLate?.in_transit).toBe('3.0000');
  });

  it('supports lot-tracked receiveTransfer (destination lot blending) and closeTransferDiscrepancy (per-lot in_transit)', async () => {
    const { app, db, cookie, sku1Id, loc1Id, loc2Id } = await setupFixture();
    const skuLookup = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie },
    });
    const skuVersion = (skuLookup.json() as { data: { version: number } }).data.version;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: skuVersion, trackLots: true, trackExpiry: true },
    });

    const transferOrderId = uuidv7();

    await db.transaction(async (tx) => {
      // loc2 already holds 2 units of LOT-EARLY @ 5.0000
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc2Id,
          lotInput: { lotCode: 'LOT-EARLY', expDate: '2027-01-01' },
          quantityDelta: toQuantity('2'),
          unitCost: toUnitCost('5'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // loc1 holds 4 units of LOT-EARLY @ 10.0000 and 6 units of LOT-LATE @ 20.0000
      const recSrc = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          lotInput: { lotCode: 'LOT-EARLY', expDate: '2027-01-01' },
          quantityDelta: toQuantity('4'),
          unitCost: toUnitCost('10'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          lotInput: { lotCode: 'LOT-LATE', expDate: '2027-06-01' },
          quantityDelta: toQuantity('6'),
          unitCost: toUnitCost('20'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      const earlyLotId = recSrc.movements[0]!.lotId!;
      const lateLotId = recSrc.movements[1]!.lotId!;

      // Dispatch 7 units (4 LOT-EARLY @ 10, 3 LOT-LATE @ 20)
      await dispatchTransfer(tx, [
        {
          skuId: sku1Id,
          sourceLocationId: loc1Id,
          destinationLocationId: loc2Id,
          quantity: toQuantity('7'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);

      // Receive 4 LOT-EARLY @ 10 and 1 LOT-LATE @ 20
      const recGroupId = uuidv7();
      const recIdemKey = uuidv7();
      const rec = await receiveTransfer(tx, [
        {
          skuId: sku1Id,
          destinationLocationId: loc2Id,
          lotId: earlyLotId,
          sliceIndex: 0,
          movementGroupId: recGroupId,
          quantity: toQuantity('4'),
          dispatchUnitCost: toUnitCost('10'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: recIdemKey,
        },
        {
          skuId: sku1Id,
          destinationLocationId: loc2Id,
          lotId: lateLotId,
          sliceIndex: 1,
          movementGroupId: recGroupId,
          quantity: toQuantity('1'),
          dispatchUnitCost: toUnitCost('20'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
          idempotencyKey: recIdemKey,
        },
      ]);

      expect(rec.movements).toHaveLength(2);
      expect(rec.movements[0]?.lotId).toBe(earlyLotId);
      expect(rec.movements[0]?.unitCost).toBe('10.0000');
      expect(rec.movements[1]?.lotId).toBe(lateLotId);
      expect(rec.movements[1]?.unitCost).toBe('20.0000');
      expect(rec.balances[0]?.onHand).toBe('7.0000');
      expect(rec.balances[0]?.inTransit).toBe('2.0000');

      // Close discrepancy for remaining 2 units of LOT-LATE
      const closed = await closeTransferDiscrepancy(tx, [
        {
          skuId: sku1Id,
          destinationLocationId: loc2Id,
          lotId: lateLotId,
          quantity: toQuantity('2'),
          referenceId: transferOrderId,
          actorId: 'actor-1',
        },
      ]);
      expect(closed.balances[0]?.inTransit).toBe('0.0000');
    });

    const { rows: dstLots } = await pool.query<{
      lot_code: string;
      on_hand: string;
      in_transit: string;
      unit_cost: string;
    }>(
      `SELECT l.lot_code, b.on_hand, b.in_transit, b.unit_cost
       FROM inventory.stock_lot_balances b
       JOIN inventory.stock_lots l ON l.id = b.lot_id
       WHERE l.sku_id = $1 AND b.location_id = $2
       ORDER BY l.lot_code ASC`,
      [sku1Id, loc2Id],
    );
    const earlyDst = dstLots.find((r) => r.lot_code === 'LOT-EARLY');
    const lateDst = dstLots.find((r) => r.lot_code === 'LOT-LATE');
    expect(earlyDst?.on_hand).toBe('6.0000');
    expect(earlyDst?.in_transit).toBe('0.0000');
    expect(earlyDst?.unit_cost).toBe('8.3333');
    expect(lateDst?.on_hand).toBe('1.0000');
    expect(lateDst?.in_transit).toBe('0.0000');
    expect(lateDst?.unit_cost).toBe('20.0000');
  });

  it('supports lot-tracked receipts, expiry-mismatch rejection, repeat-delivery cost blending, dual costing on movements, and SKU positive-stock guard', async () => {
    const { app, db, cookie, sku1Id, loc1Id } = await setupFixture();

    // Create a lot-tracked + expiry-tracked SKU
    const skuLookup = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie },
    });
    const baseSku = skuLookup.json().data;

    const lotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: baseSku.productId,
        unitOfMeasureId: baseSku.unitOfMeasureId,
        code: 'LOT-SKU-1',
        name: 'Lot Tracked Milk',
        trackLots: true,
        trackExpiry: true,
      },
    });
    expect(lotSkuRes.statusCode).toBe(201);
    const lotSkuId = lotSkuRes.json().data.id as string;

    await db.transaction(async (tx) => {
      // 1. Non-lot SKU receipt persists both unitCost and wacUnitCost
      const nonLotRes = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: sku1Id,
          locationId: loc1Id,
          quantityDelta: toQuantity('5'),
          unitCost: toUnitCost('12.5'),
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      expect(nonLotRes.movements[0]?.unitCost).toBe('12.5000');
      expect(nonLotRes.movements[0]?.wacUnitCost).toBe('12.5000');
      expect(nonLotRes.movements[0]?.lotId ?? null).toBeNull();

      // 2. Lot-tracked SKU without lotCode is rejected
      await expect(
        postMovements(tx, [
          {
            type: 'RECEIPT',
            skuId: lotSkuId,
            locationId: loc1Id,
            quantityDelta: toQuantity('10'),
            unitCost: toUnitCost('5'),
            actorId: 'actor-1',
            idempotencyKey: uuidv7(),
          },
        ]),
      ).rejects.toMatchObject({ statusCode: 422, code: ERROR_CODES.LOT_CODE_REQUIRED });

      // 3. Lot-tracked + expiry-tracked SKU without expDate is rejected
      await expect(
        postMovements(tx, [
          {
            type: 'RECEIPT',
            skuId: lotSkuId,
            locationId: loc1Id,
            quantityDelta: toQuantity('10'),
            unitCost: toUnitCost('5'),
            lotInput: { lotCode: 'LOT-A', mfgDate: '2026-01-01' },
            actorId: 'actor-1',
            idempotencyKey: uuidv7(),
          },
        ]),
      ).rejects.toMatchObject({ statusCode: 422, code: ERROR_CODES.EXPIRY_DATE_REQUIRED });

      // 4. First valid lot receipt: +10 @ 5.0000
      const firstReceipt = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: lotSkuId,
          locationId: loc1Id,
          quantityDelta: toQuantity('10'),
          unitCost: toUnitCost('5'),
          lotInput: { lotCode: 'LOT-A', mfgDate: '2026-01-01', expDate: '2027-01-01' },
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      expect(firstReceipt.movements[0]?.lotCode).toBe('LOT-A');
      expect(firstReceipt.movements[0]?.unitCost).toBe('5.0000');
      expect(firstReceipt.movements[0]?.wacUnitCost).toBe('5.0000');
      const createdLotId = firstReceipt.movements[0]!.lotId!;
      expect(createdLotId).toBeTruthy();

      // 5. Repeat delivery of same lot (case-insensitive) with conflicting expDate is rejected
      await expect(
        postMovements(tx, [
          {
            type: 'RECEIPT',
            skuId: lotSkuId,
            locationId: loc1Id,
            quantityDelta: toQuantity('5'),
            unitCost: toUnitCost('6'),
            lotInput: { lotCode: 'lot-a', expDate: '2027-06-01' },
            actorId: 'actor-1',
            idempotencyKey: uuidv7(),
          },
        ]),
      ).rejects.toMatchObject({ statusCode: 422, code: ERROR_CODES.LOT_EXPIRY_MISMATCH });

      // 6. Repeat delivery of same lot with matching expDate and different cost: +20 @ 8.0000
      const secondReceipt = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId: lotSkuId,
          locationId: loc1Id,
          quantityDelta: toQuantity('20'),
          unitCost: toUnitCost('8'),
          lotInput: { lotCode: 'lot-a', expDate: '2027-01-01' },
          actorId: 'actor-1',
          idempotencyKey: uuidv7(),
        },
      ]);
      expect(secondReceipt.movements[0]?.lotId).toBe(createdLotId);
      expect(secondReceipt.movements[0]?.unitCost).toBe('8.0000');
      expect(secondReceipt.movements[0]?.wacUnitCost).toBe('7.0000');
      expect(secondReceipt.balances[0]?.onHand).toBe('30.0000');
      expect(secondReceipt.balances[0]?.weightedAverageCost).toBe('7.0000');

      const [lotRow] = await tx.select().from(stockLots).where(eq(stockLots.id, createdLotId));
      expect(lotRow?.lotCode).toBe('LOT-A');

      const [lotBal] = await tx
        .select()
        .from(stockLotBalances)
        .where(eq(stockLotBalances.lotId, createdLotId));
      expect(lotBal?.onHand).toBe('30.0000');
      expect(lotBal?.unitCost).toBe('7.0000');
    });

    // 7. Turning trackLots=true on sku1Id (which now has 5.0000 on hand) is blocked by inventory's positive-stock checker
    const patchPositive = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { trackLots: true },
    });
    expect(patchPositive.statusCode).toBe(422);
    expect(patchPositive.json().error.code).toBe(ERROR_CODES.SKU_HAS_POSITIVE_STOCK);
  });
});

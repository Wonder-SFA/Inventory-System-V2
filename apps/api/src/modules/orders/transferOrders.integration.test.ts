import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  ERROR_CODES,
  type StockBalance,
  type StockMovement,
  type TransferOrder,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';
import { postMovements } from '../inventory/public/index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('orders: transfer order lifecycle integration', () => {
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
    const emittedEvents: Array<{ eventType: string; aggregateId: string; payload: unknown }> = [];
    const outboxDispatcher = new OutboxDispatcher(db);
    outboxDispatcher.registerConsumer('test-transfer-orders-observer', async (event) => {
      emittedEvents.push({
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        payload: event.payload,
      });
    });

    const app = buildApp({ pool, db, outboxDispatcher, nodeEnv: 'test' });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Transfer Coordinator',
        email: 'transfer@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'PCS', name: 'Pieces' },
    });
    expect(uomRes.statusCode).toBe(201);
    const uomId = uomRes.json().data.id as string;

    const productRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Transfer Widget' },
    });
    expect(productRes.statusCode).toBe(201);
    const productId = productRes.json().data.id as string;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'TR-001',
        name: 'Transfer Widget Standard',
        unitOfMeasureId: uomId,
      },
    });
    expect(skuRes.statusCode).toBe(201);
    const skuId = skuRes.json().data.id as string;

    const locARes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Location A' },
    });
    expect(locARes.statusCode).toBe(201);
    const locationAId = locARes.json().data.id as string;

    const locBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Location B' },
    });
    expect(locBRes.statusCode).toBe(201);
    const locationBId = locBRes.json().data.id as string;

    const supplierRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Apex Supply' },
    });
    expect(supplierRes.statusCode).toBe(201);
    const supplierId = supplierRes.json().data.id as string;

    return {
      app,
      cookie,
      skuId,
      locationAId,
      locationBId,
      supplierId,
      outboxDispatcher,
      emittedEvents,
    };
  }

  async function receiveStockViaPo(
    app: ReturnType<typeof buildApp>,
    cookie: string,
    supplierId: string,
    locationId: string,
    skuId: string,
    qty: string,
    unitCost: string,
  ) {
    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId,
        lines: [{ skuId, orderedQty: qty, unitCost, currency: 'USD' }],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json().data;
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    const recRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: po.lines[0].id, quantity: qty }],
      },
    });
    expect(recRes.statusCode).toBe(201);
  }

  it('validates same-location rejection (422), Draft optimistic locking (409 STALE_VERSION), hard-delete protection, and pre-dispatch cancellation', async () => {
    const { app, cookie, skuId, locationAId, locationBId, outboxDispatcher, emittedEvents } =
      await setupFixture();

    // Reject same source & destination
    const sameLocRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationAId,
        lines: [{ skuId, orderedQty: '5.0000' }],
      },
    });
    expect(sameLocRes.statusCode).toBe(422);
    expect(sameLocRes.json().error.code).toBe(ERROR_CODES.SAME_SOURCE_AND_DESTINATION_LOCATION);

    // Create Draft
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        note: 'Initial draft',
        lines: [{ skuId, orderedQty: '5.0000' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().data as TransferOrder;
    expect(created.status).toBe('DRAFT');
    expect(created.version).toBe(1);

    // Hard-delete protection on SKU and Locations referenced by Transfer Order
    const delSkuRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delSkuRes.statusCode).toBe(409);
    expect(delSkuRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    const delLocRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${locationBId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delLocRes.statusCode).toBe(409);
    expect(delLocRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Optimistic locking on PATCH
    const patchOk = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transfer-orders/${created.id}`,
      headers: { cookie },
      payload: {
        expectedVersion: 1,
        note: 'Updated draft',
        lines: [{ skuId, orderedQty: '6.0000' }],
      },
    });
    expect(patchOk.statusCode).toBe(200);
    expect(patchOk.json().data.version).toBe(2);
    expect(patchOk.json().data.lines[0].orderedQty).toBe('6.0000');

    const patchStale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/transfer-orders/${created.id}`,
      headers: { cookie },
      payload: {
        expectedVersion: 1,
        note: 'Stale write',
      },
    });
    expect(patchStale.statusCode).toBe(409);
    expect(patchStale.json().error.code).toBe(ERROR_CODES.STALE_VERSION);

    // List & filter
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/transfer-orders?status=DRAFT&sourceLocationId=${locationAId}&destinationLocationId=${locationBId}`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().data).toHaveLength(1);

    // Confirm
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${created.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().data.status).toBe('CONFIRMED');

    // Pre-dispatch cancel succeeds from CONFIRMED
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${created.id}/cancel`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().data.status).toBe('CANCELLED');

    await outboxDispatcher.drainOutbox();
    const eventTypes = emittedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('OrderConfirmed');
    expect(eventTypes).toContain('OrderCancelled');
  });

  it('snapshots Location A WAC on dispatch so Location B receives at the exact snapshotted cost even after Location A WAC changes', async () => {
    const {
      app,
      cookie,
      skuId,
      locationAId,
      locationBId,
      supplierId,
      outboxDispatcher,
      emittedEvents,
    } = await setupFixture();

    // 1. Location A receives 10 units at $10.0000 -> WAC = $10.0000
    await receiveStockViaPo(app, cookie, supplierId, locationAId, skuId, '10.0000', '10.0000');

    // 2. Create & Confirm Transfer Order for 4 units from A -> B
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '4.0000' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const to = createRes.json().data as TransferOrder;

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);

    // 3. Dispatch Transfer Order
    const dispatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { note: 'Truck #42' },
    });
    expect(dispatchRes.statusCode).toBe(200);
    const dispatchedTo = dispatchRes.json().data as TransferOrder;
    expect(dispatchedTo.status).toBe('IN_TRANSIT');
    expect(dispatchedTo.lines[0]!.dispatchedQty).toBe('4.0000');
    expect(dispatchedTo.lines[0]!.dispatchUnitCost).toBe('10.0000');

    // Pre-dispatch cancel must fail when IN_TRANSIT
    const cancelInTransitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/cancel`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(cancelInTransitRes.statusCode).toBe(409);
    expect(cancelInTransitRes.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);

    // 4. Location A receives 6 more units at $20.0000 -> Location A WAC becomes $15.0000
    await receiveStockViaPo(app, cookie, supplierId, locationAId, skuId, '6.0000', '20.0000');

    const balARes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${locationAId}&skuId=${skuId}`,
      headers: { cookie },
    });
    const balA = balARes.json().data[0] as StockBalance;
    expect(balA.onHand).toBe('12.0000');
    expect(balA.weightedAverageCost).toBe('15.0000');

    // 5. Location B receives all 4 units
    const receiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: to.lines[0]!.id, quantity: '4.0000' }],
      },
    });
    expect(receiveRes.statusCode).toBe(201);
    const recResult = receiveRes.json().data as {
      transferOrderId: string;
      status: string;
      movements: StockMovement[];
    };
    expect(recResult.status).toBe('RECEIVED');
    expect(recResult.movements[0]!.type).toBe('TRANSFER_IN');
    expect(recResult.movements[0]!.unitCost).toBe('10.0000');

    // Assert Location B balance has exact snapshotted $10.0000 WAC and 0 In-Transit
    const balBRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${locationBId}&skuId=${skuId}`,
      headers: { cookie },
    });
    const balB = balBRes.json().data[0] as StockBalance;
    expect(balB.onHand).toBe('4.0000');
    expect(balB.inTransit).toBe('0.0000');
    expect(balB.weightedAverageCost).toBe('10.0000');

    await outboxDispatcher.drainOutbox();
    const eventTypes = emittedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('TransferDispatched');
    expect(eventTypes).toContain('TransferReceived');
  });

  it('emits negative-stock warnings on dispatch when source On-Hand <= 0, guards over-receive (422), and clears remaining In-Transit Stock on discrepancy close-out', async () => {
    const {
      app,
      cookie,
      skuId,
      locationAId,
      locationBId,
      outboxDispatcher,
      emittedEvents,
    } = await setupFixture();

    // Location A has 0 stock -> dispatch should succeed with negative-stock warning
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '5.0000' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const to = createRes.json().data as TransferOrder;

    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    const dispatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(dispatchRes.statusCode).toBe(200);
    expect(dispatchRes.json().warnings.length).toBeGreaterThan(0);

    // Partial receipt of 3 units -> PARTIALLY_RECEIVED
    const partialRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: to.lines[0]!.id, quantity: '3.0000' }],
      },
    });
    expect(partialRes.statusCode).toBe(201);
    expect(partialRes.json().data.status).toBe('PARTIALLY_RECEIVED');

    // Over-receive of 3 more (3 + 3 = 6 > 5) -> 422 OVER_RECEIVE_TRANSFER_NOT_ALLOWED
    const overRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: to.lines[0]!.id, quantity: '3.0000' }],
      },
    });
    expect(overRes.statusCode).toBe(422);
    expect(overRes.json().error.code).toBe(ERROR_CODES.OVER_RECEIVE_TRANSFER_NOT_ALLOWED);

    // Close discrepancy for the remaining 2 units
    const closeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/close-discrepancy`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        reason: 'LOST',
        note: '2 units lost in transit',
      },
    });
    expect(closeRes.statusCode).toBe(200);
    const closedTo = closeRes.json().data as TransferOrder;
    expect(closedTo.status).toBe('CLOSED_WITH_DISCREPANCY');
    expect(closedTo.discrepancyReason).toBe('LOST');
    expect(closedTo.discrepancyNote).toBe('2 units lost in transit');

    // Assert Location B In-Transit Stock is now 0.0000
    const balBRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${locationBId}&skuId=${skuId}`,
      headers: { cookie },
    });
    const balB = balBRes.json().data[0] as StockBalance;
    expect(balB.onHand).toBe('3.0000');
    expect(balB.inTransit).toBe('0.0000');

    await outboxDispatcher.drainOutbox();
    const eventTypes = emittedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('TransferDiscrepancyClosed');
  });

  it('supports multi-lot FEFO dispatch, exact dispatched cost preservation, partial & full multi-lot receipts with destination lot blending, and cost redaction', async () => {
    const { app, cookie, skuId, locationAId, locationBId } = await setupFixture();

    // Enable trackLots + trackExpiry on SKU
    const skuGet = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie },
    });
    const skuVersion = (skuGet.json() as { data: { version: number } }).data.version;
    const skuPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: skuVersion, trackLots: true, trackExpiry: true },
    });
    expect(skuPatch.statusCode).toBe(200);

    const db = createDb(pool);

    // Location B already holds 2 units of LOT-A @ 5.0000
    // Location A holds 4 units of LOT-A @ 10.0000 and 6 units of LOT-B @ 20.0000 (WAC = 16.0000)
    const { lotAId, lotBId } = await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationBId,
          lotInput: { lotCode: 'LOT-A', expDate: '2027-01-15' },
          quantityDelta: toQuantity('2.0000'),
          unitCost: toUnitCost('5.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
      ]);
      const srcRec = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-A', expDate: '2027-01-15' },
          quantityDelta: toQuantity('4.0000'),
          unitCost: toUnitCost('10.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-B', expDate: '2027-06-30' },
          quantityDelta: toQuantity('6.0000'),
          unitCost: toUnitCost('20.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
      ]);
      return {
        lotAId: srcRec.movements[0]!.lotId!,
        lotBId: srcRec.movements[1]!.lotId!,
      };
    });

    // Create & confirm Transfer Order for 7 units (Location A -> Location B)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '7.0000' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const to = createRes.json().data as TransferOrder;
    const lineId = to.lines[0]!.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    // Dispatch via AUTO_FEFO -> 4 LOT-A @ 10.0000 + 3 LOT-B @ 20.0000
    const dispatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(dispatchRes.statusCode).toBe(200);
    const dispatchedTo = dispatchRes.json().data as TransferOrder;
    const dispatchedLots = (dispatchedTo.lines[0] as unknown as {
      lots?: Array<{
        lotId: string | null;
        lotCode?: string | null;
        dispatchedQty: string;
        receivedQty: string;
        discrepancyQty: string;
        dispatchUnitCost?: string;
        dispatchWacUnitCost?: string;
      }>;
    }).lots;
    expect(dispatchedLots).toHaveLength(2);
    expect(dispatchedLots![0]!.lotId).toBe(lotAId);
    expect(dispatchedLots![0]!.lotCode).toBe('LOT-A');
    expect(dispatchedLots![0]!.dispatchedQty).toBe('4.0000');
    expect(dispatchedLots![0]!.dispatchUnitCost).toBe('10.0000');
    expect(dispatchedLots![0]!.dispatchWacUnitCost).toBe('16.0000');
    expect(dispatchedLots![1]!.lotId).toBe(lotBId);
    expect(dispatchedLots![1]!.lotCode).toBe('LOT-B');
    expect(dispatchedLots![1]!.dispatchedQty).toBe('3.0000');
    expect(dispatchedLots![1]!.dispatchUnitCost).toBe('20.0000');
    expect(dispatchedLots![1]!.dispatchWacUnitCost).toBe('16.0000');

    // Change Location A's LOT-B cost while in transit by receiving 3 more LOT-B @ 50.0000
    await db.transaction(async (tx) => {
      await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-B', expDate: '2027-06-30' },
          quantityDelta: toQuantity('3.0000'),
          unitCost: toUnitCost('50.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
      ]);
    });

    // Partial receipt 1: receive 4 LOT-A + 1 LOT-B
    const rec1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: lineId,
            quantity: '5.0000',
            lotAllocations: [
              { lotId: lotAId, quantity: '4.0000' },
              { lotId: lotBId, quantity: '1.0000' },
            ],
          },
        ],
      },
    });
    expect(rec1Res.statusCode).toBe(201);
    expect(rec1Res.json().data.status).toBe('PARTIALLY_RECEIVED');

    // Partial receipt 2: receive remaining 2 LOT-B (omitting lotAllocations -> auto-allocates remaining in-transit)
    const rec2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: lineId, quantity: '2.0000' }],
      },
    });
    expect(rec2Res.statusCode).toBe(201);
    expect(rec2Res.json().data.status).toBe('RECEIVED');

    // Verify Location B lot balances: LOT-A blended (2*5 + 4*10)/6 = 8.3333, LOT-B = 20.0000 (not 35.0000!)
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
      [skuId, locationBId],
    );
    expect(dstLots.find((r) => r.lot_code === 'LOT-A')).toEqual({
      lot_code: 'LOT-A',
      on_hand: '6.0000',
      in_transit: '0.0000',
      unit_cost: '8.3333',
    });
    expect(dstLots.find((r) => r.lot_code === 'LOT-B')).toEqual({
      lot_code: 'LOT-B',
      on_hand: '3.0000',
      in_transit: '0.0000',
      unit_cost: '20.0000',
    });
  });

  it('closes short-received multi-lot Transfer Order discrepancies defaulting to latest-expiring lot or using explicit per-lot attribution', async () => {
    const { app, cookie, skuId, locationAId, locationBId } = await setupFixture();

    const skuGet = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie },
    });
    const skuVersion = (skuGet.json() as { data: { version: number } }).data.version;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: skuVersion, trackLots: true, trackExpiry: true },
    });

    const db = createDb(pool);
    const { earlyLotId, lateLotId } = await db.transaction(async (tx) => {
      const rec = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-EARLY', expDate: '2027-02-01' },
          quantityDelta: toQuantity('5.0000'),
          unitCost: toUnitCost('10.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-LATE', expDate: '2027-09-01' },
          quantityDelta: toQuantity('5.0000'),
          unitCost: toUnitCost('12.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
      ]);
      return {
        earlyLotId: rec.movements[0]!.lotId!,
        lateLotId: rec.movements[1]!.lotId!,
      };
    });

    // TO 1: 5 LOT-EARLY + 3 LOT-LATE = 8; receive 4 total (auto FEFO -> 4 LOT-EARLY), close discrepancy unspecified -> attributes 3 to LOT-LATE first, then 1 to LOT-EARLY
    const to1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '8.0000' }],
      },
    });
    const to1 = to1Res.json().data as TransferOrder;
    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to1.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to1.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to1.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { lines: [{ orderLineId: to1.lines[0]!.id, quantity: '4.0000' }] },
    });
    const close1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to1.id}/close-discrepancy`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { reason: 'DAMAGED', note: '4 units damaged in transit' },
    });
    expect(close1Res.statusCode).toBe(200);
    const closed1 = close1Res.json().data as TransferOrder & {
      lines: Array<{
        lots?: Array<{ lotId: string | null; discrepancyQty: string }>;
      }>;
    };
    const earlyLineLot1 = closed1.lines[0]!.lots!.find((l) => l.lotId === earlyLotId);
    const lateLineLot1 = closed1.lines[0]!.lots!.find((l) => l.lotId === lateLotId);
    expect(earlyLineLot1?.discrepancyQty).toBe('1.0000');
    expect(lateLineLot1?.discrepancyQty).toBe('3.0000');

    // TO 2: 0 LOT-EARLY + 2 LOT-LATE = 2; receive 0; close discrepancy explicitly attributing 2 to LOT-LATE
    const to2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '2.0000' }],
      },
    });
    const to2 = to2Res.json().data as TransferOrder;
    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to2.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to2.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    const close2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to2.id}/close-discrepancy`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        reason: 'LOST',
        note: '1 early + 1 late lost',
        lines: [
          {
            orderLineId: to2.lines[0]!.id,
            lotAllocations: [{ lotId: lateLotId, quantity: '2.0000' }],
          },
        ],
      },
    });
    expect(close2Res.statusCode).toBe(200);
    const closed2 = close2Res.json().data as TransferOrder & {
      lines: Array<{
        lots?: Array<{ lotId: string | null; discrepancyQty: string }>;
      }>;
    };
    expect(closed2.lines[0]!.lots!.find((l) => l.lotId === lateLotId)?.discrepancyQty).toBe(
      '2.0000',
    );

    // All in_transit cleared at Location B
    const { rows: dstBals } = await pool.query<{ in_transit: string }>(
      `SELECT in_transit FROM inventory.stock_lot_balances WHERE location_id = $1`,
      [locationBId],
    );
    for (const row of dstBals) {
      expect(row.in_transit).toBe('0.0000');
    }
  });

  it('supports manual lotAllocations on Transfer Order dispatch when policy permits', async () => {
    const { app, cookie, skuId, locationAId, locationBId } = await setupFixture();

    const skuGet = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie },
    });
    const skuVersion = (skuGet.json() as { data: { version: number } }).data.version;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: skuVersion, trackLots: true, trackExpiry: true },
    });

    const db = createDb(pool);
    const { lateLotId } = await db.transaction(async (tx) => {
      const rec = await postMovements(tx, [
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-E', expDate: '2027-02-01' },
          quantityDelta: toQuantity('5.0000'),
          unitCost: toUnitCost('10.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
        {
          type: 'RECEIPT',
          skuId,
          locationId: locationAId,
          lotInput: { lotCode: 'LOT-L', expDate: '2027-09-01' },
          quantityDelta: toQuantity('5.0000'),
          unitCost: toUnitCost('15.0000'),
          actorId: 'test-actor',
          idempotencyKey: uuidv7(),
        },
      ]);
      return { lateLotId: rec.movements[1]!.lotId! };
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/transfer-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        sourceLocationId: locationAId,
        destinationLocationId: locationBId,
        lines: [{ skuId, orderedQty: '3.0000' }],
      },
    });
    const to = createRes.json().data as TransferOrder;

    await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    // Manually pick LOT-L instead of FEFO LOT-E
    const dispatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/transfer-orders/${to.id}/dispatch`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: to.lines[0]!.id,
            lotAllocations: [{ lotId: lateLotId, quantity: '3.0000' }],
          },
        ],
      },
    });
    expect(dispatchRes.statusCode).toBe(200);
    const dispatched = dispatchRes.json().data as TransferOrder;
    expect(dispatched.lines[0]!.lots).toHaveLength(1);
    expect(dispatched.lines[0]!.lots![0]!.lotId).toBe(lateLotId);
    expect(dispatched.lines[0]!.lots![0]!.dispatchedQty).toBe('3.0000');
    expect(dispatched.lines[0]!.lots![0]!.dispatchUnitCost).toBe('15.0000');
  });
});

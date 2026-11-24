import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  ERROR_CODES,
  type StockBalance,
  type StockMovement,
  type TransferOrder,
  uuidv7,
} from '@iv2/shared-domain';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';

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
});

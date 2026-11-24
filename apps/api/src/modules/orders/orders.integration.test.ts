import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  ERROR_CODES,
  type PurchaseOrder,
  type StockBalance,
  type StockMovement,
  type Supplier,
  WARNING_CODES,
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

describe('orders: suppliers & purchase order lifecycle integration', () => {
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
    outboxDispatcher.registerConsumer('test-orders-observer', async (event) => {
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
        name: 'Purchasing Clerk',
        email: 'purchasing@example.com',
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
      payload: { name: 'Steel Bolt' },
    });
    expect(productRes.statusCode).toBe(201);
    const productId = productRes.json().data.id as string;

    const sku1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        unitOfMeasureId: uomId,
        code: 'BOLT-M8',
        name: 'Steel Bolt M8',
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
        code: 'BOLT-M10',
        name: 'Steel Bolt M10',
      },
    });
    expect(sku2Res.statusCode).toBe(201);
    const sku2Id = sku2Res.json().data.id as string;

    const loc1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Warehouse' },
    });
    expect(loc1Res.statusCode).toBe(201);
    const location1Id = loc1Res.json().data.id as string;

    const loc2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Downtown Store' },
    });
    expect(loc2Res.statusCode).toBe(201);
    const location2Id = loc2Res.json().data.id as string;

    return {
      app,
      db,
      outboxDispatcher,
      emittedEvents,
      cookie,
      sku1Id,
      sku2Id,
      location1Id,
      location2Id,
    };
  }

  it('supports Supplier CRUD, archive/unarchive, cursor pagination, and hard-delete protection', async () => {
    const { app, cookie, sku1Id, location1Id } = await setupFixture();

    const s1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        name: 'Acme Metals',
        email: 'orders@acmemetals.test',
        phone: '+1-555-0100',
        address: '100 Foundry Way',
      },
    });
    expect(s1Res.statusCode).toBe(201);
    const supplier1 = s1Res.json().data as Supplier;
    expect(supplier1.status).toBe('ACTIVE');

    const s2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Beacon Fasteners' },
    });
    expect(s2Res.statusCode).toBe(201);
    const supplier2 = s2Res.json().data as Supplier;

    // Update supplier 1
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/suppliers/${supplier1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { phone: '+1-555-0199' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect((patchRes.json().data as Supplier).phone).toBe('+1-555-0199');

    // Archive & unarchive supplier 2
    const archiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/suppliers/${supplier2.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect((archiveRes.json().data as Supplier).status).toBe('ARCHIVED');

    const activeListRes = await app.inject({
      method: 'GET',
      url: '/api/v1/suppliers?status=ACTIVE&limit=1',
      headers: { cookie },
    });
    expect(activeListRes.statusCode).toBe(200);
    expect(activeListRes.json().data).toHaveLength(1);
    expect(activeListRes.json().data[0].id).toBe(supplier1.id);

    const unarchiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/suppliers/${supplier2.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchiveRes.statusCode).toBe(200);
    expect((unarchiveRes.json().data as Supplier).status).toBe('ACTIVE');

    // Create a PO referencing supplier1, location1, and sku1
    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId: supplier1.id,
        locationId: location1Id,
        lines: [{ skuId: sku1Id, orderedQty: '5.0000', unitCost: '2.0000', currency: 'USD' }],
      },
    });
    expect(poRes.statusCode).toBe(201);

    // Referenced supplier, SKU, and Location cannot be hard-deleted
    const delSupplier1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/suppliers/${supplier1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delSupplier1.statusCode).toBe(409);
    expect(delSupplier1.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    const delSku1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delSku1.statusCode).toBe(409);
    expect(delSku1.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    const delLoc1 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${location1Id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delLoc1.statusCode).toBe(409);
    expect(delLoc1.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Unreferenced supplier2 can be hard-deleted
    const delSupplier2 = await app.inject({
      method: 'DELETE',
      url: `/api/v1/suppliers/${supplier2.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delSupplier2.statusCode).toBe(200);
  });

  it('enforces optimistic locking (409 STALE_VERSION) on Draft edits and state transitions', async () => {
    const { app, cookie, sku1Id, sku2Id, location1Id } = await setupFixture();

    const sRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Acme Metals' },
    });
    const supplierId = sRes.json().data.id as string;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId: location1Id,
        note: 'Initial draft',
        lines: [{ skuId: sku1Id, orderedQty: '10.0000', unitCost: '5.0000', currency: 'USD' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const po = createRes.json().data as PurchaseOrder;
    expect(po.status).toBe('DRAFT');
    expect(po.version).toBe(1);
    expect(po.lines).toHaveLength(1);

    // Office PC 1 updates draft with expectedVersion = 1 -> version becomes 2
    const update1Res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${po.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        expectedVersion: 1,
        note: 'Updated by PC 1',
        lines: [
          { skuId: sku1Id, orderedQty: '12.0000', unitCost: '5.0000', currency: 'USD' },
          { skuId: sku2Id, orderedQty: '4.0000', unitCost: '8.0000', currency: 'USD' },
        ],
      },
    });
    expect(update1Res.statusCode).toBe(200);
    const updatedPo = update1Res.json().data as PurchaseOrder;
    expect(updatedPo.version).toBe(2);
    expect(updatedPo.lines).toHaveLength(2);

    // Office PC 2 attempts stale edit with expectedVersion = 1 -> 409 STALE_VERSION
    const staleRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${po.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        expectedVersion: 1,
        note: 'Stale overwrite from PC 2',
      },
    });
    expect(staleRes.statusCode).toBe(409);
    expect(staleRes.json().error.code).toBe(ERROR_CODES.STALE_VERSION);

    // Cannot receive a DRAFT order
    const draftReceiptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: updatedPo.lines[0]!.id, quantity: '1.0000' }],
      },
    });
    expect(draftReceiptRes.statusCode).toBe(409);
    expect(draftReceiptRes.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);

    // Confirm PO
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect((confirmRes.json().data as PurchaseOrder).status).toBe('CONFIRMED');

    // Cannot PATCH a CONFIRMED PO
    const patchConfirmedRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/purchase-orders/${po.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { expectedVersion: 2, note: 'Too late' },
    });
    expect(patchConfirmedRes.statusCode).toBe(409);
    expect(patchConfirmedRes.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);

    // Cannot confirm twice
    const confirmAgainRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmAgainRes.statusCode).toBe(409);
    expect(confirmAgainRes.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);
  });

  it('handles multi-line receipt idempotency replay/conflict, over-receive guardrail, and per-Location WAC', async () => {
    const { app, outboxDispatcher, emittedEvents, cookie, sku1Id, sku2Id, location1Id, location2Id } =
      await setupFixture();

    const sRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Global Supply Co' },
    });
    const supplierId = sRes.json().data.id as string;

    // Create & confirm PO at Location 1 with 2 lines
    const createPoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId: location1Id,
        lines: [
          { skuId: sku1Id, orderedQty: '10.0000', unitCost: '4.0000', currency: 'USD' },
          { skuId: sku2Id, orderedQty: '5.0000', unitCost: '10.0000', currency: 'USD' },
        ],
      },
    });
    expect(createPoRes.statusCode).toBe(201);
    const po = createPoRes.json().data as PurchaseOrder;
    const line1 = po.lines.find((l) => l.skuId === sku1Id)!;
    const line2 = po.lines.find((l) => l.skuId === sku2Id)!;

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    await outboxDispatcher.drainOutbox();
    expect(emittedEvents.some((e) => e.eventType === 'OrderConfirmed' && e.aggregateId === po.id)).toBe(
      true,
    );

    // Partial receipt on both lines with Idempotency-Key
    const receiptKey = uuidv7();
    const receiptPayload = {
      note: 'First partial delivery',
      lines: [
        { orderLineId: line1.id, quantity: '6.0000', unitCost: '4.0000', currency: 'USD' },
        { orderLineId: line2.id, quantity: '5.0000', unitCost: '10.0000', currency: 'USD' },
      ],
    };

    const receipt1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': receiptKey },
      payload: receiptPayload,
    });
    expect(receipt1Res.statusCode).toBe(201);
    expect(receipt1Res.json().data.status).toBe('PARTIALLY_RECEIVED');
    const movements1 = receipt1Res.json().data.movements as StockMovement[];
    expect(movements1).toHaveLength(2);
    expect(movements1[0]!.type).toBe('RECEIPT');

    // Replay same Idempotency-Key + same payload -> identical response, no extra movements
    const replayRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': receiptKey },
      payload: receiptPayload,
    });
    expect(replayRes.statusCode).toBe(201);
    expect(replayRes.json().data).toEqual(receipt1Res.json().data);

    // Reuse same Idempotency-Key with different payload -> 409 IDEMPOTENCY_KEY_CONFLICT
    const conflictRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': receiptKey },
      payload: {
        lines: [{ orderLineId: line1.id, quantity: '1.0000' }],
      },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.json().error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);

    // Attempt over-receive on line1 (6 + 6 = 12 > 10) without allowOverReceive -> 422
    const overReceiveBlockedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: line1.id, quantity: '6.0000', unitCost: '6.0000', currency: 'USD' }],
      },
    });
    expect(overReceiveBlockedRes.statusCode).toBe(422);
    expect(overReceiveBlockedRes.json().error.code).toBe(
      ERROR_CODES.OVER_RECEIVE_CONFIRMATION_REQUIRED,
    );

    // Retry with allowOverReceive: true -> 201 + PURCHASE_ORDER_OVER_RECEIVED warning + RECEIVED
    const overReceiveAllowedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        allowOverReceive: true,
        lines: [{ orderLineId: line1.id, quantity: '6.0000', unitCost: '6.0000', currency: 'USD' }],
      },
    });
    expect(overReceiveAllowedRes.statusCode).toBe(201);
    expect(overReceiveAllowedRes.json().data.status).toBe('RECEIVED');
    expect(overReceiveAllowedRes.json().warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: WARNING_CODES.PURCHASE_ORDER_OVER_RECEIVED,
          orderLineId: line1.id,
        }),
      ]),
    );

    await outboxDispatcher.drainOutbox();
    expect(
      emittedEvents.some((e) => e.eventType === 'PurchaseOrderReceived' && e.aggregateId === po.id),
    ).toBe(true);

    // Verify per-Location WAC for sku1 at Location 1: (6 * 4 + 6 * 6) / 12 = 60 / 12 = 5.0000
    // Also receive sku1 at Location 2 at unitCost 9.0000 to verify per-Location WAC isolation
    const po2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId: location2Id,
        lines: [{ skuId: sku1Id, orderedQty: '4.0000', unitCost: '9.0000', currency: 'USD' }],
      },
    });
    const po2 = po2Res.json().data as PurchaseOrder;
    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po2.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po2.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: po2.lines[0]!.id, quantity: '4.0000', unitCost: '9.0000' }],
      },
    });

    const balancesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${sku1Id}`,
      headers: { cookie },
    });
    expect(balancesRes.statusCode).toBe(200);
    const balances = balancesRes.json().data as StockBalance[];
    const loc1Bal = balances.find((b) => b.locationId === location1Id)!;
    const loc2Bal = balances.find((b) => b.locationId === location2Id)!;
    expect(loc1Bal.onHand).toBe('12.0000');
    expect(loc1Bal.weightedAverageCost).toBe('5.0000');
    expect(loc2Bal.onHand).toBe('4.0000');
    expect(loc2Bal.weightedAverageCost).toBe('9.0000');
  });

  it('resets WAC on recovery from negative stock and preserves receipts on cancellation after partial receipt', async () => {
    const { app, cookie, sku1Id, location1Id } = await setupFixture();

    const sRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Recovery Supplier' },
    });
    const supplierId = sRes.json().data.id as string;

    // Push sku1 at location1 negative (-5.0000) via adjustment
    const adjRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId: sku1Id,
        locationId: location1Id,
        quantityDelta: '-5.0000',
        reasonCategory: 'STOCK_COUNT',
      },
    });
    expect(adjRes.statusCode).toBe(201);

    // Create & confirm PO for 15.0000 at unitCost 20.0000
    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId: location1Id,
        lines: [{ skuId: sku1Id, orderedQty: '15.0000', unitCost: '20.0000', currency: 'USD' }],
      },
    });
    const po = poRes.json().data as PurchaseOrder;
    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    // Receive 9.0000 (recovers from -5 to +4 -> WAC resets to 20.0000, PO is PARTIALLY_RECEIVED)
    const partialRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: po.lines[0]!.id, quantity: '9.0000', unitCost: '20.0000' }],
      },
    });
    expect(partialRes.statusCode).toBe(201);
    expect(partialRes.json().data.status).toBe('PARTIALLY_RECEIVED');

    // Cancel PO after partial receipt
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/cancel`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect((cancelRes.json().data as PurchaseOrder).status).toBe('CANCELLED');

    // Verify On-Hand Stock = 4.0000 and WAC reset to 20.0000 (not estimated)
    const balRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${sku1Id}&locationId=${location1Id}`,
      headers: { cookie },
    });
    const bal = (balRes.json().data as StockBalance[])[0]!;
    expect(bal.onHand).toBe('4.0000');
    expect(bal.weightedAverageCost).toBe('20.0000');
    expect(bal.valuationStatus).toBe('NORMAL');

    // Subsequent receipt on CANCELLED PO fails with 409 INVALID_ORDER_STATE
    const postCancelReceipt = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: po.lines[0]!.id, quantity: '1.0000' }],
      },
    });
    expect(postCancelReceipt.statusCode).toBe(409);
    expect(postCancelReceipt.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);
  });

  it('captures lotCode/mfgDate/expDate on PO receipts for lot-tracked SKUs, rejects missing/conflicting expiry, and blends repeat-delivery costs', async () => {
    const { app, cookie, sku1Id, location1Id } = await setupFixture();

    const baseSkuRes = await app.inject({
      method: 'GET',
      url: `/api/v1/skus/${sku1Id}`,
      headers: { cookie },
    });
    const baseSku = baseSkuRes.json().data;

    const lotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: baseSku.productId,
        unitOfMeasureId: baseSku.unitOfMeasureId,
        code: 'LOT-PO-SKU',
        name: 'Lot PO Item',
        trackLots: true,
        trackExpiry: true,
      },
    });
    expect(lotSkuRes.statusCode).toBe(201);
    const lotSkuId = lotSkuRes.json().data.id as string;

    const supRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Batch Supplier' },
    });
    const supplierId = supRes.json().data.id as string;

    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId: location1Id,
        lines: [
          { skuId: sku1Id, orderedQty: '5.0000', unitCost: '4.0000', currency: 'USD' },
          { skuId: lotSkuId, orderedQty: '10.0000', unitCost: '10.0000', currency: 'USD' },
        ],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json().data as PurchaseOrder;
    const nonLotLine = po.lines.find((l) => l.skuId === sku1Id)!;
    const lotLine = po.lines.find((l) => l.skuId === lotSkuId)!;

    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    // Missing lotCode on lot-tracked SKU -> 422
    const missingLotRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { lines: [{ orderLineId: lotLine.id, quantity: '6.0000' }] },
    });
    expect(missingLotRes.statusCode).toBe(422);
    expect(missingLotRes.json().error.code).toBe(ERROR_CODES.LOT_CODE_REQUIRED);

    // Missing expDate on expiry-tracked SKU -> 422
    const missingExpRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { lines: [{ orderLineId: lotLine.id, quantity: '6.0000', lotCode: 'PO-LOT-1' }] },
    });
    expect(missingExpRes.statusCode).toBe(422);
    expect(missingExpRes.json().error.code).toBe(ERROR_CODES.EXPIRY_DATE_REQUIRED);

    // Receive non-lot line (no lot fields) + partial lot-tracked line (6 @ 10.0000)
    const rec1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          { orderLineId: nonLotLine.id, quantity: '5.0000' },
          {
            orderLineId: lotLine.id,
            quantity: '6.0000',
            unitCost: '10.0000',
            lotCode: 'PO-LOT-1',
            mfgDate: '2026-01-15',
            expDate: '2027-01-15',
          },
        ],
      },
    });
    expect(rec1Res.statusCode).toBe(201);
    const rec1Movements = rec1Res.json().data.movements;
    const nonLotMov = rec1Movements.find((m: { skuId: string }) => m.skuId === sku1Id);
    const lotMov1 = rec1Movements.find((m: { skuId: string }) => m.skuId === lotSkuId);
    expect(nonLotMov.lotId).toBeNull();
    expect(nonLotMov.unitCost).toBe('4.0000');
    expect(nonLotMov.wacUnitCost).toBe('4.0000');
    expect(lotMov1.lotCode).toBe('PO-LOT-1');
    expect(lotMov1.unitCost).toBe('10.0000');
    expect(lotMov1.wacUnitCost).toBe('10.0000');

    // Repeat delivery with conflicting expDate -> 422
    const conflictExpRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: lotLine.id,
            quantity: '4.0000',
            unitCost: '15.0000',
            lotCode: 'po-lot-1',
            expDate: '2028-01-15',
          },
        ],
      },
    });
    expect(conflictExpRes.statusCode).toBe(422);
    expect(conflictExpRes.json().error.code).toBe(ERROR_CODES.LOT_EXPIRY_MISMATCH);

    // Repeat delivery with matching expDate and different unitCost (4 @ 15.0000) -> blended WAC = 12.0000
    const rec2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: lotLine.id,
            quantity: '4.0000',
            unitCost: '15.0000',
            lotCode: 'po-lot-1',
            expDate: '2027-01-15',
          },
        ],
      },
    });
    expect(rec2Res.statusCode).toBe(201);
    const lotMov2 = rec2Res.json().data.movements[0];
    expect(lotMov2.lotId).toBe(lotMov1.lotId);
    expect(lotMov2.unitCost).toBe('15.0000');
    expect(lotMov2.wacUnitCost).toBe('12.0000');
  });
});

import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  type Customer,
  ERROR_CODES,
  type SalesOrder,
  type StockBalance,
  type StockMovement,
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

describe('orders: customers & sales order lifecycle integration', () => {
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
    outboxDispatcher.registerConsumer('test-sales-orders-observer', async (event) => {
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
        name: 'Sales Clerk',
        email: 'sales@example.com',
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
      payload: { name: 'Widget Pro' },
    });
    expect(productRes.statusCode).toBe(201);
    const productId = productRes.json().data.id as string;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'WGT-001',
        name: 'Widget Pro Standard',
        unitOfMeasureId: uomId,
      },
    });
    expect(skuRes.statusCode).toBe(201);
    const skuId = skuRes.json().data.id as string;

    const locRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Warehouse', type: 'WAREHOUSE' },
    });
    expect(locRes.statusCode).toBe(201);
    const locationId = locRes.json().data.id as string;

    const custRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        name: 'Acme Retail Co.',
        email: 'buyer@acmeretail.example',
        phone: '+1-555-0200',
        address: '456 Commerce Ave',
      },
    });
    expect(custRes.statusCode).toBe(201);
    const customer = custRes.json().data as Customer;

    return {
      app,
      cookie,
      skuId,
      locationId,
      customer,
      outboxDispatcher,
      emittedEvents,
    };
  }

  async function seedStock(
    app: ReturnType<typeof buildApp>,
    cookie: string,
    skuId: string,
    locationId: string,
    quantityDelta: string,
    unitCost: string,
  ) {
    const adjRes = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-movements/adjustments',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        skuId,
        locationId,
        quantityDelta,
        reasonCategory: 'STOCK_COUNT',
        unitCost,
        currency: 'USD',
      },
    });
    expect(adjRes.statusCode).toBe(201);
  }

  it('supports Customer CRUD, archive/unarchive, cursor pagination, and hard-delete protection', async () => {
    const { app, cookie, skuId, locationId, customer } = await setupFixture();

    const create2 = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Beta Wholesale' },
    });
    expect(create2.statusCode).toBe(201);
    const customer2 = create2.json().data as Customer;

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/customers?limit=1&status=ACTIVE',
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data).toHaveLength(1);
    expect(page1.json().page.hasMore).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/customers?limit=1&status=ACTIVE&cursor=${page1.json().page.nextCursor}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().data[0].id).not.toBe(page1.json().data[0].id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${customer.id}`,
      headers: { cookie },
      payload: { name: 'Acme Retail Updated', phone: '+1-555-9999' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.name).toBe('Acme Retail Updated');

    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customer2.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archRes.statusCode).toBe(200);
    expect(archRes.json().data.status).toBe('ARCHIVED');

    const unarchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customer2.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchRes.statusCode).toBe(200);
    expect(unarchRes.json().data.status).toBe('ACTIVE');

    // Create a Sales Order referencing customer
    const soRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId: customer.id,
        locationId,
        lines: [{ skuId, orderedQty: '2', unitPrice: '25.00', currency: 'USD' }],
      },
    });
    expect(soRes.statusCode).toBe(201);

    // Deleting referenced customer returns 409 RESOURCE_IN_USE
    const delRefRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${customer.id}`,
      headers: { cookie },
    });
    expect(delRefRes.statusCode).toBe(409);
    expect(delRefRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Deleting referenced SKU / Location returns 409 RESOURCE_IN_USE
    const delSkuRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skus/${skuId}`,
      headers: { cookie },
    });
    expect(delSkuRes.statusCode).toBe(409);
    expect(delSkuRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    const delLocRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${locationId}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delLocRes.statusCode).toBe(409);
    expect(delLocRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Deleting unreferenced customer2 succeeds
    const delOkRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/customers/${customer2.id}`,
      headers: { cookie },
    });
    expect(delOkRes.statusCode).toBe(200);
    expect(delOkRes.json().data.deleted).toBe(true);
  });

  it('enforces Draft optimistic locking (409 STALE_VERSION), reserves stock on confirm with negative Available Stock warning, and handles partial/full shipments with WAC & 422 OVER_SHIP_NOT_ALLOWED', async () => {
    const { app, cookie, skuId, locationId, customer, outboxDispatcher, emittedEvents } =
      await setupFixture();

    // Seed 5 units at WAC = 10.0000
    await seedStock(app, cookie, skuId, locationId, '5', '10.0000');

    // Create Draft SO for 8 units (will push Available Stock to -3.0000 on confirm!)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        orderNumber: 'SO-1001',
        customerId: customer.id,
        locationId,
        note: 'Urgent order',
        lines: [{ skuId, orderedQty: '6', unitPrice: '20.00', currency: 'USD' }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const draft = createRes.json().data as SalesOrder;
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(1);

    // Edit Draft with correct expectedVersion: 1 -> increments to 2
    const patchOk = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sales-orders/${draft.id}`,
      headers: { cookie },
      payload: {
        expectedVersion: 1,
        note: 'Updated to 8 units',
        lines: [{ skuId, orderedQty: '8', unitPrice: '22.50', currency: 'USD' }],
      },
    });
    expect(patchOk.statusCode).toBe(200);
    const updatedDraft = patchOk.json().data as SalesOrder;
    expect(updatedDraft.version).toBe(2);
    expect(updatedDraft.lines[0]!.orderedQty).toBe('8.0000');

    // Edit Draft with stale expectedVersion: 1 -> 409 STALE_VERSION
    const patchStale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sales-orders/${draft.id}`,
      headers: { cookie },
      payload: {
        expectedVersion: 1,
        note: 'Should fail',
      },
    });
    expect(patchStale.statusCode).toBe(409);
    expect(patchStale.json().error.code).toBe(ERROR_CODES.STALE_VERSION);

    // Confirm SO -> reserves 8 units, Available Stock becomes 5 - 8 = -3 (non-blocking warning)
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${draft.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    const confirmed = confirmRes.json().data as SalesOrder;
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmRes.json().warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ZERO_OR_NEGATIVE_AVAILABLE_STOCK',
          skuId,
          locationId,
        }),
      ]),
    );

    const lineId = confirmed.lines[0]!.id;

    // Verify stock balance after confirm: onHand=5, reserved=8, available=-3
    const balAfterConfirmRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const balAfterConfirm = balAfterConfirmRes.json().data[0] as StockBalance;
    expect(balAfterConfirm.onHand).toBe('5.0000');
    expect(balAfterConfirm.reserved).toBe('8.0000');
    expect(balAfterConfirm.available).toBe('-3.0000');

    // Partial shipment of 3 units
    const shipKey1 = uuidv7();
    const ship1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${draft.id}/shipments`,
      headers: { cookie, 'idempotency-key': shipKey1 },
      payload: {
        note: 'First batch',
        lines: [{ orderLineId: lineId, quantity: '3' }],
      },
    });
    expect(ship1Res.statusCode).toBe(201);
    expect(ship1Res.json().data.status).toBe('PARTIALLY_SHIPPED');
    const ship1Movements = ship1Res.json().data.movements as StockMovement[];
    expect(ship1Movements).toHaveLength(1);
    expect(ship1Movements[0]!.type).toBe('ISSUE');
    expect(ship1Movements[0]!.quantityDelta).toBe('-3.0000');
    expect(ship1Movements[0]!.unitCost).toBe('10.0000'); // WAC captured!

    // Idempotency replay on shipment
    const ship1Replay = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${draft.id}/shipments`,
      headers: { cookie, 'idempotency-key': shipKey1 },
      payload: {
        note: 'First batch',
        lines: [{ orderLineId: lineId, quantity: '3' }],
      },
    });
    expect(ship1Replay.statusCode).toBe(201);
    expect(ship1Replay.json().data.movements[0].id).toBe(ship1Movements[0]!.id);

    // Over-ship attempt (3 fulfilled + 6 = 9 > 8 ordered) -> 422 OVER_SHIP_NOT_ALLOWED
    const overShipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${draft.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: lineId, quantity: '6' }],
      },
    });
    expect(overShipRes.statusCode).toBe(422);
    expect(overShipRes.json().error.code).toBe(ERROR_CODES.OVER_SHIP_NOT_ALLOWED);

    // Ship remaining 5 units -> transitions to SHIPPED
    const ship2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${draft.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: lineId, quantity: '5' }],
      },
    });
    expect(ship2Res.statusCode).toBe(201);
    expect(ship2Res.json().data.status).toBe('SHIPPED');

    // Verify stock balance: onHand = 5 - 8 = -3, reserved = 0, available = -3
    const balAfterShipRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const balAfterShip = balAfterShipRes.json().data[0] as StockBalance;
    expect(balAfterShip.onHand).toBe('-3.0000');
    expect(balAfterShip.reserved).toBe('0.0000');
    expect(balAfterShip.available).toBe('-3.0000');

    await outboxDispatcher.drainOutbox();
    const eventTypes = emittedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('OrderConfirmed');
    expect(eventTypes).toContain('StockReserved');
    expect(eventTypes).toContain('StockReservationReleased');
    expect(eventTypes).toContain('StockIssued');
    expect(eventTypes).toContain('SalesOrderShipped');
  });

  it('supports Delivered transition and Customer Returns (CUSTOMER_RETURN receipt + over-return guard)', async () => {
    const { app, cookie, skuId, locationId, customer, outboxDispatcher, emittedEvents } =
      await setupFixture();

    await seedStock(app, cookie, skuId, locationId, '10', '12.0000');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId: customer.id,
        locationId,
        lines: [{ skuId, orderedQty: '4', unitPrice: '30.00', currency: 'USD' }],
      },
    });
    const so = createRes.json().data as SalesOrder;
    const lineId = so.lines[0]!.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { lines: [{ orderLineId: lineId, quantity: '4' }] },
    });

    // Deliver
    const deliverRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/deliver`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(deliverRes.statusCode).toBe(200);
    expect(deliverRes.json().data.status).toBe('DELIVERED');

    // Cannot cancel DELIVERED order
    const cancelDeliveredRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/cancel`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(cancelDeliveredRes.statusCode).toBe(409);
    expect(cancelDeliveredRes.json().error.code).toBe(ERROR_CODES.INVALID_ORDER_STATE);

    // Return 2 units
    const returnRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/returns`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        note: 'Damaged packaging',
        lines: [{ orderLineId: lineId, quantity: '2' }],
      },
    });
    expect(returnRes.statusCode).toBe(201);
    const retMovements = returnRes.json().data.movements as StockMovement[];
    expect(retMovements).toHaveLength(1);
    expect(retMovements[0]!.type).toBe('RECEIPT');
    expect(retMovements[0]!.quantityDelta).toBe('2.0000');
    expect(retMovements[0]!.reasonCategory).toBe('CUSTOMER_RETURN');

    // Over-return (2 + 3 = 5 > 4 fulfilled) -> 422 OVER_RETURN_NOT_ALLOWED
    const overReturnRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/returns`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: lineId, quantity: '3' }],
      },
    });
    expect(overReturnRes.statusCode).toBe(422);
    expect(overReturnRes.json().error.code).toBe(ERROR_CODES.OVER_RETURN_NOT_ALLOWED);

    // Stock balance: 10 - 4 + 2 = 8 onHand, 0 reserved, 8 available
    const balRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const bal = balRes.json().data[0] as StockBalance;
    expect(bal.onHand).toBe('8.0000');
    expect(bal.reserved).toBe('0.0000');
    expect(bal.available).toBe('8.0000');

    // Verify returnedQty persisted on Sales Order
    const getSoRes = await app.inject({
      method: 'GET',
      url: `/api/v1/sales-orders/${so.id}`,
      headers: { cookie },
    });
    expect(getSoRes.json().data.lines[0].returnedQty).toBe('2.0000');

    await outboxDispatcher.drainOutbox();
    const eventTypes = emittedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('SalesOrderDelivered');
    expect(eventTypes).toContain('SalesOrderReturned');
  });

  it('releases remaining Reserved Stock when cancelling a Partially Shipped Sales Order while preserving shipped ISSUE movements', async () => {
    const { app, cookie, skuId, locationId, customer, outboxDispatcher, emittedEvents } =
      await setupFixture();

    await seedStock(app, cookie, skuId, locationId, '10', '15.0000');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId: customer.id,
        locationId,
        lines: [{ skuId, orderedQty: '7', unitPrice: '40.00', currency: 'USD' }],
      },
    });
    const so = createRes.json().data as SalesOrder;
    const lineId = so.lines[0]!.id;

    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    // Ship 3 of 7
    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { lines: [{ orderLineId: lineId, quantity: '3' }] },
    });

    // Before cancel: onHand=7, reserved=4, available=3
    const balBeforeRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const balBefore = balBeforeRes.json().data[0] as StockBalance;
    expect(balBefore.onHand).toBe('7.0000');
    expect(balBefore.reserved).toBe('4.0000');
    expect(balBefore.available).toBe('3.0000');

    // Cancel remaining order
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/cancel`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().data.status).toBe('CANCELLED');

    // After cancel: onHand=7 (ISSUE preserved!), reserved=0 (4 released!), available=7
    const balAfterRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const balAfter = balAfterRes.json().data[0] as StockBalance;
    expect(balAfter.onHand).toBe('7.0000');
    expect(balAfter.reserved).toBe('0.0000');
    expect(balAfter.available).toBe('7.0000');

    // Verify ISSUE movement is still in stock-movements
    const movRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-movements?skuId=${skuId}&locationId=${locationId}&type=ISSUE`,
      headers: { cookie },
    });
    expect(movRes.json().data).toHaveLength(1);
    expect(movRes.json().data[0].quantityDelta).toBe('-3.0000');

    await outboxDispatcher.drainOutbox();
    expect(emittedEvents.map((e) => e.eventType)).toContain('OrderCancelled');
  });

  it('reserves at (SKU, Location) on confirm, dispatches multi-lot FEFO slices on ship, and enforces STRICT_BLOCK policy', async () => {
    const { app, cookie, locationId, customer } = await setupFixture();
    const customerId = customer.id;

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'BOX', name: 'Boxes' },
    });
    expect(uomRes.statusCode).toBe(201);
    const uomId = uomRes.json().data.id as string;

    const productRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Perishable Line' },
    });
    expect(productRes.statusCode).toBe(201);
    const productId = productRes.json().data.id as string;

    const supplierRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Fresh Farms' },
    });
    expect(supplierRes.statusCode).toBe(201);
    const supplierId = supplierRes.json().data.id as string;

    // Create lot+expiry tracked SKU
    const lotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'LOT-SO-01',
        name: 'Perishable Widget',
        unitOfMeasureId: uomId,
        trackLots: true,
        trackExpiry: true,
      },
    });
    expect(lotSkuRes.statusCode).toBe(201);
    const lotSkuId = lotSkuRes.json().data.id as string;

    // Receive two POs with different expiry dates and unit costs
    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId,
        lines: [{ skuId: lotSkuId, orderedQty: '8.0000', unitCost: '10.0000', currency: 'USD' }],
      },
    });
    expect(poRes.statusCode).toBe(201);
    const po = poRes.json().data;
    const poLineId = po.lines[0].id as string;

    const sendRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(sendRes.statusCode).toBe(200);

    // Receive 3 units into LOT-LATE (exp 2099-12-01, cost $15)
    const rec1 = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: poLineId,
            quantity: '3.0000',
            unitCost: '15.0000',
            lotCode: 'LOT-LATE',
            expDate: '2099-12-01',
          },
        ],
      },
    });
    expect(rec1.statusCode).toBe(201);

    // Receive 4 units into LOT-EARLY (exp 2099-06-01, cost $10)
    const rec2 = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: poLineId,
            quantity: '4.0000',
            unitCost: '10.0000',
            lotCode: 'LOT-EARLY',
            expDate: '2099-06-01',
          },
        ],
      },
    });
    expect(rec2.statusCode).toBe(201);

    // Create & confirm Sales Order for 6 units
    const soRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId,
        locationId,
        lines: [{ skuId: lotSkuId, orderedQty: '6.0000', unitPrice: '25.0000', currency: 'USD' }],
      },
    });
    expect(soRes.statusCode).toBe(201);
    const so = soRes.json().data;
    const soLineId = so.lines[0].id as string;

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(confirmRes.json().data.status).toBe('CONFIRMED');

    // Verify reservation is held at (SKU, Location)
    const balBeforeShipRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?skuId=${lotSkuId}&locationId=${locationId}`,
      headers: { cookie },
    });
    const balBeforeShip = balBeforeShipRes.json().data[0] as StockBalance;
    expect(balBeforeShip.onHand).toBe('7.0000');
    expect(balBeforeShip.reserved).toBe('6.0000');
    expect(balBeforeShip.available).toBe('1.0000');

    // Ship 6 units -> should split 4 from LOT-EARLY @ $10 and 2 from LOT-LATE @ $15
    const shipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: soLineId, quantity: '6.0000' }],
      },
    });
    expect(shipRes.statusCode).toBe(201);
    const shipData = shipRes.json().data;
    expect(shipData.status).toBe('SHIPPED');
    expect(shipData.movements).toHaveLength(2);
    expect(shipData.movements[0]).toMatchObject({
      lotCode: 'LOT-EARLY',
      sliceIndex: 0,
      quantityDelta: '-4.0000',
      unitCost: '10.0000',
      wacUnitCost: '12.1429',
    });
    expect(shipData.movements[1]).toMatchObject({
      lotCode: 'LOT-LATE',
      sliceIndex: 1,
      movementGroupId: shipData.movements[0].movementGroupId,
      quantityDelta: '-2.0000',
      unitCost: '15.0000',
      wacUnitCost: '12.1429',
    });

    // Configure STRICT_BLOCK at company level and attempt to ship 2 units when only 1 remains
    const policyRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/iam/lot-policies',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        scopeType: 'COMPANY',
        scopeId: '',
        negativeStockPolicy: 'STRICT_BLOCK',
      },
    });
    expect(policyRes.statusCode).toBe(200);

    const so2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId,
        locationId,
        lines: [{ skuId: lotSkuId, orderedQty: '2.0000', unitPrice: '25.0000', currency: 'USD' }],
      },
    });
    const so2 = so2Res.json().data;
    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so2.id}/confirm`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });

    const strictFailRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so2.id}/shipments`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: so2.lines[0].id, quantity: '2.0000' }],
      },
    });
    expect(strictFailRes.statusCode).toBe(422);
    expect(strictFailRes.json().error.code).toBe(ERROR_CODES.INSUFFICIENT_LOT_STOCK);
  });

  it('enforces MANUAL_REQUIRED, AUTO_FEFO manual bypass rejection, MANUAL_OPTIONAL EOD flag, and expired-lot override on Sales Order shipments', async () => {
    const db = createDb(pool);
    const outboxDispatcher = new OutboxDispatcher(db);
    const app = buildApp({ pool, db, outboxDispatcher, nodeEnv: 'test' });

    const ownerSignUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Owner User',
        email: 'so-owner@example.com',
        password: 'password1234',
      },
    });
    expect(ownerSignUp.statusCode).toBe(200);
    const ownerCookie = extractCookieHeader(ownerSignUp.headers['set-cookie']);

    const staffSignUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Staff User',
        email: 'so-staff@example.com',
        password: 'password1234',
      },
    });
    expect(staffSignUp.statusCode).toBe(200);
    const staffCookie = extractCookieHeader(staffSignUp.headers['set-cookie']);
    await pool.query("UPDATE iam.users SET role = 'STAFF' WHERE email = $1", [
      'so-staff@example.com',
    ]);

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: { code: 'BOX', name: 'Box' },
    });
    const uomId = uomRes.json().data.id as string;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Vaccine Vial' },
    });
    const productId = prodRes.json().data.id as string;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'VAX-01',
        name: 'Vaccine Vial 10ml',
        unitOfMeasureId: uomId,
        trackLots: true,
        trackExpiry: true,
      },
    });
    const skuId = skuRes.json().data.id as string;

    const locRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Clinic' },
    });
    const locationId = locRes.json().data.id as string;

    const supRes = await app.inject({
      method: 'POST',
      url: '/api/v1/suppliers',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: { name: 'BioSupply' },
    });
    const supplierId = supRes.json().data.id as string;

    const custRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: { name: 'City Hospital' },
    });
    const customerId = custRes.json().data.id as string;

    // Receive 1 expired lot (2020-01-01) and 1 fresh lot (2099-12-31) via PO
    const poRes = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        supplierId,
        locationId,
        lines: [
          { skuId, orderedQty: '5', unitCost: '10', currency: 'USD' },
          { skuId, orderedQty: '5', unitCost: '12', currency: 'USD' },
        ],
      },
    });
    const po = poRes.json().data;
    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/confirm`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
    });
    const recRes = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${po.id}/receipts`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: po.lines[0].id,
            quantity: '5',
            lotCode: 'VAX-EXP',
            expDate: '2020-01-01',
          },
          {
            orderLineId: po.lines[1].id,
            quantity: '5',
            lotCode: 'VAX-FRESH',
            expDate: '2099-12-31',
          },
        ],
      },
    });
    expect(recRes.statusCode).toBe(201);
    const expLotId = recRes.json().data.movements[0].lotId as string;
    const freshLotId = recRes.json().data.movements[1].lotId as string;

    // Verify GET /api/v1/stock-lots/balances returns both lots
    const lotBalRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-lots/balances?skuId=${skuId}&locationId=${locationId}`,
      headers: { cookie: ownerCookie },
    });
    expect(lotBalRes.statusCode).toBe(200);
    expect(lotBalRes.json().data).toHaveLength(2);

    // Create & confirm Sales Order for 4 units
    const soRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sales-orders',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        customerId,
        locationId,
        lines: [{ skuId, orderedQty: '4', unitPrice: '20', currency: 'USD' }],
      },
    });
    const so = soRes.json().data;
    await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/confirm`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
    });
    const soLineId = so.lines[0].id as string;

    // 1. STAFF under default AUTO_FEFO cannot supply manual lotAllocations -> 403 FORBIDDEN
    const autoBypassRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: staffCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: soLineId,
            quantity: '1',
            lotAllocations: [{ lotId: freshLotId, quantity: '1' }],
          },
        ],
      },
    });
    expect(autoBypassRes.statusCode).toBe(403);

    // 2. Configure MANUAL_REQUIRED at location level
    await app.inject({
      method: 'PUT',
      url: '/api/v1/iam/lot-policies',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        scopeType: 'LOCATION',
        scopeId: locationId,
        pickingMode: 'MANUAL_REQUIRED',
      },
    });

    // Missing lotAllocations -> 422 LOT_CODE_REQUIRED
    const missingLotRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: staffCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: soLineId, quantity: '1' }],
      },
    });
    expect(missingLotRes.statusCode).toBe(422);
    expect(missingLotRes.json().error.code).toBe(ERROR_CODES.LOT_CODE_REQUIRED);

    // Mismatched lotAllocations sum -> 422 LOT_ALLOCATION_MISMATCH
    const mismatchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: staffCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: soLineId,
            quantity: '2',
            lotAllocations: [{ lotId: freshLotId, quantity: '1' }],
          },
        ],
      },
    });
    expect(mismatchRes.statusCode).toBe(422);
    expect(mismatchRes.json().error.code).toBe(ERROR_CODES.LOT_ALLOCATION_MISMATCH);

    // Expired lot without allowExpiredLotOverride permission -> 403 FORBIDDEN
    const expBlockedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: soLineId,
            quantity: '1',
            lotAllocations: [{ lotId: expLotId, quantity: '1' }],
          },
        ],
      },
    });
    expect(expBlockedRes.statusCode).toBe(403);

    // Grant allowExpiredLotOverride to OWNER role
    await app.inject({
      method: 'PUT',
      url: '/api/v1/iam/lot-policies',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        scopeType: 'ROLE',
        scopeId: 'OWNER',
        allowExpiredLotOverride: true,
      },
    });

    // Authorized actor without confirmExpiredLotOverride -> 422 EXPIRED_LOT_CONFIRMATION_REQUIRED
    const expUnconfirmedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [
          {
            orderLineId: soLineId,
            quantity: '1',
            lotAllocations: [{ lotId: expLotId, quantity: '1' }],
          },
        ],
      },
    });
    expect(expUnconfirmedRes.statusCode).toBe(422);
    expect(expUnconfirmedRes.json().error.code).toBe(ERROR_CODES.EXPIRED_LOT_CONFIRMATION_REQUIRED);

    // Authorized + confirmed -> 201 with expiredLotOverride: true + warning
    const expConfirmedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        confirmExpiredLotOverride: true,
        overrideReason: 'Approved clearance batch',
        lines: [
          {
            orderLineId: soLineId,
            quantity: '1',
            lotAllocations: [{ lotId: expLotId, quantity: '1' }],
          },
        ],
      },
    });
    expect(expConfirmedRes.statusCode).toBe(201);
    expect(expConfirmedRes.json().data.movements[0]).toMatchObject({
      lotId: expLotId,
      expiredLotOverride: true,
      overrideReason: 'Approved clearance batch',
    });
    expect(expConfirmedRes.json().warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: WARNING_CODES.EXPIRED_LOT_OVERRIDE_USED }),
      ]),
    );

    // 3. Switch location to MANUAL_OPTIONAL -> ship 1 unit omitting lotAllocations -> lotId: null + eodReconciliationRequired: true
    await app.inject({
      method: 'PUT',
      url: '/api/v1/iam/lot-policies',
      headers: { cookie: ownerCookie, 'idempotency-key': uuidv7() },
      payload: {
        scopeType: 'LOCATION',
        scopeId: locationId,
        pickingMode: 'MANUAL_OPTIONAL',
      },
    });

    const optShipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sales-orders/${so.id}/shipments`,
      headers: { cookie: staffCookie, 'idempotency-key': uuidv7() },
      payload: {
        lines: [{ orderLineId: soLineId, quantity: '1' }],
      },
    });
    expect(optShipRes.statusCode).toBe(201);
    expect(optShipRes.json().data.movements[0]).toMatchObject({
      lotId: null,
      eodReconciliationRequired: true,
    });
    expect(optShipRes.json().warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: WARNING_CODES.EOD_RECONCILIATION_REQUIRED }),
      ]),
    );
  });
});

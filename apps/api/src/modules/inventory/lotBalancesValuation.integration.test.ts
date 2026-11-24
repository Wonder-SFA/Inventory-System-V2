import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { toQuantity, toUnitCost, uuidv7 } from '@iv2/shared-domain';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher } from '../../shared/index.js';
import { resolvePolicy } from '../iam/public/index.js';
import {
  getValuationSummary,
  listLotBalances,
  listStockBalances,
  listStockLots,
  postMovements,
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

describe('inventory lot balances, expiry view & dual valuation (FIFO / WAC)', () => {
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
        name: 'Owner User',
        email: 'owner@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'EA', name: 'Each' },
    });
    const uomId = uomRes.json().data.id as string;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Dairy & Dry Goods' },
    });
    const productId = prodRes.json().data.id as string;

    const lotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'MILK-LOT',
        name: 'Fresh Milk 1L',
        unitOfMeasureId: uomId,
        trackLots: true,
        trackExpiry: true,
        defaultSellingPrice: '30.0000',
      },
    });
    expect(lotSkuRes.statusCode).toBe(201);
    const lotSkuId = lotSkuRes.json().data.id as string;

    const nonLotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        code: 'CUP-PLAIN',
        name: 'Plain Cup',
        unitOfMeasureId: uomId,
        trackLots: false,
        trackExpiry: false,
        defaultSellingPrice: '15.0000',
      },
    });
    expect(nonLotSkuRes.statusCode).toBe(201);
    const nonLotSkuId = nonLotSkuRes.json().data.id as string;

    const loc1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Main Warehouse' },
    });
    const loc1Id = loc1Res.json().data.id as string;

    const loc2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Branch Store' },
    });
    const loc2Id = loc2Res.json().data.id as string;

    return { db, app, cookie, lotSkuId, nonLotSkuId, loc1Id, loc2Id };
  }

  it('lists stock lots and lot balances with LocationScope, cursor pagination, and expiry status filtering', async () => {
    const { db, lotSkuId, loc1Id, loc2Id } = await setupFixture();
    const actorId = uuidv7();
    const today = '2026-11-24';

    await postMovements(db, [
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc1Id,
        lotInput: { lotCode: 'LOT-EXPIRED', mfgDate: '2026-01-01', expDate: '2026-11-01' },
        quantityDelta: toQuantity('5'),
        unitCost: toUnitCost('10'),
        actorId,
        idempotencyKey: uuidv7(),
      },
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc1Id,
        lotInput: { lotCode: 'LOT-SOON', mfgDate: '2026-10-01', expDate: '2026-12-10' },
        quantityDelta: toQuantity('8'),
        unitCost: toUnitCost('12'),
        actorId,
        idempotencyKey: uuidv7(),
      },
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc2Id,
        lotInput: { lotCode: 'LOT-ACTIVE', mfgDate: '2026-11-01', expDate: '2027-03-01' },
        quantityDelta: toQuantity('10'),
        unitCost: toUnitCost('15'),
        actorId,
        idempotencyKey: uuidv7(),
      },
    ]);

    const globalScope = { allLocations: true } as const;
    const loc1Scope = { locationIds: [loc1Id] } as const;
    const emptyScope = { locationIds: [] } as const;

    // Empty scope returns nothing
    const emptyLots = await listStockLots(db, emptyScope, { limit: 50, expiringWithinDays: 30, today });
    expect(emptyLots.items).toEqual([]);

    // Global scope sees all 3 lots with computed expiryStatus
    const allLots = await listStockLots(db, globalScope, { limit: 2, expiringWithinDays: 30, today });
    expect(allLots.items).toHaveLength(2);
    expect(allLots.hasMore).toBe(true);
    expect(allLots.nextCursor).toBeTruthy();

    const page2Lots = await listStockLots(db, globalScope, {
      limit: 2,
      cursor: allLots.nextCursor!,
      expiringWithinDays: 30,
      today,
    });
    expect(page2Lots.items).toHaveLength(1);
    expect(page2Lots.hasMore).toBe(false);

    const combinedLots = [...allLots.items, ...page2Lots.items];
    expect(combinedLots.map((l) => [l.lotCode, l.expiryStatus])).toEqual(
      expect.arrayContaining([
        ['LOT-EXPIRED', 'EXPIRED'],
        ['LOT-SOON', 'EXPIRING_SOON'],
        ['LOT-ACTIVE', 'ACTIVE'],
      ]),
    );

    // Location-restricted scope sees only loc1 lots
    const loc1Balances = await listLotBalances(db, loc1Scope, {
      limit: 50,
      expiringWithinDays: 30,
      today,
    });
    expect(loc1Balances.items.map((b) => b.lotCode)).toEqual(['LOT-EXPIRED', 'LOT-SOON']);

    // Requesting loc2 under loc1Scope returns empty
    const forbiddenLocBalances = await listLotBalances(db, loc1Scope, {
      limit: 50,
      locationId: loc2Id,
      expiringWithinDays: 30,
      today,
    });
    expect(forbiddenLocBalances.items).toEqual([]);

    // Filter by expiryStatus=EXPIRING_SOON
    const soonOnly = await listLotBalances(db, globalScope, {
      limit: 50,
      expiryStatus: 'EXPIRING_SOON',
      expiringWithinDays: 30,
      today,
    });
    expect(soonOnly.items).toHaveLength(1);
    expect(soonOnly.items[0]?.lotCode).toBe('LOT-SOON');
    expect(soonOnly.items[0]?.expiryStatus).toBe('EXPIRING_SOON');
  });

  it('computes FIFO vs WAC valuation totals at 4-decimal precision across lot-tracked and non-lot SKUs', async () => {
    const { db, lotSkuId, nonLotSkuId, loc1Id } = await setupFixture();
    const actorId = uuidv7();

    // Receive Lot A (4 @ $10.0000) and Lot B (6 @ $20.0000) -> WAC = $160 / 10 = $16.0000
    await postMovements(db, [
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc1Id,
        lotInput: { lotCode: 'LOT-A', expDate: '2027-01-01' },
        quantityDelta: toQuantity('4'),
        unitCost: toUnitCost('10'),
        actorId,
        idempotencyKey: uuidv7(),
      },
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc1Id,
        lotInput: { lotCode: 'LOT-B', expDate: '2027-02-01' },
        quantityDelta: toQuantity('6'),
        unitCost: toUnitCost('20'),
        actorId,
        idempotencyKey: uuidv7(),
      },
      // Non-lot SKU: 5 @ $7.5000 = $37.5000
      {
        type: 'RECEIPT',
        skuId: nonLotSkuId,
        locationId: loc1Id,
        quantityDelta: toQuantity('5'),
        unitCost: toUnitCost('7.5'),
        actorId,
        idempotencyKey: uuidv7(),
      },
    ]);

    // Issue 4 units of lotSkuId via FEFO (drains Lot A @ $10.0000 completely; remaining = 6 units of Lot B @ $20.0000)
    // Remaining FIFO value for lotSkuId = 6 * 20 = 120.0000
    // Remaining WAC value for lotSkuId = 6 * 16 = 96.0000
    await postMovements(
      db,
      [
        {
          type: 'ISSUE',
          skuId: lotSkuId,
          locationId: loc1Id,
          quantityDelta: toQuantity('-4'),
          actorId,
          idempotencyKey: uuidv7(),
        },
      ],
      { pickingMode: 'AUTO_FEFO', today: '2026-11-24' },
    );

    const globalScope = { allLocations: true } as const;

    const fifoSummary = await getValuationSummary(db, globalScope, { costBasis: 'FIFO' });
    expect(fifoSummary.costBasis).toBe('FIFO');
    expect(fifoSummary.totalFifoValue).toBe('157.5000'); // 120.0000 + 37.5000
    expect(fifoSummary.totalWacValue).toBe('133.5000'); // 96.0000 + 37.5000
    expect(fifoSummary.totalValue).toBe('157.5000');

    const wacSummary = await getValuationSummary(db, globalScope, { costBasis: 'WAC' });
    expect(wacSummary.costBasis).toBe('WAC');
    expect(wacSummary.totalValue).toBe('133.5000');

    const fifoBalances = await listStockBalances(db, globalScope, {
      limit: 50,
      view: 'per-location',
      costBasis: 'FIFO',
    });
    const lotRowFifo = fifoBalances.items.find((r) => r.skuId === lotSkuId)!;
    expect(lotRowFifo.totalValue).toBe('120.0000');
    expect(lotRowFifo.fifoValue).toBe('120.0000');
    expect(lotRowFifo.wacValue).toBe('96.0000');
    expect(lotRowFifo.unitCost).toBe('20.0000');
    expect(lotRowFifo.weightedAverageCost).toBe('16.0000');

    const wacBalances = await listStockBalances(db, globalScope, {
      limit: 50,
      view: 'per-location',
      costBasis: 'WAC',
    });
    const lotRowWac = wacBalances.items.find((r) => r.skuId === lotSkuId)!;
    expect(lotRowWac.totalValue).toBe('96.0000');
    expect(lotRowWac.unitCost).toBe('16.0000');
  });

  it('exposes HTTP routes and omits all cost and valuation fields when actor lacks View Costs & Prices', async () => {
    const { db, app, cookie, lotSkuId, loc1Id } = await setupFixture();
    const actorId = uuidv7();

    await postMovements(db, [
      {
        type: 'RECEIPT',
        skuId: lotSkuId,
        locationId: loc1Id,
        lotInput: { lotCode: 'LOT-HTTP-1', expDate: '2027-06-01' },
        quantityDelta: toQuantity('10'),
        unitCost: toUnitCost('12.5'),
        actorId,
        idempotencyKey: uuidv7(),
      },
    ]);

    const lotsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-lots?skuId=${lotSkuId}`,
      headers: { cookie },
    });
    expect(lotsRes.statusCode).toBe(200);
    expect(lotsRes.json().data).toHaveLength(1);
    expect(lotsRes.json().data[0].lotCode).toBe('LOT-HTTP-1');

    const lotBalRes = await app.inject({
      method: 'GET',
      url: `/api/v1/lot-balances?locationId=${loc1Id}`,
      headers: { cookie },
    });
    expect(lotBalRes.statusCode).toBe(200);
    expect(lotBalRes.json().data[0].unitCost).toBe('12.5000');
    expect(lotBalRes.json().data[0].totalValue).toBe('125.0000');

    const valRes = await app.inject({
      method: 'GET',
      url: `/api/v1/valuation-summary?costBasis=FIFO`,
      headers: { cookie },
    });
    expect(valRes.statusCode).toBe(200);
    expect(valRes.json().data.totalValue).toBe('125.0000');

    const sbFifoRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?locationId=${loc1Id}&costBasis=FIFO`,
      headers: { cookie },
    });
    expect(sbFifoRes.statusCode).toBe(200);
    expect(sbFifoRes.json().data[0].costBasis).toBe('FIFO');
    expect(sbFifoRes.json().data[0].totalValue).toBe('125.0000');

    const sbWacRes = await app.inject({
      method: 'GET',
      url: `/api/v1/stock-balances?view=company-wide&costBasis=WAC`,
      headers: { cookie },
    });
    expect(sbWacRes.statusCode).toBe(200);
    expect(sbWacRes.json().data[0].costBasis).toBe('WAC');
    expect(sbWacRes.json().data[0].totalValue).toBe('125.0000');

    // Verify centralized redaction omits all cost fields completely (never zero-filled)
    const restrictedPolicy = resolvePolicy(
      { id: uuidv7(), email: 'clerk@example.com', name: 'Clerk', role: 'CLERK' },
      { canViewCosts: false, locationScope: { allLocations: true } },
    );

    const redactedLotBal = restrictedPolicy.redactCosts(lotBalRes.json().data[0]);
    expect(redactedLotBal).not.toHaveProperty('unitCost');
    expect(redactedLotBal).not.toHaveProperty('wacUnitCost');
    expect(redactedLotBal).not.toHaveProperty('totalValue');
    expect(redactedLotBal).not.toHaveProperty('fifoValue');
    expect(redactedLotBal).not.toHaveProperty('wacValue');

    const redactedVal = restrictedPolicy.redactCosts(valRes.json().data);
    expect(redactedVal).not.toHaveProperty('totalValue');
    expect(redactedVal).not.toHaveProperty('totalFifoValue');
    expect(redactedVal).not.toHaveProperty('totalWacValue');
    expect(redactedVal.totalOnHand).toBe('10.0000');

    const redactedSb = restrictedPolicy.redactCosts(sbFifoRes.json().data[0]);
    expect(redactedSb).not.toHaveProperty('unitCost');
    expect(redactedSb).not.toHaveProperty('weightedAverageCost');
    expect(redactedSb).not.toHaveProperty('totalValue');
    expect(redactedSb).not.toHaveProperty('fifoValue');
    expect(redactedSb).not.toHaveProperty('wacValue');
  });
});

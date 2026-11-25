import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ERROR_CODES, uuidv7 } from '@iv2/shared-domain';
import { desc } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { outboxEvents } from '../../shared/db/schema.js';
import {
  findSkuByIdOrCode,
  getSkusByIds,
  registerSkuReferenceChecker,
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

describe('catalog module integration', () => {
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

  async function setupAuthedApp() {
    const db = createDb(pool);
    const app = buildApp({ pool, db, nodeEnv: 'test' });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: 'catalog-admin@example.com',
        password: 'CorrectHorseBatteryStaple123!',
        name: 'Catalog Admin',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    return { app, db, cookie };
  }

  it('supports Units of Measure CRUD, case-insensitive uniqueness, cursor pagination, and delete protection', async () => {
    const { app, db, cookie } = await setupAuthedApp();

    // Create two Units of Measure
    const createPcs = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'pcs', name: 'Pieces' },
    });
    expect(createPcs.statusCode).toBe(201);
    const pcs = createPcs.json().data;
    expect(pcs.code).toBe('pcs');
    expect(pcs.name).toBe('Pieces');

    const createKg = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'kg', name: 'Kilograms' },
    });
    expect(createKg.statusCode).toBe(201);
    const kg = createKg.json().data;

    // Duplicate code case-insensitively -> 409
    const dupCode = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'PCS', name: 'Pieces Duplicate' },
    });
    expect(dupCode.statusCode).toBe(409);
    expect(dupCode.json().error.code).toBe(ERROR_CODES.UNIT_OF_MEASURE_CONFLICT);

    // Cursor-paginated list (limit=1)
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/units-of-measure?limit=1',
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const p1Body = page1.json();
    expect(p1Body.data).toHaveLength(1);
    expect(p1Body.page.hasMore).toBe(true);
    expect(p1Body.page.nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/units-of-measure?limit=1&cursor=${encodeURIComponent(p1Body.page.nextCursor)}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    const p2Body = page2.json();
    expect(p2Body.data).toHaveLength(1);
    expect(p2Body.data[0].id).not.toBe(p1Body.data[0].id);
    expect(p2Body.page.hasMore).toBe(false);

    // Delete unused Unit of Measure succeeds
    const delKg = await app.inject({
      method: 'DELETE',
      url: `/api/v1/units-of-measure/${kg.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delKg.statusCode).toBe(200);

    // Create Product + SKU referencing pcs, then verify delete of pcs is rejected with 409 RESOURCE_IN_USE
    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Cotton T-Shirt' },
    });
    expect(prodRes.statusCode).toBe(201);
    const product = prodRes.json().data;

    const skuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: product.id,
        unitOfMeasureId: pcs.id,
        code: 'TSHIRT-RED-M',
        name: 'Cotton T-Shirt — Red, Medium',
        defaultSellingPrice: '24.50',
      },
    });
    expect(skuRes.statusCode).toBe(201);

    const delUsedPcs = await app.inject({
      method: 'DELETE',
      url: `/api/v1/units-of-measure/${pcs.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delUsedPcs.statusCode).toBe(409);
    expect(delUsedPcs.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Verify outbox events emitted
    const events = await db.select().from(outboxEvents).orderBy(desc(outboxEvents.seqId));
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('UnitOfMeasureCreated');
    expect(eventTypes).toContain('UnitOfMeasureDeleted');
    expect(eventTypes).toContain('ProductCreated');
    expect(eventTypes).toContain('SkuCreated');
  });

  it('supports Units of Measure PATCH, archive/unarchive, conflict checks, and status filtering', async () => {
    const { app, db, cookie } = await setupAuthedApp();

    const createBox = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'box', name: 'Box' },
    });
    expect(createBox.statusCode).toBe(201);
    const box = createBox.json().data;
    expect(box.status).toBe('ACTIVE');

    const createPack = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'pack', name: 'Pack' },
    });
    expect(createPack.statusCode).toBe(201);
    const pack = createPack.json().data;

    // PATCH update code & name
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/units-of-measure/${box.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'CTN', name: 'Carton' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.code).toBe('CTN');
    expect(patchRes.json().data.name).toBe('Carton');
    expect(patchRes.json().data.status).toBe('ACTIVE');

    // PATCH conflict on case-insensitive code or name -> 409 UNIT_OF_MEASURE_CONFLICT
    const patchConflict = await app.inject({
      method: 'PATCH',
      url: `/api/v1/units-of-measure/${box.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'PACK' },
    });
    expect(patchConflict.statusCode).toBe(409);
    expect(patchConflict.json().error.code).toBe(ERROR_CODES.UNIT_OF_MEASURE_CONFLICT);

    // Archive box
    const archiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/units-of-measure/${box.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().data.status).toBe('ARCHIVED');

    // Filter by status=ACTIVE and status=ARCHIVED
    const activeList = await app.inject({
      method: 'GET',
      url: '/api/v1/units-of-measure?status=ACTIVE',
      headers: { cookie },
    });
    expect(activeList.statusCode).toBe(200);
    expect(activeList.json().data.map((u: { id: string }) => u.id)).toEqual([pack.id]);

    const archivedList = await app.inject({
      method: 'GET',
      url: '/api/v1/units-of-measure?status=ARCHIVED',
      headers: { cookie },
    });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json().data.map((u: { id: string }) => u.id)).toEqual([box.id]);

    // Unarchive box
    const unarchiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/units-of-measure/${box.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchiveRes.statusCode).toBe(200);
    expect(unarchiveRes.json().data.status).toBe('ACTIVE');

    const events = await db.select().from(outboxEvents).orderBy(desc(outboxEvents.seqId));
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('UnitOfMeasureUpdated');
    expect(eventTypes).toContain('UnitOfMeasureArchived');
    expect(eventTypes).toContain('UnitOfMeasureUnarchived');
  });

  it('supports Products CRUD, status filtering, archive/unarchive, and delete protection', async () => {
    const { app, cookie } = await setupAuthedApp();

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'pcs', name: 'Pieces' },
    });
    const uom = uomRes.json().data;

    // Create two products
    const p1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Canvas Tote', description: 'Heavyweight tote bag' },
    });
    expect(p1Res.statusCode).toBe(201);
    const p1 = p1Res.json().data;
    expect(p1.status).toBe('ACTIVE');

    const p2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Ceramic Mug' },
    });
    expect(p2Res.statusCode).toBe(201);
    const p2 = p2Res.json().data;

    // Update p1
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${p1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Organic Canvas Tote', description: null },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.name).toBe('Organic Canvas Tote');
    expect(patchRes.json().data.description).toBeNull();

    // Get by id
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/products/${p1.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.name).toBe('Organic Canvas Tote');

    // Archive p2
    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${p2.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archRes.statusCode).toBe(200);
    expect(archRes.json().data.status).toBe('ARCHIVED');

    // Filter by status=ACTIVE and status=ARCHIVED
    const activeList = await app.inject({
      method: 'GET',
      url: '/api/v1/products?status=ACTIVE',
      headers: { cookie },
    });
    expect(activeList.statusCode).toBe(200);
    expect(activeList.json().data.map((p: { id: string }) => p.id)).toEqual([p1.id]);

    const archivedList = await app.inject({
      method: 'GET',
      url: '/api/v1/products?status=ARCHIVED',
      headers: { cookie },
    });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json().data.map((p: { id: string }) => p.id)).toEqual([p2.id]);

    // Unarchive p2
    const unarchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/products/${p2.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchRes.statusCode).toBe(200);
    expect(unarchRes.json().data.status).toBe('ACTIVE');

    // Attach SKU to p1 -> deleting p1 fails with 409 RESOURCE_IN_USE
    await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: p1.id,
        unitOfMeasureId: uom.id,
        code: 'TOTE-BLK',
        name: 'Organic Canvas Tote — Black',
      },
    });

    const delUsed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${p1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delUsed.statusCode).toBe(409);
    expect(delUsed.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Deleting unused p2 succeeds
    const delUnused = await app.inject({
      method: 'DELETE',
      url: `/api/v1/products/${p2.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delUnused.statusCode).toBe(200);
  });

  it('enforces case-insensitive SKU uniqueness, archived SKU code non-reuse, lookup, decimal precision, and reference checker hook', async () => {
    const { app, db, cookie } = await setupAuthedApp();

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'pcs', name: 'Pieces' },
    });
    const uom = uomRes.json().data;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Mechanical Keyboard' },
    });
    const product = prodRes.json().data;

    // Reject >4 decimal places on defaultSellingPrice
    const badDecimal = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: product.id,
        unitOfMeasureId: uom.id,
        code: 'KB-01',
        name: 'Keyboard 01',
        defaultSellingPrice: '99.12345',
      },
    });
    expect(badDecimal.statusCode).toBe(422);
    expect(badDecimal.json().error.code).toBe(ERROR_CODES.DECIMAL_PRECISION_EXCEEDED);

    // Create SKU
    const createSku1 = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: product.id,
        unitOfMeasureId: uom.id,
        code: 'KB-TKL-BLK',
        name: 'TKL Keyboard — Black',
        defaultSellingPrice: '129.99',
      },
    });
    expect(createSku1.statusCode).toBe(201);
    const sku1 = createSku1.json().data;
    expect(sku1.defaultSellingPrice).toBe('129.9900');

    // Case-insensitive duplicate code -> 409 SKU_CODE_CONFLICT
    const dupSku = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: product.id,
        unitOfMeasureId: uom.id,
        code: 'kb-tkl-blk',
        name: 'Duplicate TKL',
      },
    });
    expect(dupSku.statusCode).toBe(409);
    expect(dupSku.json().error.code).toBe(ERROR_CODES.SKU_CODE_CONFLICT);

    // Lookup by code (case-insensitive)
    const lookupRes = await app.inject({
      method: 'GET',
      url: '/api/v1/skus/lookup?code=kb-tkl-blk',
      headers: { cookie },
    });
    expect(lookupRes.statusCode).toBe(200);
    expect(lookupRes.json().data.id).toBe(sku1.id);

    const lookupMissing = await app.inject({
      method: 'GET',
      url: '/api/v1/skus/lookup?code=DOES-NOT-EXIST',
      headers: { cookie },
    });
    expect(lookupMissing.statusCode).toBe(404);

    // Public module functions: findSkuByIdOrCode & getSkusByIds
    const byCode = await findSkuByIdOrCode(db, { code: 'KB-TKL-BLK' });
    expect(byCode?.id).toBe(sku1.id);
    const byId = await findSkuByIdOrCode(db, { skuId: sku1.id });
    expect(byId?.code).toBe('KB-TKL-BLK');
    const batch = await getSkusByIds(db, [sku1.id]);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.id).toBe(sku1.id);

    // Archive sku1 -> archived SKU code remains permanently reserved
    const archSku1 = await app.inject({
      method: 'POST',
      url: `/api/v1/skus/${sku1.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archSku1.statusCode).toBe(200);
    expect(archSku1.json().data.status).toBe('ARCHIVED');

    const reuseArchivedCode = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId: product.id,
        unitOfMeasureId: uom.id,
        code: 'KB-TKL-BLK',
        name: 'New SKU Reusing Archived Code',
      },
    });
    expect(reuseArchivedCode.statusCode).toBe(409);
    expect(reuseArchivedCode.json().error.code).toBe(ERROR_CODES.SKU_CODE_CONFLICT);

    // Unarchive sku1
    const unarchSku1 = await app.inject({
      method: 'POST',
      url: `/api/v1/skus/${sku1.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchSku1.statusCode).toBe(200);
    expect(unarchSku1.json().data.status).toBe('ACTIVE');

    // Update sku1
    const patchSku1 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${sku1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'TKL Keyboard — Matte Black', defaultSellingPrice: '139.5' },
    });
    expect(patchSku1.statusCode).toBe(200);
    expect(patchSku1.json().data.name).toBe('TKL Keyboard — Matte Black');
    expect(patchSku1.json().data.defaultSellingPrice).toBe('139.5000');

    // Register external SKU reference checker -> blocks hard-delete with 409 RESOURCE_IN_USE
    const unregister = registerSkuReferenceChecker(async (_db, id) => id === sku1.id);
    try {
      const delProtected = await app.inject({
        method: 'DELETE',
        url: `/api/v1/skus/${sku1.id}`,
        headers: { cookie, 'idempotency-key': uuidv7() },
      });
      expect(delProtected.statusCode).toBe(409);
      expect(delProtected.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);
    } finally {
      unregister();
    }

    // Once unreferenced, hard-delete succeeds
    const delUnused = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skus/${sku1.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delUnused.statusCode).toBe(200);
  });

  it('supports opt-in trackLots and trackExpiry flags, enforces trackExpiry => trackLots, and allows enabling trackLots with positive stock (hybrid cutover)', async () => {
    const { app, cookie } = await setupAuthedApp();

    const uomRes = await app.inject({
      method: 'POST',
      url: '/api/v1/units-of-measure',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { code: 'BOX', name: 'Box' },
    });
    const uomId = uomRes.json().data.id as string;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Milk Powder' },
    });
    const productId = prodRes.json().data.id as string;

    // 1. Creating SKU without flags defaults both to false
    const defaultSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { productId, unitOfMeasureId: uomId, code: 'MILK-1', name: 'Milk Plain' },
    });
    expect(defaultSkuRes.statusCode).toBe(201);
    const defaultSku = defaultSkuRes.json().data;
    expect(defaultSku.trackLots).toBe(false);
    expect(defaultSku.trackExpiry).toBe(false);

    // 2. Creating SKU with trackExpiry=true and trackLots=false is rejected (422)
    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        unitOfMeasureId: uomId,
        code: 'MILK-BAD',
        name: 'Milk Bad',
        trackLots: false,
        trackExpiry: true,
      },
    });
    expect(invalidCreate.statusCode).toBe(422);

    // 3. Creating SKU with trackLots=true and trackExpiry=true succeeds
    const lotSkuRes = await app.inject({
      method: 'POST',
      url: '/api/v1/skus',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: {
        productId,
        unitOfMeasureId: uomId,
        code: 'MILK-LOT',
        name: 'Milk Lot',
        trackLots: true,
        trackExpiry: true,
      },
    });
    expect(lotSkuRes.statusCode).toBe(201);
    const lotSku = lotSkuRes.json().data;
    expect(lotSku.trackLots).toBe(true);
    expect(lotSku.trackExpiry).toBe(true);

    // 4. Updating trackLots=false while trackExpiry=true is rejected (422)
    const invalidPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${lotSku.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { trackLots: false },
    });
    expect(invalidPatch.statusCode).toBe(422);
    expect(invalidPatch.json().error.code).toBe(ERROR_CODES.INVALID_LOT_CONFIGURATION);

    // 5. Turning trackLots=true on an existing SKU succeeds (hybrid cutover)
    const enabledWithStock = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skus/${defaultSku.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { trackLots: true, trackExpiry: true },
    });
    expect(enabledWithStock.statusCode).toBe(200);
    expect(enabledWithStock.json().data.trackLots).toBe(true);
    expect(enabledWithStock.json().data.trackExpiry).toBe(true);

    // 6. Lookup returns the updated flags

    const lookupRes = await app.inject({
      method: 'GET',
      url: '/api/v1/skus/lookup?code=MILK-1',
      headers: { cookie },
    });
    expect(lookupRes.statusCode).toBe(200);
    expect(lookupRes.json().data.trackLots).toBe(true);
    expect(lookupRes.json().data.trackExpiry).toBe(true);
  });
});

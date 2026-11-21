import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ERROR_CODES, type Location, uuidv7 } from '@iv2/shared-domain';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { OutboxDispatcher, outboxEvents } from '../../shared/index.js';
import {
  type LocationReferenceChecker,
  getLocationById,
  getLocationsByIds,
  listLocations,
  registerLocationReferenceChecker,
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

describe('inventory locations API & public seam integration', () => {
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

  async function setupAuthenticatedApp() {
    const db = createDb(pool);
    const outboxDispatcher = new OutboxDispatcher(db);
    const app = buildApp({ pool, db, outboxDispatcher, nodeEnv: 'test' });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Ops Manager',
        email: 'ops@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    return { app, db, outboxDispatcher, cookie };
  }

  it('creates a location, emits LocationCreated outbox event, and enforces case-insensitive uniqueness', async () => {
    const { app, db, outboxDispatcher, cookie } = await setupAuthenticatedApp();
    const emittedEvents: string[] = [];
    outboxDispatcher.registerConsumer('test-locations', async (event) => {
      emittedEvents.push(event.eventType);
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        cookie,
        'idempotency-key': uuidv7(),
      },
      payload: {
        name: 'Main Warehouse',
        address: '100 Industrial Way',
        description: 'Primary distribution hub',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().data as Location;
    expect(created.name).toBe('Main Warehouse');
    expect(created.address).toBe('100 Industrial Way');
    expect(created.description).toBe('Primary distribution hub');
    expect(created.status).toBe('ACTIVE');
    expect(created.parentLocationId).toBeNull();

    await outboxDispatcher.drainOutbox();
    expect(emittedEvents).toContain('LocationCreated');

    // Duplicate differing only by case -> 409 LOCATION_NAME_CONFLICT
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: {
        cookie,
        'idempotency-key': uuidv7(),
      },
      payload: {
        name: 'main warehouse',
      },
    });

    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().error.code).toBe(ERROR_CODES.LOCATION_NAME_CONFLICT);

    // Also verify GET /api/v1/locations/:id (200 & 404)
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${created.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().data.id).toBe(created.id);

    const missingGetRes = await app.inject({
      method: 'GET',
      url: `/api/v1/locations/${uuidv7()}`,
      headers: { cookie },
    });
    expect(missingGetRes.statusCode).toBe(404);
    expect(missingGetRes.json().error.code).toBe(ERROR_CODES.LOCATION_NOT_FOUND);

    // Also verify PATCH duplicate name conflict
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Downtown Store' },
    });
    expect(secondRes.statusCode).toBe(201);
    const second = secondRes.json().data as Location;

    const patchConflictRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${second.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'MAIN WAREHOUSE' },
    });
    expect(patchConflictRes.statusCode).toBe(409);
    expect(patchConflictRes.json().error.code).toBe(ERROR_CODES.LOCATION_NAME_CONFLICT);

    // Also verify outbox row has aggregateType location
    const rows = await db.select().from(outboxEvents);
    expect(rows.some((r) => r.eventType === 'LocationCreated' && r.aggregateId === created.id)).toBe(
      true,
    );

    await app.close();
  });

  it('supports parentLocationId association and rejects self-reference, cycles, and missing parent with 422', async () => {
    const { app, cookie } = await setupAuthenticatedApp();

    const createLoc = async (name: string, parentLocationId?: string | null) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: { name, ...(parentLocationId ? { parentLocationId } : {}) },
      });
      expect(res.statusCode).toBe(201);
      return res.json().data as Location;
    };

    const locA = await createLoc('Warehouse A');
    const locB = await createLoc('Zone B', locA.id);
    const locC = await createLoc('Aisle C', locB.id);

    expect(locB.parentLocationId).toBe(locA.id);
    expect(locC.parentLocationId).toBe(locB.id);

    // Non-existent parent on create -> 422
    const missingParentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Orphan', parentLocationId: uuidv7() },
    });
    expect(missingParentRes.statusCode).toBe(422);
    expect(missingParentRes.json().error.code).toBe(ERROR_CODES.PARENT_LOCATION_NOT_FOUND);

    // Self-reference on PATCH -> 422
    const selfRefRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${locA.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { parentLocationId: locA.id },
    });
    expect(selfRefRes.statusCode).toBe(422);
    expect(selfRefRes.json().error.code).toBe(ERROR_CODES.LOCATION_CYCLE_DETECTED);

    // Cycle A -> B -> C -> A on PATCH -> 422
    const cycleRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${locA.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { parentLocationId: locC.id },
    });
    expect(cycleRes.statusCode).toBe(422);
    expect(cycleRes.json().error.code).toBe(ERROR_CODES.LOCATION_CYCLE_DETECTED);

    // Valid update (clear parentLocationId + rename)
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/locations/${locC.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'Aisle C Updated', parentLocationId: null },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().data.name).toBe('Aisle C Updated');
    expect(updateRes.json().data.parentLocationId).toBeNull();

    await app.close();
  });

  it('supports cursor pagination, status filtering, and LocationScope filtering', async () => {
    const { app, db, cookie } = await setupAuthenticatedApp();

    const createdIds: string[] = [];
    for (const name of ['Alpha Store', 'Beta Store', 'Gamma Store']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: { name },
      });
      expect(res.statusCode).toBe(201);
      createdIds.push((res.json().data as Location).id);
    }

    // Archive Beta Store
    const archiveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${createdIds[1]}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().data.status).toBe('ARCHIVED');

    // Page 1 with limit=2 (all statuses)
    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/locations?limit=2',
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data).toHaveLength(2);
    expect(page1.json().page.hasMore).toBe(true);
    expect(page1.json().page.nextCursor).toBeTruthy();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/locations?limit=2&cursor=${page1.json().page.nextCursor}`,
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().page.hasMore).toBe(false);

    // Filter by status=ACTIVE
    const activeRes = await app.inject({
      method: 'GET',
      url: '/api/v1/locations?status=ACTIVE',
      headers: { cookie },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().data.map((l: Location) => l.name).sort()).toEqual([
      'Alpha Store',
      'Gamma Store',
    ]);

    // LocationScope filtering via public seam
    const scopedList = await listLocations(
      db,
      { locationIds: [createdIds[0]!] },
      { limit: 50 },
    );
    expect(scopedList.items).toHaveLength(1);
    expect(scopedList.items[0]!.id).toBe(createdIds[0]);

    const emptyScopeList = await listLocations(db, { locationIds: [] }, { limit: 50 });
    expect(emptyScopeList.items).toHaveLength(0);

    const outOfScope = await getLocationById(db, { locationIds: [createdIds[0]!] }, createdIds[2]!);
    expect(outOfScope).toBeNull();

    const inScopeBatch = await getLocationsByIds(
      db,
      { locationIds: [createdIds[0]!, createdIds[1]!] },
      createdIds,
    );
    expect(inScopeBatch.map((l) => l.id).sort()).toEqual([createdIds[0]!, createdIds[1]!].sort());

    await app.close();
  });

  it('supports archive/unarchive lifecycle and blocks hard-delete when referenced by child, checker, or DB FK', async () => {
    const { app, db, outboxDispatcher, cookie } = await setupAuthenticatedApp();
    const events: string[] = [];
    outboxDispatcher.registerConsumer('test-lifecycle', async (ev) => {
      events.push(ev.eventType);
    });

    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'HQ Warehouse' },
    });
    const parent = parentRes.json().data as Location;

    const childRes = await app.inject({
      method: 'POST',
      url: '/api/v1/locations',
      headers: { cookie, 'idempotency-key': uuidv7() },
      payload: { name: 'HQ Mezzanine', parentLocationId: parent.id },
    });
    const child = childRes.json().data as Location;

    // Archive & unarchive
    const archRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${child.id}/archive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(archRes.statusCode).toBe(200);
    expect(archRes.json().data.status).toBe('ARCHIVED');

    const unarchRes = await app.inject({
      method: 'POST',
      url: `/api/v1/locations/${child.id}/unarchive`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(unarchRes.statusCode).toBe(200);
    expect(unarchRes.json().data.status).toBe('ACTIVE');

    // Delete parent blocked by child location -> 409 RESOURCE_IN_USE
    const delParentRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${parent.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delParentRes.statusCode).toBe(409);
    expect(delParentRes.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    // Delete child succeeds -> 200
    const delChildRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${child.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(delChildRes.statusCode).toBe(200);
    expect(delChildRes.json().data).toEqual({ id: child.id, deleted: true });

    // Register external reference checker blocking parent deletion
    let blockParent = true;
    const checker: LocationReferenceChecker = async (_tx, locId) =>
      blockParent && locId === parent.id;
    const unregister = registerLocationReferenceChecker(checker);

    try {
      const blockedByChecker = await app.inject({
        method: 'DELETE',
        url: `/api/v1/locations/${parent.id}`,
        headers: { cookie, 'idempotency-key': uuidv7() },
      });
      expect(blockedByChecker.statusCode).toBe(409);
      expect(blockedByChecker.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);
    } finally {
      blockParent = false;
      unregister();
    }

    // Verify PostgreSQL ON DELETE RESTRICT (23503) backup lock catches external FK
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS inventory._test_location_refs (
        location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT
      );
    `);
    await db.execute(sql`
      INSERT INTO inventory._test_location_refs (location_id) VALUES (${parent.id});
    `);

    const blockedByFk = await app.inject({
      method: 'DELETE',
      url: `/api/v1/locations/${parent.id}`,
      headers: { cookie, 'idempotency-key': uuidv7() },
    });
    expect(blockedByFk.statusCode).toBe(409);
    expect(blockedByFk.json().error.code).toBe(ERROR_CODES.RESOURCE_IN_USE);

    await outboxDispatcher.drainOutbox();
    expect(events).toEqual(
      expect.arrayContaining([
        'LocationCreated',
        'LocationArchived',
        'LocationUnarchived',
        'LocationDeleted',
      ]),
    );

    await app.close();
  });
});

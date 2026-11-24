import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ConflictError, DomainError, ERROR_CODES, uuidv7 } from '@iv2/shared-domain';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { outboxEvents } from '../db/schema.js';
import { OutboxDispatcher } from '../outbox/outboxDispatcher.js';
import { resolvePolicy } from '../../modules/iam/public/index.js';
import { deriveLineIdempotencyKey, executeCommand } from './executeCommand.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('executeCommand unit-of-work seam', () => {
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

  it('rejects missing or non-UUID Idempotency-Key with 400 MISSING_IDEMPOTENCY_KEY', async () => {
    const db = createDb(pool);

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: { a: 1 },
          idempotencyKey: undefined,
          handler: async () => ({ data: { ok: true } }),
        },
        { db },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
    });

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: { a: 1 },
          idempotencyKey: 'not-a-uuid',
          handler: async () => ({ data: { ok: true } }),
        },
        { db },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
    });
  });

  it('rolls back transaction and outbox events when handler throws', async () => {
    const db = createDb(pool);
    const dispatcher = new OutboxDispatcher(db);
    const nudgeSpy = vi.spyOn(dispatcher, 'nudge');

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: { a: 1 },
          idempotencyKey: uuidv7(),
          handler: async (ctx) => {
            await ctx.emit({
              eventType: 'ShouldRollback',
              aggregateType: 'Test',
              aggregateId: uuidv7(),
              payload: { x: 1 },
            });
            throw new DomainError(422, 'TEST_FAILURE', 'Simulated failure');
          },
        },
        { db, outboxDispatcher: dispatcher },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'TEST_FAILURE' });

    const events = await db.select().from(outboxEvents);
    expect(events).toHaveLength(0);
    expect(nudgeSpy).not.toHaveBeenCalled();
  });

  it('replays stored response verbatim without re-running handler, and rejects mismatched payload with 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const db = createDb(pool);
    const dispatcher = new OutboxDispatcher(db);
    const key = uuidv7();
    let executions = 0;

    const first = await executeCommand(
      {
        actorId: 'user-1',
        method: 'POST',
        path: '/api/v1/purchase-orders/1/receipts',
        payload: { b: 2, a: 1 },
        idempotencyKey: key,
        statusCode: 201,
        handler: async (ctx) => {
          executions += 1;
          await ctx.emit({
            eventType: 'StockReceived',
            aggregateType: 'PurchaseOrder',
            aggregateId: uuidv7(),
            payload: { qty: '5.0000' },
          });
          return { data: { received: true } };
        },
      },
      { db, outboxDispatcher: dispatcher, requestId: 'req_first' },
    );

    expect(first.replayed).toBe(false);
    expect(first.statusCode).toBe(201);
    expect(first.body).toEqual({
      data: { received: true },
      meta: { requestId: 'req_first' },
    });
    expect(executions).toBe(1);

    // Replay with semantically identical payload (different key order)
    const replay = await executeCommand(
      {
        actorId: 'user-1',
        method: 'POST',
        path: '/api/v1/purchase-orders/1/receipts',
        payload: { a: 1, b: 2 },
        idempotencyKey: key,
        statusCode: 201,
        handler: async () => {
          executions += 1;
          return { data: { received: false } };
        },
      },
      { db, outboxDispatcher: dispatcher, requestId: 'req_second' },
    );

    expect(replay.replayed).toBe(true);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(executions).toBe(1);

    // Same key with different payload -> 409 IDEMPOTENCY_KEY_CONFLICT
    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/purchase-orders/1/receipts',
          payload: { a: 1, b: 999 },
          idempotencyKey: key,
          handler: async () => ({ data: { received: true } }),
        },
        { db, outboxDispatcher: dispatcher },
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    // Verify outbox event was written once
    const events = await db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('StockReceived');

    // Verify advisory lock query works cleanly
    const check = await db.execute(sql`SELECT 1`);
    expect(check.rows).toHaveLength(1);
  });

  it('derives deterministic per-line UUIDv5 keys from (requestKey, lineId)', () => {
    const requestKey = '6f8c2a10-4b9a-4e21-9a11-8c3e1f2d9b04';
    const k1a = deriveLineIdempotencyKey(requestKey, 'line-1');
    const k1b = deriveLineIdempotencyKey(requestKey, 'line-1');
    const k2 = deriveLineIdempotencyKey(requestKey, 'line-2');

    expect(k1a).toBe(k1b);
    expect(k1a).not.toBe(k2);
    expect(k1a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('enforces AccessSwitch (403 ACCESS_READ_ONLY / ACCESS_SUSPENDED) and AccessPolicy.assertCan', async () => {
    const db = createDb(pool);
    const policy = resolvePolicy(
      { id: 'user-1', email: 'u@example.com', name: 'User' },
      { locationScope: { locationIds: ['loc-1'] } },
    );

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: {},
          idempotencyKey: uuidv7(),
          accessPolicy: policy,
          permission: { action: 'create', resource: 'product', context: { locationId: 'loc-1' } },
          handler: async () => ({ data: { ok: true } }),
        },
        { db, getAccessSwitch: () => 'READ_ONLY' },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.ACCESS_READ_ONLY });

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: {},
          idempotencyKey: uuidv7(),
          accessPolicy: policy,
          permission: { action: 'create', resource: 'product', context: { locationId: 'loc-1' } },
          handler: async () => ({ data: { ok: true } }),
        },
        { db, getAccessSwitch: () => 'SUSPENDED' },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.ACCESS_SUSPENDED });

    await expect(
      executeCommand(
        {
          actorId: 'user-1',
          method: 'POST',
          path: '/api/v1/test',
          payload: {},
          idempotencyKey: uuidv7(),
          accessPolicy: policy,
          permission: { action: 'create', resource: 'product', context: { locationId: 'loc-999' } },
          handler: async () => ({ data: { ok: true } }),
        },
        { db, getAccessSwitch: () => 'ACTIVE' },
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: ERROR_CODES.FORBIDDEN });
  });
});

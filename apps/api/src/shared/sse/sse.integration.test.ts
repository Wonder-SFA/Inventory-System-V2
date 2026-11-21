import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ERROR_CODES, SseInvalidateEventSchema, uuidv7 } from '@iv2/shared-domain';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { setAccessSwitch } from '../../modules/iam/public/index.js';
import { OutboxDispatcher } from '../outbox/index.js';
import { SseBroadcaster } from './sseBroadcaster.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const decoder = new TextDecoder();
  let accumulated = '';
  const deadline = Date.now() + timeoutMs;

  while (!predicate(accumulated)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for SSE chunk. Accumulated:\n${accumulated}`);
    }
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('SSE read timeout')), remaining);
      }),
    ]);
    if (result.done) {
      break;
    }
    accumulated += decoder.decode(result.value, { stream: true });
  }
  return accumulated;
}

describe('GET /api/v1/events/stream SSE integration', () => {
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

  async function setupAppAndUser(options: { keepaliveIntervalMs?: number } = {}) {
    const db = createDb(pool);
    const outboxDispatcher = new OutboxDispatcher(db);
    const sseBroadcaster = new SseBroadcaster({
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 25_000,
    });
    const app = buildApp({
      pool,
      db,
      outboxDispatcher,
      sseBroadcaster,
      nodeEnv: 'test',
    });

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Office Operator',
        email: 'operator@example.com',
        password: 'password1234',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const cookie = extractCookieHeader(signUpRes.headers['set-cookie']);

    return { db, outboxDispatcher, sseBroadcaster, app, cookie };
  }

  it('rejects unauthenticated requests with 401 and SUSPENDED requests with 403 ACCESS_SUSPENDED', async () => {
    const { db, app, cookie } = await setupAppAndUser();

    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/events/stream',
    });
    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.json().error.code).toBe(ERROR_CODES.UNAUTHENTICATED);

    await setAccessSwitch(db, 'SUSPENDED');
    const suspendedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/events/stream',
      headers: { cookie },
    });
    expect(suspendedRes.statusCode).toBe(403);
    expect(suspendedRes.json().error.code).toBe(ERROR_CODES.ACCESS_SUSPENDED);

    await app.close();
  });

  it('streams invalidation-only events after drainOutbox() in ACTIVE and READ_ONLY modes with zero quantities/costs/PII', async () => {
    const { db, outboxDispatcher, app, cookie } = await setupAppAndUser();
    await setAccessSwitch(db, 'READ_ONLY');

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();

    try {
      const sseRes = await fetch(`${address}/api/v1/events/stream`, {
        headers: { cookie },
        signal: controller.signal,
      });

      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
      expect(sseRes.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(sseRes.headers.get('x-accel-buffering')).toBe('no');

      // Switch back to ACTIVE to perform mutations
      await setAccessSwitch(db, 'ACTIVE');

      const uomRes = await app.inject({
        method: 'POST',
        url: '/api/v1/units-of-measure',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: { code: 'PCS', name: 'Pieces' },
      });
      expect(uomRes.statusCode).toBe(201);
      const uomId = uomRes.json().data.id as string;

      const locRes = await app.inject({
        method: 'POST',
        url: '/api/v1/locations',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: { name: 'Main Warehouse', type: 'WAREHOUSE' },
      });
      expect(locRes.statusCode).toBe(201);
      const locationId = locRes.json().data.id as string;

      const prodRes = await app.inject({
        method: 'POST',
        url: '/api/v1/products',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: { name: 'Widget' },
      });
      expect(prodRes.statusCode).toBe(201);
      const productId = prodRes.json().data.id as string;

      const skuRes = await app.inject({
        method: 'POST',
        url: '/api/v1/skus',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: {
          productId,
          unitOfMeasureId: uomId,
          code: 'WDG-1',
          name: 'Widget Standard',
        },
      });
      expect(skuRes.statusCode).toBe(201);
      const skuId = skuRes.json().data.id as string;

      const moveRes = await app.inject({
        method: 'POST',
        url: '/api/v1/stock-movements/adjustments',
        headers: { cookie, 'idempotency-key': uuidv7() },
        payload: {
          skuId,
          locationId,
          quantityDelta: '15.0000',
          reasonCategory: 'STOCK_COUNT',
          unitCost: '42.5000',
          note: 'Confidential supplier invoice',
        },
      });
      expect(moveRes.statusCode).toBe(201);

      const reader = sseRes.body!.getReader();
      await outboxDispatcher.drainOutbox();

      const rawText = await readUntil(reader, (acc) => acc.includes('"stock-balances"'));
      expect(rawText).toContain('event: invalidate\n');
      expect(rawText).not.toContain('15.0000');
      expect(rawText).not.toContain('42.5000');
      expect(rawText).not.toContain('Confidential');
      expect(rawText).not.toContain('operator@example.com');

      const dataLines = rawText
        .split('\n\n')
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith('event: invalidate'))
        .map((frame) => {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          return SseInvalidateEventSchema.parse(JSON.parse(dataLine!.slice(6)));
        });

      const stockInvalidation = dataLines.find((e) => e.topics.includes('stock-balances'));
      expect(stockInvalidation).toBeDefined();
      expect(stockInvalidation).toEqual({
        seqId: expect.any(Number),
        topics: ['stock-balances', 'stock-movements'],
        locationIds: [locationId],
        skuIds: [skuId],
      });

      reader.releaseLock();
    } finally {
      controller.abort();
      await outboxDispatcher.stop();
      await app.close();
    }
  });

  it('enforces 5-stream-per-user cap with 429 and frees slots when a stream closes', async () => {
    const { app, cookie } = await setupAppAndUser();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controllers: AbortController[] = [];

    try {
      for (let i = 0; i < 5; i += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const res = await fetch(`${address}/api/v1/events/stream`, {
          headers: { cookie },
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        // Consume initial comment so connection is established
        const reader = res.body!.getReader();
        await reader.read();
        reader.releaseLock();
      }

      const sixthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/events/stream',
        headers: { cookie },
      });
      expect(sixthRes.statusCode).toBe(429);
      expect(sixthRes.json().error.code).toBe(ERROR_CODES.TOO_MANY_SSE_CONNECTIONS);

      // Close one stream and wait briefly for socket close propagation
      controllers[0]!.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const replacementController = new AbortController();
      controllers.push(replacementController);
      const replacementRes = await fetch(`${address}/api/v1/events/stream`, {
        headers: { cookie },
        signal: replacementController.signal,
      });
      expect(replacementRes.status).toBe(200);
    } finally {
      for (const c of controllers) {
        c.abort();
      }
      await app.close();
    }
  });

  it('emits keepalive comments on the stream', async () => {
    const { app, cookie, outboxDispatcher } = await setupAppAndUser({ keepaliveIntervalMs: 50 });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();

    try {
      const sseRes = await fetch(`${address}/api/v1/events/stream`, {
        headers: { cookie },
        signal: controller.signal,
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const text = await readUntil(reader, (acc) => acc.includes(': keepalive\n\n'));
      expect(text).toContain(': keepalive\n\n');
      reader.releaseLock();
    } finally {
      controller.abort();
      await outboxDispatcher.stop();
      await app.close();
    }
  });
});

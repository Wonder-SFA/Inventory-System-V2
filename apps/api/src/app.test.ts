import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import {
  CursorPaginationQuerySchema,
  ERROR_CODES,
  createApiPaginatedSchema,
  createApiSuccessSchema,
  uuidv7,
  zQuantity,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from './app.js';
import { OutboxDispatcher } from './shared/outbox/outboxDispatcher.js';
import { executeCommand } from './shared/command/executeCommand.js';
import { decodeCursor, encodeCursor, paginateKeysetResult } from './shared/http/pagination.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('API Spine (Fastify, OpenAPI, Envelopes, Pagination, Rate Limiting, Probes)', () => {
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

  describe('Operational probes (/health & /ready)', () => {
    it('returns 200 on GET /health and GET /ready when DB is healthy', async () => {
      const app = buildApp({ pool });
      try {
        const healthRes = await app.inject({ method: 'GET', url: '/health' });
        expect(healthRes.statusCode).toBe(200);
        expect(healthRes.json()).toEqual({
          status: 'ok',
          modules: ['catalog', 'inventory', 'orders', 'iam'],
        });

        const readyRes = await app.inject({ method: 'GET', url: '/ready' });
        expect(readyRes.statusCode).toBe(200);
        expect(readyRes.json()).toEqual({ status: 'ready' });
      } finally {
        await app.close();
      }
    });

    it('returns 503 on GET /ready when DB pool query fails', async () => {
      const failingPool = {
        query: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as unknown as Pool;

      const app = buildApp({ pool: failingPool });
      try {
        const readyRes = await app.inject({ method: 'GET', url: '/ready' });
        expect(readyRes.statusCode).toBe(503);
        expect(readyRes.json()).toEqual({ status: 'not_ready' });
      } finally {
        await app.close();
      }
    });
  });

  describe('OpenAPI /docs gating', () => {
    it('mounts /docs when NODE_ENV !== production and hides /docs in production', async () => {
      const devApp = buildApp({ pool, nodeEnv: 'development' });
      try {
        const docsRes = await devApp.inject({ method: 'GET', url: '/docs/json' });
        expect(docsRes.statusCode).toBe(200);
        const spec = docsRes.json();
        expect(spec.openapi).toBe('3.1.0');
      } finally {
        await devApp.close();
      }

      const prodApp = buildApp({ pool, nodeEnv: 'production' });
      try {
        const docsRes = await prodApp.inject({ method: 'GET', url: '/docs/json' });
        expect(docsRes.statusCode).toBe(404);
      } finally {
        await prodApp.close();
      }
    });
  });

  describe('Uniform envelopes, Decimal4 validation, and executeCommand over HTTP', () => {
    async function createAuthHeaders(app: FastifyInstance): Promise<Record<string, string>> {
      const signUpRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: {
          email: `spine-${uuidv7()}@inventory.local`,
          password: 'password1234',
          name: 'Spine Test User',
        },
      });
      const token =
        (signUpRes.headers['set-auth-token'] as string | undefined) ??
        (signUpRes.json() as { token?: string }).token;
      if (token) {
        return { authorization: `Bearer ${token}` };
      }
      const setCookie = signUpRes.headers['set-cookie'];
      const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      return { cookie: list.map((c) => c.split(';')[0]).join('; ') };
    }

    function mountTestRoutes(app: FastifyInstance, db: ReturnType<typeof createDb>, dispatcher: OutboxDispatcher) {
      const typed = app.withTypeProvider<ZodTypeProvider>();

      typed.post(
        '/api/v1/test-commands',
        {
          schema: {
            body: z.object({
              quantity: zQuantity,
              note: z.string().optional(),
            }),
            response: {
              201: createApiSuccessSchema(z.object({ acceptedQuantity: z.string() })),
            },
          },
        },
        async (request, reply) => {
          const result = await executeCommand(
            {
              actorId: 'test-user',
              method: request.method,
              path: request.url,
              payload: request.body,
              idempotencyKey: request.headers['idempotency-key'] as string | undefined,
              statusCode: 201,
              handler: async (ctx) => {
                await ctx.emit({
                  eventType: 'TestCommandExecuted',
                  aggregateType: 'Test',
                  aggregateId: uuidv7(),
                  payload: { quantity: request.body.quantity },
                });
                return {
                  data: { acceptedQuantity: request.body.quantity },
                };
              },
            },
            { db, outboxDispatcher: dispatcher, requestId: request.id },
          );
          return reply.status(result.statusCode).send(result.body);
        },
      );

      typed.get(
        '/api/v1/test-items',
        {
          schema: {
            querystring: CursorPaginationQuerySchema,
            response: {
              200: createApiPaginatedSchema(z.object({ id: z.string(), createdAt: z.string() })),
            },
          },
        },
        async (request, reply) => {
          const decoded = request.query.cursor ? decodeCursor(request.query.cursor) : null;
          const allRows = [
            { id: '0195a1b4-0000-7000-8000-000000000003', createdAt: new Date('2026-01-03T00:00:00.000Z') },
            { id: '0195a1b4-0000-7000-8000-000000000002', createdAt: new Date('2026-01-02T00:00:00.000Z') },
            { id: '0195a1b4-0000-7000-8000-000000000001', createdAt: new Date('2026-01-02T00:00:00.000Z') },
          ];
          const filtered = decoded
            ? allRows.filter(
                (r) =>
                  r.createdAt.getTime() < decoded.createdAt.getTime() ||
                  (r.createdAt.getTime() === decoded.createdAt.getTime() && r.id < decoded.id),
              )
            : allRows;

          const paged = paginateKeysetResult(filtered, request.query.limit);
          return reply.status(200).send({
            data: paged.items.map((i) => ({ id: i.id, createdAt: i.createdAt.toISOString() })),
            page: {
              limit: request.query.limit,
              nextCursor: paged.nextCursor,
              hasMore: paged.hasMore,
            },
            meta: { requestId: request.id },
          });
        },
      );

      app.get('/api/v1/test-boom', async () => {
        throw new Error('SELECT * FROM secret_table WHERE password = 123');
      });
    }

    it('rejects >4 decimal places with 422 DECIMAL_PRECISION_EXCEEDED', async () => {
      const db = createDb(pool);
      const dispatcher = new OutboxDispatcher(db);
      const app = buildApp({ pool, db, outboxDispatcher: dispatcher });
      mountTestRoutes(app, db, dispatcher);

      try {
        const authHeaders = await createAuthHeaders(app);
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/test-commands',
          headers: { ...authHeaders, 'idempotency-key': uuidv7() },
          payload: { quantity: '1.23456' },
        });

        expect(res.statusCode).toBe(422);
        const body = res.json();
        expect(body.error.code).toBe(ERROR_CODES.DECIMAL_PRECISION_EXCEEDED);
        expect(body.error.requestId).toMatch(/^req_/);
      } finally {
        await app.close();
      }
    });

    it('executes command, replays idempotency key, and rejects conflict with 409', async () => {
      const db = createDb(pool);
      const dispatcher = new OutboxDispatcher(db);
      const emitted: string[] = [];
      dispatcher.registerConsumer('test-consumer', async (ev) => {
        emitted.push(ev.eventType);
      });

      const app = buildApp({ pool, db, outboxDispatcher: dispatcher });
      mountTestRoutes(app, db, dispatcher);

      try {
        const authHeaders = await createAuthHeaders(app);
        const key = uuidv7();
        const res1 = await app.inject({
          method: 'POST',
          url: '/api/v1/test-commands',
          headers: { ...authHeaders, 'idempotency-key': key },
          payload: { quantity: '10.5' },
        });
        expect(res1.statusCode).toBe(201);
        expect(res1.json().data.acceptedQuantity).toBe('10.5000');

        const res2 = await app.inject({
          method: 'POST',
          url: '/api/v1/test-commands',
          headers: { ...authHeaders, 'idempotency-key': key },
          payload: { quantity: '10.5' },
        });
        expect(res2.statusCode).toBe(201);
        expect(res2.json()).toEqual(res1.json());

        const conflictRes = await app.inject({
          method: 'POST',
          url: '/api/v1/test-commands',
          headers: { ...authHeaders, 'idempotency-key': key },
          payload: { quantity: '99.0' },
        });
        expect(conflictRes.statusCode).toBe(409);
        expect(conflictRes.json().error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT);

        await dispatcher.drainOutbox();
        expect(emitted).toEqual(['TestCommandExecuted']);
      } finally {
        await app.close();
      }
    });

    it('hides raw SQL and stack traces on 500 INTERNAL_ERROR', async () => {
      const db = createDb(pool);
      const dispatcher = new OutboxDispatcher(db);
      const app = buildApp({ pool, db, outboxDispatcher: dispatcher });
      mountTestRoutes(app, db, dispatcher);

      try {
        const authHeaders = await createAuthHeaders(app);
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/test-boom',
          headers: authHeaders,
        });
        expect(res.statusCode).toBe(500);
        const body = res.json();
        expect(body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
        expect(body.error.message).not.toContain('SELECT');
        expect(JSON.stringify(body)).not.toContain('secret_table');
      } finally {
        await app.close();
      }
    });

    it('supports keyset cursor pagination, defaults limit to 50, rejects limit > 100 with 422, and rejects bad cursor with 400 INVALID_CURSOR', async () => {
      const db = createDb(pool);
      const dispatcher = new OutboxDispatcher(db);
      const app = buildApp({ pool, db, outboxDispatcher: dispatcher });
      mountTestRoutes(app, db, dispatcher);

      try {
        const authHeaders = await createAuthHeaders(app);
        const page1 = await app.inject({
          method: 'GET',
          url: '/api/v1/test-items?limit=2',
          headers: authHeaders,
        });
        expect(page1.statusCode).toBe(200);
        const p1Body = page1.json();
        expect(p1Body.data).toHaveLength(2);
        expect(p1Body.page.hasMore).toBe(true);
        expect(p1Body.page.nextCursor).toBeTypeOf('string');

        const page2 = await app.inject({
          method: 'GET',
          url: `/api/v1/test-items?limit=2&cursor=${encodeURIComponent(p1Body.page.nextCursor)}`,
          headers: authHeaders,
        });
        expect(page2.statusCode).toBe(200);
        const p2Body = page2.json();
        expect(p2Body.data).toHaveLength(1);
        expect(p2Body.page.hasMore).toBe(false);
        expect(p2Body.page.nextCursor).toBeNull();

        const defaultLimit = await app.inject({
          method: 'GET',
          url: '/api/v1/test-items',
          headers: authHeaders,
        });
        expect(defaultLimit.statusCode).toBe(200);
        expect(defaultLimit.json().page.limit).toBe(50);

        const overLimit = await app.inject({
          method: 'GET',
          url: '/api/v1/test-items?limit=101',
          headers: authHeaders,
        });
        expect(overLimit.statusCode).toBe(422);

        const badCursor = await app.inject({
          method: 'GET',
          url: '/api/v1/test-items?cursor=not-valid',
          headers: authHeaders,
        });
        expect(badCursor.statusCode).toBe(400);
        expect(badCursor.json().error.code).toBe(ERROR_CODES.INVALID_CURSOR);

        // Verify encode/decode round-trip
        const encoded = encodeCursor('2026-01-02T00:00:00.000Z', '0195a1b4-0000-7000-8000-000000000002');
        const decoded = decodeCursor(encoded);
        expect(decoded.id).toBe('0195a1b4-0000-7000-8000-000000000002');
        expect(decoded.createdAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
      } finally {
        await app.close();
      }
    });
  });

  describe('Tiered rate limiting', () => {
    it('emits X-RateLimit-* headers and returns 429 RATE_LIMITED with Retry-After when exceeded', async () => {
      const app = buildApp({
        pool,
        rateLimit: {
          enabled: true,
          read: { max: 2, timeWindow: '1 minute' },
        },
      });
      await app.register(async (instance) => {
        instance.get('/api/v1/ping', async (req) => ({
          data: { pong: true },
          meta: { requestId: req.id },
        }));
      });

      try {
        const r1 = await app.inject({ method: 'GET', url: '/api/v1/ping' });
        expect(r1.statusCode).toBe(200);
        expect(r1.headers['x-ratelimit-limit']).toBe('2');
        expect(r1.headers['x-ratelimit-remaining']).toBe('1');

        const r2 = await app.inject({ method: 'GET', url: '/api/v1/ping' });
        expect(r2.statusCode).toBe(200);
        expect(r2.headers['x-ratelimit-remaining']).toBe('0');

        const r3 = await app.inject({ method: 'GET', url: '/api/v1/ping' });
        expect(r3.statusCode).toBe(429);
        expect(r3.headers['retry-after']).toBeDefined();
        expect(r3.json().error.code).toBe(ERROR_CODES.RATE_LIMITED);
      } finally {
        await app.close();
      }
    });
  });
});

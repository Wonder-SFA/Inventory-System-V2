import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { ERROR_CODES, uuidv7 } from '@iv2/shared-domain';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { executeCommand } from '../../shared/command/index.js';
import { iamUsers } from './db/index.js';
import { setAccessSwitch } from './public/index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

function extractCookieHeader(setCookieHeaders: string | string[] | undefined): string {
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  return list.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('iam auth, session, and Access Switch integration', () => {
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

  function createTestApp() {
    const db = createDb(pool);
    const app = buildApp({ pool, db, nodeEnv: 'test' });

    // Register test-only /api/v1/* routes to verify GET and POST under Access Switch states
    app.get('/api/v1/_test/read', async (request) => {
      return {
        data: {
          actorId: request.accessPolicy?.actor.id,
          accessSwitch: request.accessSwitch,
        },
        meta: { requestId: request.id },
      };
    });

    app.post('/api/v1/_test/write', async (request, reply) => {
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: request.body ?? {},
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'create', resource: 'product' },
          handler: async () => ({
            data: { created: true },
            statusCode: 201,
          }),
        },
        {
          db,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    });

    return { app, db };
  }

  it('rejects unauthenticated requests to /api/v1/* with 401 UNAUTHENTICATED', async () => {
    const { app } = createTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
    expect(body.error.requestId).toBeTruthy();

    await app.close();
  });

  it('supports sign-up, sign-in with HttpOnly SameSite=Lax cookies, Bearer token auth, and sign-out', async () => {
    const { app } = createTestApp();

    // Sign up
    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: 'clerk@inventory.local',
        password: 'password1234',
        name: 'Office Clerk',
      },
    });
    expect(signUpRes.statusCode).toBe(200);
    const setCookies = signUpRes.headers['set-cookie'];
    expect(setCookies).toBeDefined();
    const rawCookies = Array.isArray(setCookies) ? setCookies : [setCookies!];
    expect(rawCookies.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);

    const cookieHeader = extractCookieHeader(setCookies);
    expect(cookieHeader).toContain('better-auth.session_token');

    // Cookie auth -> GET /api/v1/session
    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json()).toMatchObject({
      data: {
        user: {
          email: 'clerk@inventory.local',
          name: 'Office Clerk',
        },
        accessSwitch: 'ACTIVE',
        permissions: {
          allLocations: true,
          canViewCosts: true,
        },
      },
    });

    // Sign in and capture Bearer token
    const signInRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: {
        email: 'clerk@inventory.local',
        password: 'password1234',
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const signInBody = signInRes.json() as { token?: string };
    const bearerToken =
      (signInRes.headers['set-auth-token'] as string | undefined) ?? signInBody.token;
    expect(bearerToken).toBeTruthy();

    // Bearer auth -> GET /api/v1/session
    const bearerSessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    expect(bearerSessionRes.statusCode).toBe(200);
    expect(bearerSessionRes.json().data.user.email).toBe('clerk@inventory.local');

    // Sign out with cookie
    const signOutCookie = extractCookieHeader(signInRes.headers['set-cookie']);
    const signOutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: signOutCookie },
    });
    expect(signOutRes.statusCode).toBe(200);

    // Session should now be invalid
    const afterSignOut = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: signOutCookie },
    });
    expect(afterSignOut.statusCode).toBe(401);
    expect(afterSignOut.json().error.code).toBe(ERROR_CODES.UNAUTHENTICATED);

    await app.close();
  });

  it('enforces READ_ONLY (GET succeeds, POST fails with 403 ACCESS_READ_ONLY, sign-out succeeds)', async () => {
    const { app, db } = createTestApp();

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: 'reader@inventory.local',
        password: 'password1234',
        name: 'Reader User',
      },
    });
    const cookieHeader = extractCookieHeader(signUpRes.headers['set-cookie']);

    await setAccessSwitch(db, 'READ_ONLY');

    // GET /api/v1/session succeeds and reports READ_ONLY
    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json().data.accessSwitch).toBe('READ_ONLY');

    // GET /api/v1/_test/read succeeds
    const readRes = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/read',
      headers: { cookie: cookieHeader },
    });
    expect(readRes.statusCode).toBe(200);

    // POST /api/v1/_test/write fails with 403 ACCESS_READ_ONLY
    const writeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/_test/write',
      headers: {
        cookie: cookieHeader,
        'idempotency-key': uuidv7(),
      },
      payload: { name: 'Widget' },
    });
    expect(writeRes.statusCode).toBe(403);
    expect(writeRes.json().error.code).toBe(ERROR_CODES.ACCESS_READ_ONLY);

    // Sign-out still succeeds
    const signOutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: cookieHeader },
    });
    expect(signOutRes.statusCode).toBe(200);

    await app.close();
  });

  it('enforces SUSPENDED (/api/v1/session, /health, and sign-out succeed; other /api/v1/* fail with 403 ACCESS_SUSPENDED)', async () => {
    const { app, db } = createTestApp();

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        email: 'suspended@inventory.local',
        password: 'password1234',
        name: 'Suspended User',
      },
    });
    const cookieHeader = extractCookieHeader(signUpRes.headers['set-cookie']);

    await setAccessSwitch(db, 'SUSPENDED');

    // /health succeeds
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);

    // GET /api/v1/session succeeds and reports SUSPENDED
    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader },
    });
    expect(sessionRes.statusCode).toBe(200);
    expect(sessionRes.json().data.accessSwitch).toBe('SUSPENDED');

    // GET /api/v1/_test/read fails with 403 ACCESS_SUSPENDED
    const readRes = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/read',
      headers: { cookie: cookieHeader },
    });
    expect(readRes.statusCode).toBe(403);
    expect(readRes.json().error.code).toBe(ERROR_CODES.ACCESS_SUSPENDED);

    // POST /api/v1/_test/write fails with 403 ACCESS_SUSPENDED
    const writeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/_test/write',
      headers: {
        cookie: cookieHeader,
        'idempotency-key': uuidv7(),
      },
      payload: { name: 'Widget' },
    });
    expect(writeRes.statusCode).toBe(403);
    expect(writeRes.json().error.code).toBe(ERROR_CODES.ACCESS_SUSPENDED);

    // Sign-out still succeeds
    const signOutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: cookieHeader },
    });
    expect(signOutRes.statusCode).toBe(200);

    await app.close();
  });

  describe('Lot-picking & negative-stock policy configuration API', () => {
    async function signUpUser(
      app: ReturnType<typeof buildApp>,
      db: ReturnType<typeof createDb>,
      email: string,
      name: string,
      role: 'OWNER' | 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER',
    ) {
      const signUpRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        payload: { email, password: 'password1234', name },
      });
      expect(signUpRes.statusCode).toBe(200);
      const userId = (signUpRes.json() as { user: { id: string } }).user.id;
      await db.update(iamUsers).set({ role }).where(eq(iamUsers.id, userId));
      return {
        userId,
        cookie: extractCookieHeader(signUpRes.headers['set-cookie']),
      };
    }

    it('defaults effective lot policy and allows OWNER/SUPER_ADMIN to configure cascading policies with audit logs', async () => {
      const { app, db } = createTestApp();
      const owner = await signUpUser(app, db, 'owner@inventory.local', 'Owner User', 'OWNER');
      const superAdmin = await signUpUser(
        app,
        db,
        'super@inventory.local',
        'Super Admin',
        'SUPER_ADMIN',
      );
      const staff = await signUpUser(app, db, 'staff@inventory.local', 'Staff User', 'STAFF');
      const locA = uuidv7();
      const locB = uuidv7();

      // Default effective policy
      const defaultRes = await app.inject({
        method: 'GET',
        url: '/api/v1/iam/lot-policies/effective',
        headers: { cookie: staff.cookie },
      });
      expect(defaultRes.statusCode).toBe(200);
      expect(defaultRes.json().data).toEqual({
        pickingMode: 'AUTO_FEFO',
        allowExpiredLotOverride: false,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });

      // OWNER configures COMPANY default
      const companyKey = uuidv7();
      const companyRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: owner.cookie, 'idempotency-key': companyKey },
        payload: {
          scopeType: 'COMPANY',
          scopeId: '',
          pickingMode: 'MANUAL_OPTIONAL',
          allowExpiredLotOverride: false,
          negativeStockPolicy: 'STRICT_BLOCK',
        },
      });
      expect(companyRes.statusCode).toBe(200);
      expect(companyRes.json().data).toMatchObject({
        scopeType: 'COMPANY',
        scopeId: '',
        pickingMode: 'MANUAL_OPTIONAL',
        allowExpiredLotOverride: false,
        negativeStockPolicy: 'STRICT_BLOCK',
      });

      // Idempotent replay with same key does not create duplicate audit log
      const replayRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: owner.cookie, 'idempotency-key': companyKey },
        payload: {
          scopeType: 'COMPANY',
          scopeId: '',
          pickingMode: 'MANUAL_OPTIONAL',
          allowExpiredLotOverride: false,
          negativeStockPolicy: 'STRICT_BLOCK',
        },
      });
      expect(replayRes.statusCode).toBe(200);

      // SUPER_ADMIN configures LOCATION, ROLE, and USER overrides
      const locRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: superAdmin.cookie, 'idempotency-key': uuidv7() },
        payload: {
          scopeType: 'LOCATION',
          scopeId: locA,
          pickingMode: 'MANUAL_REQUIRED',
          allowExpiredLotOverride: null,
          negativeStockPolicy: null,
        },
      });
      expect(locRes.statusCode).toBe(200);

      const roleRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: superAdmin.cookie, 'idempotency-key': uuidv7() },
        payload: {
          scopeType: 'ROLE',
          scopeId: 'STAFF',
          pickingMode: null,
          allowExpiredLotOverride: true,
          negativeStockPolicy: null,
        },
      });
      expect(roleRes.statusCode).toBe(200);

      // Update COMPANY policy to verify beforeState/afterState in audit log
      const companyUpdateRes = await app.inject({
        method: 'PUT',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: owner.cookie, 'idempotency-key': uuidv7() },
        payload: {
          scopeType: 'COMPANY',
          scopeId: '',
          pickingMode: 'AUTO_FEFO',
          allowExpiredLotOverride: false,
          negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
        },
      });
      expect(companyUpdateRes.statusCode).toBe(200);

      // Staff effective policy at locA:
      // pickingMode from LOCATION (MANUAL_REQUIRED)
      // allowExpiredLotOverride from ROLE (true)
      // negativeStockPolicy from COMPANY (FLEXIBLE_UNASSIGNED)
      const staffLocARes = await app.inject({
        method: 'GET',
        url: `/api/v1/iam/lot-policies/effective?locationId=${locA}`,
        headers: { cookie: staff.cookie },
      });
      expect(staffLocARes.statusCode).toBe(200);
      expect(staffLocARes.json().data).toEqual({
        pickingMode: 'MANUAL_REQUIRED',
        allowExpiredLotOverride: true,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });

      // Staff effective policy at locB falls back to COMPANY for pickingMode
      const staffLocBRes = await app.inject({
        method: 'GET',
        url: `/api/v1/iam/lot-policies/effective?locationId=${locB}`,
        headers: { cookie: staff.cookie },
      });
      expect(staffLocBRes.statusCode).toBe(200);
      expect(staffLocBRes.json().data).toEqual({
        pickingMode: 'AUTO_FEFO',
        allowExpiredLotOverride: true,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });

      // List all configured policies
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/iam/lot-policies',
        headers: { cookie: owner.cookie },
      });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().data).toHaveLength(3);

      // Audit logs recorded 4 mutations (replay did not duplicate)
      const auditRes = await app.inject({
        method: 'GET',
        url: '/api/v1/iam/audit-logs',
        headers: { cookie: owner.cookie },
      });
      expect(auditRes.statusCode).toBe(200);
      expect(auditRes.json().page).toMatchObject({
        hasMore: false,
        nextCursor: null,
      });
      const logs = auditRes.json().data as Array<{
        action: string;
        resourceType: string;
        resourceId: string;
        beforeState: Record<string, unknown> | null;
        afterState: Record<string, unknown> | null;
      }>;
      expect(logs).toHaveLength(4);
      const latestCompanyLog = logs[0]!;
      expect(latestCompanyLog.action).toBe('UPSERT_LOT_POLICY');
      expect(latestCompanyLog.resourceType).toBe('lot_policy');
      expect(latestCompanyLog.resourceId).toBe('COMPANY:');
      expect(latestCompanyLog.beforeState).toMatchObject({
        pickingMode: 'MANUAL_OPTIONAL',
        negativeStockPolicy: 'STRICT_BLOCK',
      });
      expect(latestCompanyLog.afterState).toMatchObject({
        pickingMode: 'AUTO_FEFO',
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });

      await app.close();
    });

    it('rejects lot policy mutations from unauthorized roles with 403 FORBIDDEN', async () => {
      const { app, db } = createTestApp();
      const admin = await signUpUser(app, db, 'admin-role@inventory.local', 'Admin User', 'ADMIN');
      const manager = await signUpUser(
        app,
        db,
        'manager-role@inventory.local',
        'Manager User',
        'MANAGER',
      );
      const staff = await signUpUser(app, db, 'staff-role@inventory.local', 'Staff User', 'STAFF');
      const viewer = await signUpUser(
        app,
        db,
        'viewer-role@inventory.local',
        'Viewer User',
        'VIEWER',
      );

      for (const user of [admin, manager, staff, viewer]) {
        const res = await app.inject({
          method: 'PUT',
          url: '/api/v1/iam/lot-policies',
          headers: { cookie: user.cookie, 'idempotency-key': uuidv7() },
          payload: {
            scopeType: 'COMPANY',
            scopeId: '',
            pickingMode: 'MANUAL_REQUIRED',
          },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe(ERROR_CODES.FORBIDDEN);
      }

      await app.close();
    });
  });
});

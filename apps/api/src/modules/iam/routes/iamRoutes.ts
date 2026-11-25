import type { Database } from '@iv2/db';
import {
  CursorPaginationQuerySchema,
  ERROR_CODES,
  EffectiveLotPolicyQuerySchema,
  ForbiddenError,
  UnauthorizedError,
  UpsertLotPolicyInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { executeCommand } from '../../../shared/command/index.js';
import {
  type AuthInstance,
  assertCanManageLotPolicies,
  getAccessSwitch,
  getUserRole,
  listAuditLogs,
  listLotPolicies,
  resolvePolicy,
  upsertLotPolicy,
} from '../domain/index.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function toWebHeaders(rawHeaders: FastifyRequest['headers'], omitContentLength = false): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) {
      continue;
    }
    if (omitContentLength && key.toLowerCase() === 'content-length') {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function toWebRequest(request: FastifyRequest): Request {
  const host = request.headers.host ?? 'localhost:3001';
  const url = new URL(request.url, `${request.protocol}://${host}`);
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && request.body !== undefined;
  const bodyText = hasBody
    ? typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body)
    : undefined;

  return new Request(url, {
    method,
    headers: toWebHeaders(request.headers, hasBody),
    ...(bodyText !== undefined ? { body: bodyText } : {}),
  });
}

export interface RegisterIamRoutesOptions {
  db: Database;
  auth: AuthInstance;
}

export function registerIamRoutes(
  app: FastifyInstance,
  options: RegisterIamRoutesOptions,
): void {
  const { db, auth } = options;

  // Mount Better Auth endpoints at /api/auth/*
  app.all('/api/auth/*', async (request, reply) => {
    const webRequest = toWebRequest(request);
    const response = await auth.handler(webRequest);

    reply.status(response.status);

    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) {
      reply.header('set-cookie', setCookies);
    }

    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie' || lower === 'content-length') {
        return;
      }
      reply.header(key, value);
    });

    const body = await response.text();
    return reply.send(body.length > 0 ? body : null);
  });

  // Enforce Better Auth session + iam Access Switch on all /api/v1/* routes
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/v1/')) {
      return;
    }

    const session = await auth.api.getSession({
      headers: toWebHeaders(request.headers),
    });

    if (!session?.user) {
      throw new UnauthorizedError('Authentication required', ERROR_CODES.UNAUTHENTICATED);
    }

    const [role, lotPolicies, accessSwitch] = await Promise.all([
      getUserRole(db, session.user.id),
      listLotPolicies(db),
      getAccessSwitch(db),
    ]);

    const policy = resolvePolicy(
      {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role,
      },
      { lotPolicies },
    );

    request.accessPolicy = policy;
    request.accessSwitch = accessSwitch;

    // /api/v1/session remains accessible in SUSPENDED & READ_ONLY so UI can render status banners
    if (path === '/api/v1/session') {
      return;
    }

    if (accessSwitch === 'SUSPENDED') {
      throw new ForbiddenError(ERROR_CODES.ACCESS_SUSPENDED, 'Instance access is suspended');
    }

    if (accessSwitch === 'READ_ONLY' && MUTATING_METHODS.has(request.method.toUpperCase())) {
      throw new ForbiddenError(
        ERROR_CODES.ACCESS_READ_ONLY,
        'Mutations are blocked while system is in read-only mode',
      );
    }
  });

  // Current authenticated session + Access Switch + permissions
  app.get('/api/v1/session', async (request) => {
    const policy = request.accessPolicy!;
    const accessSwitch = request.accessSwitch ?? 'ACTIVE';

    return {
      data: {
        user: policy.actor,
        accessSwitch,
        permissions: {
          allLocations: 'allLocations' in policy.locationScope && policy.locationScope.allLocations,
          canViewCosts: policy.canViewCosts,
        },
      },
      meta: {
        requestId: request.id,
      },
    };
  });

  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List configured lot policies
  typedApp.get('/api/v1/iam/lot-policies', async (request) => {
    const policies = await listLotPolicies(db);
    return {
      data: policies,
      meta: { requestId: request.id },
    };
  });

  // Resolve effective lot policy for the current actor (optionally scoped to a location)
  typedApp.get(
    '/api/v1/iam/lot-policies/effective',
    {
      schema: {
        querystring: EffectiveLotPolicyQuerySchema,
      },
    },
    async (request) => {
      const effective = request.accessPolicy!.resolveLotPolicy({
        locationId: request.query.locationId,
      });
      return {
        data: effective,
        meta: { requestId: request.id },
      };
    },
  );

  // Upsert a lot policy at COMPANY, LOCATION, ROLE, or USER scope (OWNER / SUPER_ADMIN only)
  typedApp.put(
    '/api/v1/iam/lot-policies',
    {
      schema: {
        body: UpsertLotPolicyInputSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: request.body,
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          requireIdempotencyKey: false,
          accessPolicy: policy,
          authorize: () => assertCanManageLotPolicies(policy),
          handler: async (ctx) => {
            const saved = await upsertLotPolicy(ctx.tx, policy.actor.id, request.body);
            return { data: saved, statusCode: 200 };
          },
        },
        {
          db,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // List IAM audit logs (OWNER / SUPER_ADMIN only)
  typedApp.get(
    '/api/v1/iam/audit-logs',
    {
      schema: {
        querystring: CursorPaginationQuerySchema,
      },
    },
    async (request) => {
      assertCanManageLotPolicies(request.accessPolicy!);
      const query = request.query;
      const result = await listAuditLogs(db, query);
      return {
        data: result.items,
        page: {
          limit: query.limit,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
        meta: { requestId: request.id },
      };
    },
  );
}

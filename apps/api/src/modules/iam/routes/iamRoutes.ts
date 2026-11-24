import type { Database } from '@iv2/db';
import { ERROR_CODES, ForbiddenError, UnauthorizedError } from '@iv2/shared-domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type AuthInstance,
  getAccessSwitch,
  resolvePolicy,
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

    const policy = resolvePolicy({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    });
    const accessSwitch = await getAccessSwitch(db);

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
}

import rateLimit from '@fastify/rate-limit';
import { RateLimitedError } from '@iv2/shared-domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateLimitTier {
  max: number;
  timeWindow: string | number;
}

export interface RateLimitOptions {
  enabled?: boolean | undefined;
  auth?: Partial<RateLimitTier> | undefined;
  mutation?: Partial<RateLimitTier> | undefined;
  read?: Partial<RateLimitTier> | undefined;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function resolveTier(
  request: FastifyRequest,
  tiers: { auth: RateLimitTier; mutation: RateLimitTier; read: RateLimitTier },
): { name: 'auth' | 'mutation' | 'read'; tier: RateLimitTier } {
  if (request.url.startsWith('/api/auth')) {
    return { name: 'auth', tier: tiers.auth };
  }
  if (MUTATION_METHODS.has(request.method)) {
    return { name: 'mutation', tier: tiers.mutation };
  }
  return { name: 'read', tier: tiers.read };
}

function resolveUserKey(request: FastifyRequest): string {
  const actorHeader = request.headers['x-actor-id'];
  if (typeof actorHeader === 'string' && actorHeader.length > 0) {
    return actorHeader;
  }
  return request.ip;
}

export async function registerRateLimiting(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  const tiers = {
    auth: {
      max: options.auth?.max ?? 10,
      timeWindow: options.auth?.timeWindow ?? '1 minute',
    },
    mutation: {
      max: options.mutation?.max ?? 120,
      timeWindow: options.mutation?.timeWindow ?? '1 minute',
    },
    read: {
      max: options.read?.max ?? 300,
      timeWindow: options.read?.timeWindow ?? '1 minute',
    },
  };

  await app.register(rateLimit, {
    global: true,
    allowList: (request) => request.url === '/health' || request.url === '/ready',
    keyGenerator: (request) => {
      const { name } = resolveTier(request, tiers);
      if (name === 'auth') {
        return `auth:${request.ip}`;
      }
      return `${name}:${resolveUserKey(request)}`;
    },
    max: (request) => resolveTier(request, tiers).tier.max,
    timeWindow: tiers.read.timeWindow,
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(`Rate limit exceeded. Retry in ${context.after}.`),
  });
}

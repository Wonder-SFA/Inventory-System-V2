import type { Database } from '@iv2/db';
import { uuidv7 } from '@iv2/shared-domain';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { CATALOG_MODULE } from './modules/catalog/public/index.js';
import {
  IAM_MODULE,
  createAuth,
  registerIamRoutes,
} from './modules/iam/public/index.js';
import { INVENTORY_MODULE } from './modules/inventory/public/index.js';
import { ORDERS_MODULE } from './modules/orders/public/index.js';
import {
  type RateLimitOptions,
  apiErrorHandler,
  registerRateLimiting,
} from './shared/http/index.js';
import type { OutboxDispatcher } from './shared/outbox/index.js';

export interface AppDeps {
  pool?: Pool | undefined;
  db?: Database | undefined;
  outboxDispatcher?: OutboxDispatcher | undefined;
  nodeEnv?: string | undefined;
  rateLimit?: RateLimitOptions | undefined;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';

  const app = Fastify({
    logger: nodeEnv !== 'test',
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MB (ADR-0008)
    genReqId: () => `req_${uuidv7()}`,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(apiErrorHandler);

  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Inventory System V2 API',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  if (nodeEnv !== 'production') {
    void app.register(swaggerUi, {
      routePrefix: '/docs',
    });
  }

  const rateLimitEnabled = deps.rateLimit?.enabled ?? nodeEnv !== 'test';
  if (rateLimitEnabled) {
    void registerRateLimiting(app, deps.rateLimit);
  }

  if (deps.db) {
    const auth = createAuth(deps.db, { nodeEnv });
    registerIamRoutes(app, { db: deps.db, auth });
  }

  app.get('/health', async () => {
    return {
      status: 'ok',
      modules: [CATALOG_MODULE, INVENTORY_MODULE, ORDERS_MODULE, IAM_MODULE],
    };
  });

  app.get('/ready', async (_request, reply) => {
    if (deps.pool) {
      try {
        await deps.pool.query('SELECT 1');
      } catch {
        return reply.status(503).send({ status: 'not_ready' });
      }
    }
    return reply.status(200).send({ status: 'ready' });
  });

  return app;
}

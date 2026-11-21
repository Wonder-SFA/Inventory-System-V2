import Fastify, { type FastifyInstance } from 'fastify';
import { CATALOG_MODULE } from './modules/catalog/public/index.js';
import { IAM_MODULE } from './modules/iam/public/index.js';
import { INVENTORY_MODULE } from './modules/inventory/public/index.js';
import { ORDERS_MODULE } from './modules/orders/public/index.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    trustProxy: true,
  });

  app.get('/health', async () => {
    return {
      status: 'ok',
      modules: [CATALOG_MODULE, INVENTORY_MODULE, ORDERS_MODULE, IAM_MODULE],
    };
  });

  app.get('/ready', async () => {
    return { status: 'ready' };
  });

  return app;
}

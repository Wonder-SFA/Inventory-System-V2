import type { Database } from '@iv2/db';
import type { FastifyInstance } from 'fastify';
import type { OutboxDispatcher } from '../../../shared/index.js';
import { registerOrdersReferenceCheckers } from '../domain/index.js';
import { registerPurchaseOrderRoutes } from './purchaseOrderRoutes.js';
import { registerSupplierRoutes } from './supplierRoutes.js';

export interface RegisterOrdersRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerOrdersRoutes(
  app: FastifyInstance,
  options: RegisterOrdersRoutesOptions,
): void {
  registerOrdersReferenceCheckers();
  registerSupplierRoutes(app, options);
  registerPurchaseOrderRoutes(app, options);
}

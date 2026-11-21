import type { Database } from '@iv2/db';
import {
  CreatePurchaseOrderInputSchema,
  ListPurchaseOrdersQuerySchema,
  ReceivePurchaseOrderInputSchema,
  UpdatePurchaseOrderInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrderById,
  listPurchaseOrders,
  receivePurchaseOrder,
  updatePurchaseOrder,
} from '../domain/index.js';

const PurchaseOrderParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterPurchaseOrderRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerPurchaseOrderRoutes(
  app: FastifyInstance,
  options: RegisterPurchaseOrderRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/purchase-orders',
    {
      schema: {
        body: CreatePurchaseOrderInputSchema,
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
          accessPolicy: policy,
          permission: {
            action: 'create',
            resource: 'purchase_order',
            context: { locationId: request.body.locationId },
          },
          handler: async (ctx) => {
            const created = await createPurchaseOrder(ctx.tx, request.body);
            return { data: policy.redactCosts(created), statusCode: 201 };
          },
        },
        {
          db,
          outboxDispatcher,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  typedApp.get(
    '/api/v1/purchase-orders',
    {
      schema: {
        querystring: ListPurchaseOrdersQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const query = request.query;
      const result = await listPurchaseOrders(db, policy.locationScope, query);
      return {
        data: result.items.map((item) => policy.redactCosts(item)),
        page: {
          limit: query.limit,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.get(
    '/api/v1/purchase-orders/:id',
    {
      schema: {
        params: PurchaseOrderParamsSchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const po = await getPurchaseOrderById(db, policy.locationScope, request.params.id);
      return {
        data: policy.redactCosts(po),
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/purchase-orders/:id',
    {
      schema: {
        params: PurchaseOrderParamsSchema,
        body: UpdatePurchaseOrderInputSchema,
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
          permission: {
            action: 'update',
            resource: 'purchase_order',
            context: request.body.locationId
              ? { locationId: request.body.locationId }
              : undefined,
          },
          handler: async (ctx) => {
            const updated = await updatePurchaseOrder(ctx.tx, request.params.id, request.body);
            return { data: policy.redactCosts(updated), statusCode: 200 };
          },
        },
        {
          db,
          outboxDispatcher,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    '/api/v1/purchase-orders/:id/confirm',
    {
      schema: {
        params: PurchaseOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id, action: 'confirm' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'confirm', resource: 'purchase_order' },
          handler: async (ctx) => {
            const confirmed = await confirmPurchaseOrder(ctx.tx, request.params.id, ctx.emit);
            return { data: policy.redactCosts(confirmed), statusCode: 200 };
          },
        },
        {
          db,
          outboxDispatcher,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    '/api/v1/purchase-orders/:id/receipts',
    {
      schema: {
        params: PurchaseOrderParamsSchema,
        body: ReceivePurchaseOrderInputSchema,
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
          accessPolicy: policy,
          permission: { action: 'receive', resource: 'purchase_order' },
          handler: async (ctx) => {
            const received = await receivePurchaseOrder(
              ctx.tx,
              request.params.id,
              request.body,
              {
                actorId: policy.actor.id,
                deriveLineIdempotencyKey: ctx.deriveLineIdempotencyKey,
                emit: ctx.emit,
              },
            );
            return {
              data: policy.redactCosts(received.result),
              warnings: received.warnings,
              statusCode: 201,
            };
          },
        },
        {
          db,
          outboxDispatcher,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    '/api/v1/purchase-orders/:id/cancel',
    {
      schema: {
        params: PurchaseOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id, action: 'cancel' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'cancel', resource: 'purchase_order' },
          handler: async (ctx) => {
            const cancelled = await cancelPurchaseOrder(ctx.tx, request.params.id, ctx.emit);
            return { data: policy.redactCosts(cancelled), statusCode: 200 };
          },
        },
        {
          db,
          outboxDispatcher,
          requestId: request.id,
          getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
        },
      );
      return reply.status(result.statusCode).send(result.body);
    },
  );
}

import type { Database } from '@iv2/db';
import {
  CreateSalesOrderInputSchema,
  ListSalesOrdersQuerySchema,
  ReturnSalesOrderInputSchema,
  ShipSalesOrderInputSchema,
  UpdateSalesOrderInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  deliverSalesOrder,
  getSalesOrderById,
  listSalesOrders,
  returnSalesOrder,
  shipSalesOrder,
  updateSalesOrder,
} from '../domain/index.js';

const SalesOrderParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterSalesOrderRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerSalesOrderRoutes(
  app: FastifyInstance,
  options: RegisterSalesOrderRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/sales-orders',
    {
      schema: {
        body: CreateSalesOrderInputSchema,
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
            resource: 'sales_order',
            context: { locationId: request.body.locationId },
          },
          handler: async (ctx) => {
            const created = await createSalesOrder(ctx.tx, request.body, ctx.emit);
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
    '/api/v1/sales-orders',
    {
      schema: {
        querystring: ListSalesOrdersQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const query = request.query;
      const result = await listSalesOrders(db, policy.locationScope, query);
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
    '/api/v1/sales-orders/:id',
    {
      schema: {
        params: SalesOrderParamsSchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const so = await getSalesOrderById(db, policy.locationScope, request.params.id);
      return {
        data: policy.redactCosts(so),
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/sales-orders/:id',
    {
      schema: {
        params: SalesOrderParamsSchema,
        body: UpdateSalesOrderInputSchema,
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
            resource: 'sales_order',
            context: request.body.locationId
              ? { locationId: request.body.locationId }
              : undefined,
          },
          handler: async (ctx) => {
            const updated = await updateSalesOrder(
              ctx.tx,
              request.params.id,
              request.body,
              ctx.emit,
            );
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
    '/api/v1/sales-orders/:id/confirm',
    {
      schema: {
        params: SalesOrderParamsSchema,
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
          permission: { action: 'confirm', resource: 'sales_order' },
          handler: async (ctx) => {
            const confirmed = await confirmSalesOrder(ctx.tx, request.params.id, ctx.emit);
            return {
              data: policy.redactCosts(confirmed.order),
              warnings: confirmed.warnings,
              statusCode: 200,
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
    '/api/v1/sales-orders/:id/shipments',
    {
      schema: {
        params: SalesOrderParamsSchema,
        body: ShipSalesOrderInputSchema,
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
          permission: { action: 'ship', resource: 'sales_order' },
          handler: async (ctx) => {
            const shipped = await shipSalesOrder(ctx.tx, request.params.id, request.body, {
              actorId: policy.actor.id,
              deriveLineIdempotencyKey: ctx.deriveLineIdempotencyKey,
              emit: ctx.emit,
            });
            return {
              data: policy.redactCosts(shipped.result),
              warnings: shipped.warnings,
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
    '/api/v1/sales-orders/:id/deliver',
    {
      schema: {
        params: SalesOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id, action: 'deliver' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'deliver', resource: 'sales_order' },
          handler: async (ctx) => {
            const delivered = await deliverSalesOrder(ctx.tx, request.params.id, ctx.emit);
            return { data: policy.redactCosts(delivered), statusCode: 200 };
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
    '/api/v1/sales-orders/:id/returns',
    {
      schema: {
        params: SalesOrderParamsSchema,
        body: ReturnSalesOrderInputSchema,
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
          permission: { action: 'return', resource: 'sales_order' },
          handler: async (ctx) => {
            const returned = await returnSalesOrder(ctx.tx, request.params.id, request.body, {
              actorId: policy.actor.id,
              deriveLineIdempotencyKey: ctx.deriveLineIdempotencyKey,
              emit: ctx.emit,
            });
            return {
              data: policy.redactCosts(returned.result),
              warnings: returned.warnings,
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
    '/api/v1/sales-orders/:id/cancel',
    {
      schema: {
        params: SalesOrderParamsSchema,
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
          permission: { action: 'cancel', resource: 'sales_order' },
          handler: async (ctx) => {
            const cancelled = await cancelSalesOrder(ctx.tx, request.params.id, ctx.emit);
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

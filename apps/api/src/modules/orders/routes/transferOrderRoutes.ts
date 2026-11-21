import type { Database } from '@iv2/db';
import {
  CloseTransferDiscrepancyInputSchema,
  CreateTransferOrderInputSchema,
  DispatchTransferOrderInputSchema,
  ListTransferOrdersQuerySchema,
  ReceiveTransferOrderInputSchema,
  UpdateTransferOrderInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  cancelTransferOrder,
  closeTransferOrderDiscrepancy,
  confirmTransferOrder,
  createTransferOrder,
  dispatchTransferOrder,
  getTransferOrderById,
  listTransferOrders,
  receiveTransferOrder,
  updateTransferOrder,
} from '../domain/index.js';

const TransferOrderParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterTransferOrderRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerTransferOrderRoutes(
  app: FastifyInstance,
  options: RegisterTransferOrderRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/transfer-orders',
    {
      schema: {
        body: CreateTransferOrderInputSchema,
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
            resource: 'transfer_order',
            context: { locationId: request.body.sourceLocationId },
          },
          handler: async (ctx) => {
            const created = await createTransferOrder(ctx.tx, request.body, ctx.emit);
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
    '/api/v1/transfer-orders',
    {
      schema: {
        querystring: ListTransferOrdersQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const query = request.query;
      const result = await listTransferOrders(db, policy.locationScope, query);
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
    '/api/v1/transfer-orders/:id',
    {
      schema: {
        params: TransferOrderParamsSchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const to = await getTransferOrderById(db, policy.locationScope, request.params.id);
      return {
        data: policy.redactCosts(to),
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/transfer-orders/:id',
    {
      schema: {
        params: TransferOrderParamsSchema,
        body: UpdateTransferOrderInputSchema,
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
            resource: 'transfer_order',
            context: request.body.sourceLocationId
              ? { locationId: request.body.sourceLocationId }
              : undefined,
          },
          handler: async (ctx) => {
            const updated = await updateTransferOrder(
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
    '/api/v1/transfer-orders/:id/confirm',
    {
      schema: {
        params: TransferOrderParamsSchema,
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
          permission: { action: 'confirm', resource: 'transfer_order' },
          handler: async (ctx) => {
            const confirmed = await confirmTransferOrder(ctx.tx, request.params.id, ctx.emit);
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
    '/api/v1/transfer-orders/:id/dispatch',
    {
      schema: {
        params: TransferOrderParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const parsedBody =
        request.body !== undefined && request.body !== null
          ? DispatchTransferOrderInputSchema.parse(request.body)
          : undefined;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: parsedBody ?? { id: request.params.id, action: 'dispatch' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'dispatch', resource: 'transfer_order' },
          handler: async (ctx) => {
            const dispatched = await dispatchTransferOrder(ctx.tx, request.params.id, parsedBody, {
              actorId: policy.actor.id,
              deriveLineIdempotencyKey: ctx.deriveLineIdempotencyKey,
              emit: ctx.emit,
            });
            return {
              data: policy.redactCosts(dispatched.order),
              warnings: dispatched.warnings,
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
    '/api/v1/transfer-orders/:id/receipts',
    {
      schema: {
        params: TransferOrderParamsSchema,
        body: ReceiveTransferOrderInputSchema,
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
          permission: { action: 'receive', resource: 'transfer_order' },
          handler: async (ctx) => {
            const received = await receiveTransferOrder(ctx.tx, request.params.id, request.body, {
              actorId: policy.actor.id,
              deriveLineIdempotencyKey: ctx.deriveLineIdempotencyKey,
              emit: ctx.emit,
            });
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
    '/api/v1/transfer-orders/:id/close-discrepancy',
    {
      schema: {
        params: TransferOrderParamsSchema,
        body: CloseTransferDiscrepancyInputSchema,
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
          permission: { action: 'close_discrepancy', resource: 'transfer_order' },
          handler: async (ctx) => {
            const closed = await closeTransferOrderDiscrepancy(
              ctx.tx,
              request.params.id,
              request.body,
              {
                actorId: policy.actor.id,
                emit: ctx.emit,
              },
            );
            return { data: policy.redactCosts(closed), statusCode: 200 };
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
    '/api/v1/transfer-orders/:id/cancel',
    {
      schema: {
        params: TransferOrderParamsSchema,
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
          permission: { action: 'cancel', resource: 'transfer_order' },
          handler: async (ctx) => {
            const cancelled = await cancelTransferOrder(ctx.tx, request.params.id, ctx.emit);
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

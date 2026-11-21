import type { Database } from '@iv2/db';
import {
  CreateCustomerInputSchema,
  ListCustomersQuerySchema,
  UpdateCustomerInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  createCustomer,
  deleteCustomer,
  getCustomerById,
  listCustomers,
  setCustomerStatus,
  updateCustomer,
} from '../domain/index.js';

const CustomerParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterCustomerRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerCustomerRoutes(
  app: FastifyInstance,
  options: RegisterCustomerRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/customers',
    {
      schema: {
        body: CreateCustomerInputSchema,
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
          permission: { action: 'create', resource: 'customer' },
          handler: async (ctx) => {
            const created = await createCustomer(ctx.tx, request.body, ctx.emit);
            return { data: created, statusCode: 201 };
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
    '/api/v1/customers',
    {
      schema: {
        querystring: ListCustomersQuerySchema,
      },
    },
    async (request) => {
      const query = request.query;
      const result = await listCustomers(db, query);
      return {
        data: result.items,
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
    '/api/v1/customers/:id',
    {
      schema: {
        params: CustomerParamsSchema,
      },
    },
    async (request) => {
      const customer = await getCustomerById(db, request.params.id);
      return {
        data: customer,
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/customers/:id',
    {
      schema: {
        params: CustomerParamsSchema,
        body: UpdateCustomerInputSchema,
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
          permission: { action: 'update', resource: 'customer' },
          handler: async (ctx) => {
            const updated = await updateCustomer(ctx.tx, request.params.id, request.body, ctx.emit);
            return { data: updated, statusCode: 200 };
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
    '/api/v1/customers/:id/archive',
    {
      schema: {
        params: CustomerParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id, status: 'ARCHIVED' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'archive', resource: 'customer' },
          handler: async (ctx) => {
            const updated = await setCustomerStatus(ctx.tx, request.params.id, 'ARCHIVED', ctx.emit);
            return { data: updated, statusCode: 200 };
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
    '/api/v1/customers/:id/unarchive',
    {
      schema: {
        params: CustomerParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id, status: 'ACTIVE' },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: policy,
          permission: { action: 'unarchive', resource: 'customer' },
          handler: async (ctx) => {
            const updated = await setCustomerStatus(ctx.tx, request.params.id, 'ACTIVE', ctx.emit);
            return { data: updated, statusCode: 200 };
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

  typedApp.delete(
    '/api/v1/customers/:id',
    {
      schema: {
        params: CustomerParamsSchema,
      },
    },
    async (request, reply) => {
      const policy = request.accessPolicy!;
      const result = await executeCommand(
        {
          actorId: policy.actor.id,
          method: request.method,
          path: request.url,
          payload: { id: request.params.id },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          requireIdempotencyKey: false,
          accessPolicy: policy,
          permission: { action: 'delete', resource: 'customer' },
          handler: async (ctx) => {
            const deleted = await deleteCustomer(ctx.tx, request.params.id, ctx.emit);
            return { data: deleted, statusCode: 200 };
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

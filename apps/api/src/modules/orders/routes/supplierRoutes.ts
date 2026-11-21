import type { Database } from '@iv2/db';
import {
  CreateSupplierInputSchema,
  ListSuppliersQuerySchema,
  UpdateSupplierInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  createSupplier,
  deleteSupplier,
  getSupplierById,
  listSuppliers,
  setSupplierStatus,
  updateSupplier,
} from '../domain/index.js';

const SupplierParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterSupplierRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerSupplierRoutes(
  app: FastifyInstance,
  options: RegisterSupplierRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/suppliers',
    {
      schema: {
        body: CreateSupplierInputSchema,
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
          permission: { action: 'create', resource: 'supplier' },
          handler: async (ctx) => {
            const created = await createSupplier(ctx.tx, request.body);
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
    '/api/v1/suppliers',
    {
      schema: {
        querystring: ListSuppliersQuerySchema,
      },
    },
    async (request) => {
      const query = request.query;
      const result = await listSuppliers(db, query);
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
    '/api/v1/suppliers/:id',
    {
      schema: {
        params: SupplierParamsSchema,
      },
    },
    async (request) => {
      const supplier = await getSupplierById(db, request.params.id);
      return {
        data: supplier,
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/suppliers/:id',
    {
      schema: {
        params: SupplierParamsSchema,
        body: UpdateSupplierInputSchema,
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
          permission: { action: 'update', resource: 'supplier' },
          handler: async (ctx) => {
            const updated = await updateSupplier(ctx.tx, request.params.id, request.body);
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
    '/api/v1/suppliers/:id/archive',
    {
      schema: {
        params: SupplierParamsSchema,
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
          permission: { action: 'archive', resource: 'supplier' },
          handler: async (ctx) => {
            const updated = await setSupplierStatus(ctx.tx, request.params.id, 'ARCHIVED');
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
    '/api/v1/suppliers/:id/unarchive',
    {
      schema: {
        params: SupplierParamsSchema,
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
          permission: { action: 'unarchive', resource: 'supplier' },
          handler: async (ctx) => {
            const updated = await setSupplierStatus(ctx.tx, request.params.id, 'ACTIVE');
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
    '/api/v1/suppliers/:id',
    {
      schema: {
        params: SupplierParamsSchema,
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
          permission: { action: 'delete', resource: 'supplier' },
          handler: async (ctx) => {
            const deleted = await deleteSupplier(ctx.tx, request.params.id);
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

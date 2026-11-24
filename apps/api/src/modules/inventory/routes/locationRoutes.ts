import type { Database } from '@iv2/db';
import {
  CreateLocationInputSchema,
  ERROR_CODES,
  ListLocationsQuerySchema,
  NotFoundError,
  UpdateLocationInputSchema,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  createLocation,
  deleteLocation,
  getLocationById,
  listLocations,
  registerInventoryReferenceCheckers,
  setLocationStatus,
  updateLocation,
} from '../domain/index.js';
import { registerStockRoutes } from './stockRoutes.js';

const LocationParamsSchema = z.object({
  id: z.string().uuid(),
});

export interface RegisterInventoryRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  options: RegisterInventoryRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  registerInventoryReferenceCheckers();
  registerStockRoutes(app, { db, outboxDispatcher });
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/api/v1/locations',
    {
      schema: {
        body: CreateLocationInputSchema,
      },
    },
    async (request, reply) => {
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: request.body,
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'create', resource: 'location' },
          handler: async (ctx) => {
            const created = await createLocation(ctx.tx, request.body);
            await ctx.emit({
              eventType: 'LocationCreated',
              aggregateType: 'location',
              aggregateId: created.id,
              payload: created,
            });
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
    '/api/v1/locations',
    {
      schema: {
        querystring: ListLocationsQuerySchema,
      },
    },
    async (request) => {
      const query = request.query;
      const result = await listLocations(db, request.accessPolicy!.locationScope, query);
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
    '/api/v1/locations/:id',
    {
      schema: {
        params: LocationParamsSchema,
      },
    },
    async (request) => {
      const location = await getLocationById(
        db,
        request.accessPolicy!.locationScope,
        request.params.id,
      );
      if (!location) {
        throw new NotFoundError(
          ERROR_CODES.LOCATION_NOT_FOUND,
          `Location ${request.params.id} not found`,
        );
      }
      return {
        data: location,
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.patch(
    '/api/v1/locations/:id',
    {
      schema: {
        params: LocationParamsSchema,
        body: UpdateLocationInputSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: request.body,
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'update', resource: 'location', context: { locationId: id } },
          handler: async (ctx) => {
            const updated = await updateLocation(ctx.tx, id, request.body);
            await ctx.emit({
              eventType: 'LocationUpdated',
              aggregateType: 'location',
              aggregateId: updated.id,
              payload: updated,
            });
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
    '/api/v1/locations/:id/archive',
    {
      schema: {
        params: LocationParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: { id },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'archive', resource: 'location', context: { locationId: id } },
          handler: async (ctx) => {
            const archived = await setLocationStatus(ctx.tx, id, 'ARCHIVED');
            await ctx.emit({
              eventType: 'LocationArchived',
              aggregateType: 'location',
              aggregateId: archived.id,
              payload: archived,
            });
            return { data: archived, statusCode: 200 };
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
    '/api/v1/locations/:id/unarchive',
    {
      schema: {
        params: LocationParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: { id },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'unarchive', resource: 'location', context: { locationId: id } },
          handler: async (ctx) => {
            const unarchived = await setLocationStatus(ctx.tx, id, 'ACTIVE');
            await ctx.emit({
              eventType: 'LocationUnarchived',
              aggregateType: 'location',
              aggregateId: unarchived.id,
              payload: unarchived,
            });
            return { data: unarchived, statusCode: 200 };
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
    '/api/v1/locations/:id',
    {
      schema: {
        params: LocationParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await executeCommand(
        {
          actorId: request.accessPolicy!.actor.id,
          method: request.method,
          path: request.url,
          payload: { id },
          idempotencyKey: request.headers['idempotency-key'] as string | undefined,
          accessPolicy: request.accessPolicy,
          permission: { action: 'delete', resource: 'location', context: { locationId: id } },
          handler: async (ctx) => {
            const deleted = await deleteLocation(ctx.tx, id);
            await ctx.emit({
              eventType: 'LocationDeleted',
              aggregateType: 'location',
              aggregateId: id,
              payload: deleted,
            });
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

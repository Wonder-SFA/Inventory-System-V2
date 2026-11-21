import type { Database } from '@iv2/db';
import {
  CreateStockAdjustmentInputSchema,
  ListStockBalancesQuerySchema,
  ListStockMovementsQuerySchema,
  uuidv7,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  listStockBalances,
  listStockMovements,
  recordManualAdjustment,
} from '../domain/index.js';

export interface RegisterStockRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerStockRoutes(
  app: FastifyInstance,
  options: RegisterStockRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/api/v1/stock-balances',
    {
      schema: {
        querystring: ListStockBalancesQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const query = request.query;
      const result = await listStockBalances(db, policy.locationScope, query);
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
    '/api/v1/stock-movements',
    {
      schema: {
        querystring: ListStockMovementsQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      const query = request.query;
      const result = await listStockMovements(db, policy.locationScope, query);
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

  typedApp.post(
    '/api/v1/stock-movements/adjustments',
    {
      schema: {
        body: CreateStockAdjustmentInputSchema,
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
            action: 'adjust',
            resource: 'stock_movement',
            context: {
              locationId: request.body.locationId,
              quantity: request.body.quantityDelta,
            },
          },
          handler: async (ctx) => {
            const movementIdempotencyKey = ctx.idempotencyKey ?? uuidv7();
            const recorded = await recordManualAdjustment(
              ctx.tx,
              {
                skuId: request.body.skuId,
                locationId: request.body.locationId,
                quantityDelta: request.body.quantityDelta,
                reasonCategory: request.body.reasonCategory,
                unitCost: request.body.unitCost,
                currency: request.body.currency,
                note: request.body.note,
                actorId: policy.actor.id,
                idempotencyKey: movementIdempotencyKey,
              },
              {
                emit: ctx.emit,
                assertCanPushNegative: (locationId) => {
                  policy.assertCan('adjust', 'stock_movement', {
                    locationId,
                    pushesStockNegative: true,
                  });
                },
              },
            );

            return {
              data: policy.redactCosts(recorded.movement),
              warnings: recorded.warnings,
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
}

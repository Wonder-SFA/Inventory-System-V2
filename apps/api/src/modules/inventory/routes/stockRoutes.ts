import type { Database } from '@iv2/db';
import {
  AssignOpeningLotsInputSchema,
  CreateStockAdjustmentInputSchema,
  CreateStockIssueInputSchema,
  FefoPreviewQuerySchema,
  ListLotBalancesQuerySchema,
  ListStockBalancesQuerySchema,
  ListStockLotsQuerySchema,
  ListStockMovementsQuerySchema,
  RecentReceiptCostsQuerySchema,
  ValuationSummaryQuerySchema,
  uuidv7,
} from '@iv2/shared-domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type OutboxDispatcher, executeCommand } from '../../../shared/index.js';
import {
  assignOpeningLots,
  getRecentReceiptCosts,
  getValuationSummary,
  listLotBalances,
  listStockBalances,
  listStockLots,
  listStockMovements,
  previewFefoAllocation,
  recordManualAdjustment,
  recordManualIssue,
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

  typedApp.get(
    '/api/v1/stock-lots',
    {
      schema: {
        querystring: ListStockLotsQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      policy.assertCan(
        'read',
        'stock_balance',
        request.query.locationId ? { locationId: request.query.locationId } : undefined,
      );
      const query = request.query;
      const result = await listStockLots(db, policy.locationScope, query);
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
    '/api/v1/lot-balances',
    {
      schema: {
        querystring: ListLotBalancesQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      policy.assertCan(
        'read',
        'stock_balance',
        request.query.locationId ? { locationId: request.query.locationId } : undefined,
      );
      const query = request.query;
      const result = await listLotBalances(db, policy.locationScope, query);
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
    '/api/v1/valuation-summary',
    {
      schema: {
        querystring: ValuationSummaryQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      policy.assertCan(
        'read',
        'stock_balance',
        request.query.locationId ? { locationId: request.query.locationId } : undefined,
      );
      const summary = await getValuationSummary(db, policy.locationScope, request.query);
      return {
        data: policy.redactCosts(summary),
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.get(
    '/api/v1/stock-lots/fefo-preview',
    {
      schema: {
        querystring: FefoPreviewQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      policy.assertCan('read', 'stock_balance', { locationId: request.query.locationId });
      const lotPolicy = policy.resolveLotPolicy({ locationId: request.query.locationId });
      const preview = await previewFefoAllocation(
        db,
        policy.locationScope,
        request.query,
        lotPolicy.negativeStockPolicy,
      );
      return {
        data: policy.redactCosts(preview),
        meta: {
          requestId: request.id,
        },
      };
    },
  );

  typedApp.get(
    '/api/v1/skus/:id/recent-receipt-costs',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: RecentReceiptCostsQuerySchema,
      },
    },
    async (request) => {
      const policy = request.accessPolicy!;
      policy.assertCan(
        'read',
        'stock_balance',
        request.query.locationId ? { locationId: request.query.locationId } : undefined,
      );
      const result = await getRecentReceiptCosts(
        db,
        policy.locationScope,
        request.params.id,
        request.query,
      );
      return {
        data: policy.redactCosts(result),
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
                lotId: request.body.lotId,
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

  typedApp.post(
    '/api/v1/stock-movements/issues',
    {
      schema: {
        body: CreateStockIssueInputSchema,
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
            action: 'issue',
            resource: 'stock_movement',
            context: {
              locationId: request.body.locationId,
              quantity: request.body.quantity,
            },
          },
          handler: async (ctx) => {
            const movementIdempotencyKey = ctx.idempotencyKey ?? uuidv7();
            const lotPolicy = policy.resolveLotPolicy({ locationId: request.body.locationId });
            const allowManualFefoOverride = policy.canManualFefoOverride({
              locationId: request.body.locationId,
            });
            const recorded = await recordManualIssue(
              ctx.tx,
              {
                skuId: request.body.skuId,
                locationId: request.body.locationId,
                quantity: request.body.quantity,
                currency: request.body.currency,
                note: request.body.note,
                lotAllocations: request.body.lotAllocations,
                confirmExpiredLotOverride: request.body.confirmExpiredLotOverride,
                overrideReason: request.body.overrideReason,
                actorId: policy.actor.id,
                idempotencyKey: movementIdempotencyKey,
              },
              {
                emit: ctx.emit,
                pickingMode: lotPolicy.pickingMode,
                negativeStockPolicy: lotPolicy.negativeStockPolicy,
                allowManualFefoOverride,
                allowExpiredLotOverride: lotPolicy.allowExpiredLotOverride,
                assertCanPushNegative: (locationId) => {
                  policy.assertCan('issue', 'stock_movement', {
                    locationId,
                    pushesStockNegative: true,
                  });
                },
              },
            );

            return {
              data: recorded.movements.map((m) => policy.redactCosts(m)),
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

  typedApp.post(
    '/api/v1/stock-lots/assign-opening',
    {
      schema: {
        body: AssignOpeningLotsInputSchema,
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
            },
          },
          handler: async (ctx) => {
            const movementIdempotencyKey = ctx.idempotencyKey ?? uuidv7();
            const assigned = await assignOpeningLots(
              ctx.tx,
              {
                skuId: request.body.skuId,
                locationId: request.body.locationId,
                lots: request.body.lots,
                currency: request.body.currency,
                note: request.body.note,
                actorId: policy.actor.id,
                idempotencyKey: movementIdempotencyKey,
              },
              {
                emit: ctx.emit,
              },
            );

            return {
              data: {
                assignedQuantity: assigned.assignedQuantity,
                remainingUnlottedQuantity: assigned.remainingUnlottedQuantity,
                movements: assigned.movements.map((m) => policy.redactCosts(m)),
              },
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

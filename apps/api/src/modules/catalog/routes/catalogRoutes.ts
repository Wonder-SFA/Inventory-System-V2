import type { Database } from '@iv2/db';
import {
  ConflictError,
  CreateProductSchema,
  CreateSkuSchema,
  CreateUnitOfMeasureSchema,
  ERROR_CODES,
  ListProductsQuerySchema,
  ListSkusQuerySchema,
  ListUnitsOfMeasureQuerySchema,
  NotFoundError,
  SkuLookupQuerySchema,
  UpdateProductSchema,
  UpdateSkuSchema,
  UpdateUnitOfMeasureSchema,
  UuidParamSchema,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, eq, ilike, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  type CommandHandlerResult,
  type CommandContext,
  type OutboxDispatcher,
  applyKeysetOrder,
  executeCommand,
  getPgErrorCode,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { catalogProducts, catalogSkus, catalogUnitsOfMeasure } from '../db/index.js';
import {
  assertNoSkuCodeConflict,
  assertNoUnitOfMeasureConflict,
  assertProductExists,
  assertUnitOfMeasureExists,
  findSkuByIdOrCode,
  hasProductReferences,
  hasSkuReferences,
  hasUnitOfMeasureReferences,
  toProductDto,
  toSkuDto,
  toUnitOfMeasureDto,
} from '../domain/index.js';

export interface RegisterCatalogRoutesOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  options: RegisterCatalogRoutesOptions,
): void {
  const { db, outboxDispatcher } = options;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  async function runCommand<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: { action: string; resource: string },
    handler: (ctx: CommandContext) => Promise<CommandHandlerResult<T>>,
  ) {
    const result = await executeCommand(
      {
        actorId: request.accessPolicy!.actor.id,
        method: request.method,
        path: request.url,
        payload: request.body ?? {},
        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
        requireIdempotencyKey: false,
        accessPolicy: request.accessPolicy,
        permission,
        handler,
      },
      {
        db,
        outboxDispatcher,
        requestId: request.id,
        getAccessSwitch: () => request.accessSwitch ?? 'ACTIVE',
      },
    );
    return reply.status(result.statusCode).send(result.body);
  }

  // =========================================================================
  // Units of Measure
  // =========================================================================

  typedApp.post(
    '/api/v1/units-of-measure',
    {
      schema: {
        body: CreateUnitOfMeasureSchema,
      },
    },
    async (request, reply) => {
      const { code, name } = request.body;
      return runCommand(
        request,
        reply,
        { action: 'create', resource: 'unit_of_measure' },
        async (ctx) => {
          await assertNoUnitOfMeasureConflict(ctx.tx, { code, name });
          const now = new Date();
          const id = uuidv7();
          let inserted;
          try {
            [inserted] = await ctx.tx
              .insert(catalogUnitsOfMeasure)
              .values({
                id,
                code,
                name,
                status: 'ACTIVE',
                createdAt: now,
                updatedAt: now,
              })
              .returning();
          } catch (err) {
            if (getPgErrorCode(err) === '23505') {
              throw new ConflictError(
                ERROR_CODES.UNIT_OF_MEASURE_CONFLICT,
                'A Unit of Measure with that code or name already exists',
              );
            }
            throw err;
          }

          const dto = toUnitOfMeasureDto(inserted!);
          await ctx.emit({
            eventType: 'UnitOfMeasureCreated',
            aggregateType: 'UnitOfMeasure',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 201 };
        },
      );
    },
  );

  typedApp.get(
    '/api/v1/units-of-measure',
    {
      schema: {
        querystring: ListUnitsOfMeasureQuerySchema,
      },
    },
    async (request) => {
      const { cursor, limit, status } = request.query;
      const keyset = applyKeysetOrder(
        catalogUnitsOfMeasure.createdAt,
        catalogUnitsOfMeasure.id,
        cursor,
      );
      const filters: SQL[] = [];
      if (keyset.where) {
        filters.push(keyset.where);
      }
      if (status) {
        filters.push(eq(catalogUnitsOfMeasure.status, status));
      }

      const rows = await db
        .select()
        .from(catalogUnitsOfMeasure)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(...keyset.orderBy)
        .limit(limit + 1);

      const page = paginateKeysetResult(rows, limit);
      return {
        data: page.items.map(toUnitOfMeasureDto),
        page: {
          limit,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
        meta: { requestId: request.id },
      };
    },
  );

  typedApp.patch(
    '/api/v1/units-of-measure/:id',
    {
      schema: {
        params: UuidParamSchema,
        body: UpdateUnitOfMeasureSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { code, name } = request.body;
      return runCommand(
        request,
        reply,
        { action: 'update', resource: 'unit_of_measure' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogUnitsOfMeasure)
            .where(eq(catalogUnitsOfMeasure.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Unit of Measure ${id} not found`);
          }

          await assertNoUnitOfMeasureConflict(ctx.tx, { code, name }, id);

          let updated;
          try {
            [updated] = await ctx.tx
              .update(catalogUnitsOfMeasure)
              .set({
                ...(code !== undefined ? { code } : {}),
                ...(name !== undefined ? { name } : {}),
                updatedAt: new Date(),
              })
              .where(eq(catalogUnitsOfMeasure.id, id))
              .returning();
          } catch (err) {
            if (getPgErrorCode(err) === '23505') {
              throw new ConflictError(
                ERROR_CODES.UNIT_OF_MEASURE_CONFLICT,
                'A Unit of Measure with that code or name already exists',
              );
            }
            throw err;
          }

          const dto = toUnitOfMeasureDto(updated!);
          await ctx.emit({
            eventType: 'UnitOfMeasureUpdated',
            aggregateType: 'UnitOfMeasure',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 200 };
        },
      );
    },
  );

  typedApp.post(
    '/api/v1/units-of-measure/:id/archive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(
        request,
        reply,
        { action: 'archive', resource: 'unit_of_measure' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogUnitsOfMeasure)
            .where(eq(catalogUnitsOfMeasure.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Unit of Measure ${id} not found`);
          }

          const [updated] = await ctx.tx
            .update(catalogUnitsOfMeasure)
            .set({ status: 'ARCHIVED', updatedAt: new Date() })
            .where(eq(catalogUnitsOfMeasure.id, id))
            .returning();

          const dto = toUnitOfMeasureDto(updated!);
          await ctx.emit({
            eventType: 'UnitOfMeasureArchived',
            aggregateType: 'UnitOfMeasure',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 200 };
        },
      );
    },
  );

  typedApp.post(
    '/api/v1/units-of-measure/:id/unarchive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(
        request,
        reply,
        { action: 'unarchive', resource: 'unit_of_measure' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogUnitsOfMeasure)
            .where(eq(catalogUnitsOfMeasure.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Unit of Measure ${id} not found`);
          }

          const [updated] = await ctx.tx
            .update(catalogUnitsOfMeasure)
            .set({ status: 'ACTIVE', updatedAt: new Date() })
            .where(eq(catalogUnitsOfMeasure.id, id))
            .returning();

          const dto = toUnitOfMeasureDto(updated!);
          await ctx.emit({
            eventType: 'UnitOfMeasureUnarchived',
            aggregateType: 'UnitOfMeasure',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 200 };
        },
      );
    },
  );

  typedApp.delete(
    '/api/v1/units-of-measure/:id',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(
        request,
        reply,
        { action: 'delete', resource: 'unit_of_measure' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogUnitsOfMeasure)
            .where(eq(catalogUnitsOfMeasure.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Unit of Measure ${id} not found`);
          }

          if (await hasUnitOfMeasureReferences(ctx.tx, id)) {
            throw new ConflictError(
              ERROR_CODES.RESOURCE_IN_USE,
              'Unit of Measure is referenced by existing SKUs and cannot be deleted',
            );
          }

          try {
            await ctx.tx.delete(catalogUnitsOfMeasure).where(eq(catalogUnitsOfMeasure.id, id));
          } catch (err) {
            if (getPgErrorCode(err) === '23503') {
              throw new ConflictError(
                ERROR_CODES.RESOURCE_IN_USE,
                'Unit of Measure is referenced by existing SKUs and cannot be deleted',
              );
            }
            throw err;
          }

          await ctx.emit({
            eventType: 'UnitOfMeasureDeleted',
            aggregateType: 'UnitOfMeasure',
            aggregateId: id,
            payload: { id },
          });
          return { data: { id, deleted: true }, statusCode: 200 };
        },
      );
    },
  );

  // =========================================================================
  // Products
  // =========================================================================

  typedApp.post(
    '/api/v1/products',
    {
      schema: {
        body: CreateProductSchema,
      },
    },
    async (request, reply) => {
      const { name, description } = request.body;
      return runCommand(request, reply, { action: 'create', resource: 'product' }, async (ctx) => {
        const now = new Date();
        const id = uuidv7();
        const [inserted] = await ctx.tx
          .insert(catalogProducts)
          .values({
            id,
            name,
            description: description ?? null,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const dto = toProductDto(inserted!);
        await ctx.emit({
          eventType: 'ProductCreated',
          aggregateType: 'Product',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 201 };
      });
    },
  );

  typedApp.get(
    '/api/v1/products',
    {
      schema: {
        querystring: ListProductsQuerySchema,
      },
    },
    async (request) => {
      const { cursor, limit, status } = request.query;
      const keyset = applyKeysetOrder(catalogProducts.createdAt, catalogProducts.id, cursor);
      const filters: SQL[] = [];
      if (keyset.where) {
        filters.push(keyset.where);
      }
      if (status) {
        filters.push(eq(catalogProducts.status, status));
      }

      const rows = await db
        .select()
        .from(catalogProducts)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(...keyset.orderBy)
        .limit(limit + 1);

      const page = paginateKeysetResult(rows, limit);
      return {
        data: page.items.map(toProductDto),
        page: {
          limit,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
        meta: { requestId: request.id },
      };
    },
  );

  typedApp.get(
    '/api/v1/products/:id',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params;
      const [row] = await db
        .select()
        .from(catalogProducts)
        .where(eq(catalogProducts.id, id))
        .limit(1);
      if (!row) {
        throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${id} not found`);
      }
      return {
        data: toProductDto(row),
        meta: { requestId: request.id },
      };
    },
  );

  typedApp.patch(
    '/api/v1/products/:id',
    {
      schema: {
        params: UuidParamSchema,
        body: UpdateProductSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, description } = request.body;
      return runCommand(request, reply, { action: 'update', resource: 'product' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogProducts)
          .where(eq(catalogProducts.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${id} not found`);
        }

        const [updated] = await ctx.tx
          .update(catalogProducts)
          .set({
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            updatedAt: new Date(),
          })
          .where(eq(catalogProducts.id, id))
          .returning();

        const dto = toProductDto(updated!);
        await ctx.emit({
          eventType: 'ProductUpdated',
          aggregateType: 'Product',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 200 };
      });
    },
  );

  typedApp.post(
    '/api/v1/products/:id/archive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(
        request,
        reply,
        { action: 'archive', resource: 'product' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogProducts)
            .where(eq(catalogProducts.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${id} not found`);
          }

          const [updated] = await ctx.tx
            .update(catalogProducts)
            .set({ status: 'ARCHIVED', updatedAt: new Date() })
            .where(eq(catalogProducts.id, id))
            .returning();

          const dto = toProductDto(updated!);
          await ctx.emit({
            eventType: 'ProductArchived',
            aggregateType: 'Product',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 200 };
        },
      );
    },
  );

  typedApp.post(
    '/api/v1/products/:id/unarchive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(
        request,
        reply,
        { action: 'unarchive', resource: 'product' },
        async (ctx) => {
          const [existing] = await ctx.tx
            .select()
            .from(catalogProducts)
            .where(eq(catalogProducts.id, id))
            .limit(1);
          if (!existing) {
            throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${id} not found`);
          }

          const [updated] = await ctx.tx
            .update(catalogProducts)
            .set({ status: 'ACTIVE', updatedAt: new Date() })
            .where(eq(catalogProducts.id, id))
            .returning();

          const dto = toProductDto(updated!);
          await ctx.emit({
            eventType: 'ProductUnarchived',
            aggregateType: 'Product',
            aggregateId: dto.id,
            payload: dto,
          });
          return { data: dto, statusCode: 200 };
        },
      );
    },
  );

  typedApp.delete(
    '/api/v1/products/:id',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(request, reply, { action: 'delete', resource: 'product' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogProducts)
          .where(eq(catalogProducts.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${id} not found`);
        }

        if (await hasProductReferences(ctx.tx, id)) {
          throw new ConflictError(
            ERROR_CODES.RESOURCE_IN_USE,
            'Product has existing SKUs and cannot be deleted; archive it instead',
          );
        }

        try {
          await ctx.tx.delete(catalogProducts).where(eq(catalogProducts.id, id));
        } catch (err) {
          if (getPgErrorCode(err) === '23503') {
            throw new ConflictError(
              ERROR_CODES.RESOURCE_IN_USE,
              'Product has dependent records and cannot be deleted',
            );
          }
          throw err;
        }

        await ctx.emit({
          eventType: 'ProductDeleted',
          aggregateType: 'Product',
          aggregateId: id,
          payload: { id },
        });
        return { data: { id, deleted: true }, statusCode: 200 };
      });
    },
  );

  // =========================================================================
  // SKUs
  // =========================================================================

  typedApp.post(
    '/api/v1/skus',
    {
      schema: {
        body: CreateSkuSchema,
      },
    },
    async (request, reply) => {
      const { productId, unitOfMeasureId, code, name, defaultSellingPrice } = request.body;
      return runCommand(request, reply, { action: 'create', resource: 'sku' }, async (ctx) => {
        await assertProductExists(ctx.tx, productId);
        await assertUnitOfMeasureExists(ctx.tx, unitOfMeasureId);
        await assertNoSkuCodeConflict(ctx.tx, code);

        const now = new Date();
        const id = uuidv7();
        let inserted;
        try {
          [inserted] = await ctx.tx
            .insert(catalogSkus)
            .values({
              id,
              productId,
              unitOfMeasureId,
              code,
              name,
              defaultSellingPrice: defaultSellingPrice ?? null,
              status: 'ACTIVE',
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (err) {
          if (getPgErrorCode(err) === '23505') {
            throw new ConflictError(
              ERROR_CODES.SKU_CODE_CONFLICT,
              `SKU code "${code}" is already in use (including archived SKUs)`,
            );
          }
          throw err;
        }

        const dto = toSkuDto(inserted!);
        await ctx.emit({
          eventType: 'SkuCreated',
          aggregateType: 'Sku',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 201 };
      });
    },
  );

  typedApp.get(
    '/api/v1/skus',
    {
      schema: {
        querystring: ListSkusQuerySchema,
      },
    },
    async (request) => {
      const { cursor, limit, status, productId, search } = request.query;
      const keyset = applyKeysetOrder(catalogSkus.createdAt, catalogSkus.id, cursor);
      const filters: SQL[] = [];
      if (keyset.where) {
        filters.push(keyset.where);
      }
      if (status) {
        filters.push(eq(catalogSkus.status, status));
      }
      if (productId) {
        filters.push(eq(catalogSkus.productId, productId));
      }
      if (search) {
        const pattern = `%${search}%`;
        filters.push(or(ilike(catalogSkus.code, pattern), ilike(catalogSkus.name, pattern))!);
      }

      const rows = await db
        .select()
        .from(catalogSkus)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(...keyset.orderBy)
        .limit(limit + 1);

      const page = paginateKeysetResult(rows, limit);
      return {
        data: page.items.map(toSkuDto),
        page: {
          limit,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
        meta: { requestId: request.id },
      };
    },
  );

  // Registered before /api/v1/skus/:id so "lookup" is never parsed as :id
  typedApp.get(
    '/api/v1/skus/lookup',
    {
      schema: {
        querystring: SkuLookupQuerySchema,
      },
    },
    async (request) => {
      const { code } = request.query;
      const sku = await findSkuByIdOrCode(db, { code });
      if (!sku) {
        throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU with code "${code}" not found`);
      }
      return {
        data: sku,
        meta: { requestId: request.id },
      };
    },
  );

  typedApp.get(
    '/api/v1/skus/:id',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params;
      const sku = await findSkuByIdOrCode(db, { skuId: id });
      if (!sku) {
        throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU ${id} not found`);
      }
      return {
        data: sku,
        meta: { requestId: request.id },
      };
    },
  );

  typedApp.patch(
    '/api/v1/skus/:id',
    {
      schema: {
        params: UuidParamSchema,
        body: UpdateSkuSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { productId, unitOfMeasureId, code, name, defaultSellingPrice } = request.body;
      return runCommand(request, reply, { action: 'update', resource: 'sku' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogSkus)
          .where(eq(catalogSkus.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU ${id} not found`);
        }

        if (productId !== undefined) {
          await assertProductExists(ctx.tx, productId);
        }
        if (unitOfMeasureId !== undefined) {
          await assertUnitOfMeasureExists(ctx.tx, unitOfMeasureId);
        }
        if (code !== undefined) {
          await assertNoSkuCodeConflict(ctx.tx, code, id);
        }

        let updated;
        try {
          [updated] = await ctx.tx
            .update(catalogSkus)
            .set({
              ...(productId !== undefined ? { productId } : {}),
              ...(unitOfMeasureId !== undefined ? { unitOfMeasureId } : {}),
              ...(code !== undefined ? { code } : {}),
              ...(name !== undefined ? { name } : {}),
              ...(defaultSellingPrice !== undefined ? { defaultSellingPrice } : {}),
              updatedAt: new Date(),
            })
            .where(eq(catalogSkus.id, id))
            .returning();
        } catch (err) {
          if (getPgErrorCode(err) === '23505') {
            throw new ConflictError(
              ERROR_CODES.SKU_CODE_CONFLICT,
              `SKU code "${code}" is already in use (including archived SKUs)`,
            );
          }
          throw err;
        }

        const dto = toSkuDto(updated!);
        await ctx.emit({
          eventType: 'SkuUpdated',
          aggregateType: 'Sku',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 200 };
      });
    },
  );

  typedApp.post(
    '/api/v1/skus/:id/archive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(request, reply, { action: 'archive', resource: 'sku' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogSkus)
          .where(eq(catalogSkus.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU ${id} not found`);
        }

        const [updated] = await ctx.tx
          .update(catalogSkus)
          .set({ status: 'ARCHIVED', updatedAt: new Date() })
          .where(eq(catalogSkus.id, id))
          .returning();

        const dto = toSkuDto(updated!);
        await ctx.emit({
          eventType: 'SkuArchived',
          aggregateType: 'Sku',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 200 };
      });
    },
  );

  typedApp.post(
    '/api/v1/skus/:id/unarchive',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(request, reply, { action: 'unarchive', resource: 'sku' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogSkus)
          .where(eq(catalogSkus.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU ${id} not found`);
        }

        const [updated] = await ctx.tx
          .update(catalogSkus)
          .set({ status: 'ACTIVE', updatedAt: new Date() })
          .where(eq(catalogSkus.id, id))
          .returning();

        const dto = toSkuDto(updated!);
        await ctx.emit({
          eventType: 'SkuUnarchived',
          aggregateType: 'Sku',
          aggregateId: dto.id,
          payload: dto,
        });
        return { data: dto, statusCode: 200 };
      });
    },
  );

  typedApp.delete(
    '/api/v1/skus/:id',
    {
      schema: {
        params: UuidParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      return runCommand(request, reply, { action: 'delete', resource: 'sku' }, async (ctx) => {
        const [existing] = await ctx.tx
          .select()
          .from(catalogSkus)
          .where(eq(catalogSkus.id, id))
          .limit(1);
        if (!existing) {
          throw new NotFoundError(ERROR_CODES.NOT_FOUND, `SKU ${id} not found`);
        }

        if (await hasSkuReferences(ctx.tx, id)) {
          throw new ConflictError(
            ERROR_CODES.RESOURCE_IN_USE,
            'SKU has dependent records and cannot be deleted; archive it instead',
          );
        }

        try {
          await ctx.tx.delete(catalogSkus).where(eq(catalogSkus.id, id));
        } catch (err) {
          if (getPgErrorCode(err) === '23503') {
            throw new ConflictError(
              ERROR_CODES.RESOURCE_IN_USE,
              'SKU has dependent records and cannot be deleted; archive it instead',
            );
          }
          throw err;
        }

        await ctx.emit({
          eventType: 'SkuDeleted',
          aggregateType: 'Sku',
          aggregateId: id,
          payload: { id },
        });
        return { data: { id, deleted: true }, statusCode: 200 };
      });
    },
  );
}

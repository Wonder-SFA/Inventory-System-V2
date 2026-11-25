import type { Database } from '@iv2/db';
import {
  ConflictError,
  ERROR_CODES,
  NotFoundError,
  type Product,
  type Sku,
  type UnitOfMeasure,
  toMoney,
} from '@iv2/shared-domain';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DbTransaction } from '../../../shared/outbox/index.js';
import {
  type ProductRow,
  type SkuRow,
  type UnitOfMeasureRow,
  catalogProducts,
  catalogSkus,
  catalogUnitsOfMeasure,
} from '../db/index.js';

export type CatalogDbExecutor = Database | DbTransaction;

export type SkuReferenceChecker = (db: CatalogDbExecutor, skuId: string) => Promise<boolean>;

const skuReferenceCheckers = new Set<SkuReferenceChecker>();

export function registerSkuReferenceChecker(checker: SkuReferenceChecker): () => void {
  skuReferenceCheckers.add(checker);
  return () => {
    skuReferenceCheckers.delete(checker);
  };
}

export async function hasSkuReferences(db: CatalogDbExecutor, skuId: string): Promise<boolean> {
  for (const checker of skuReferenceCheckers) {
    if (await checker(db, skuId)) {
      return true;
    }
  }
  return false;
}

export function toUnitOfMeasureDto(row: UnitOfMeasureRow): UnitOfMeasure {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProductDto(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSkuDto(row: SkuRow): Sku {
  return {
    id: row.id,
    productId: row.productId,
    unitOfMeasureId: row.unitOfMeasureId,
    code: row.code,
    name: row.name,
    defaultSellingPrice: row.defaultSellingPrice !== null ? toMoney(row.defaultSellingPrice) : null,
    trackLots: row.trackLots,
    trackExpiry: row.trackExpiry,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function findSkuByIdOrCode(
  db: CatalogDbExecutor,
  query: { skuId?: string | undefined; code?: string | undefined },
): Promise<Sku | null> {
  const conditions = [];
  if (query.skuId !== undefined) {
    conditions.push(eq(catalogSkus.id, query.skuId));
  }
  if (query.code !== undefined) {
    conditions.push(sql`LOWER(${catalogSkus.code}) = LOWER(${query.code})`);
  }
  if (conditions.length === 0) {
    return null;
  }

  const [row] = await db
    .select()
    .from(catalogSkus)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .limit(1);

  return row ? toSkuDto(row) : null;
}

export async function getSkusByIds(
  db: CatalogDbExecutor,
  skuIds: readonly string[],
): Promise<Sku[]> {
  if (skuIds.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(catalogSkus)
    .where(inArray(catalogSkus.id, [...skuIds]));
  return rows.map(toSkuDto);
}

export async function assertNoUnitOfMeasureConflict(
  db: CatalogDbExecutor,
  fields: { code?: string | undefined; name?: string | undefined },
  excludeUnitOfMeasureId?: string,
): Promise<void> {
  const matchers = [];
  if (fields.code !== undefined) {
    matchers.push(sql`LOWER(${catalogUnitsOfMeasure.code}) = LOWER(${fields.code})`);
  }
  if (fields.name !== undefined) {
    matchers.push(sql`LOWER(${catalogUnitsOfMeasure.name}) = LOWER(${fields.name})`);
  }
  if (matchers.length === 0) {
    return;
  }
  const conflictExpr = matchers.length === 1 ? matchers[0]! : or(...matchers)!;
  const where = excludeUnitOfMeasureId
    ? and(conflictExpr, ne(catalogUnitsOfMeasure.id, excludeUnitOfMeasureId))
    : conflictExpr;

  const [existing] = await db
    .select({ id: catalogUnitsOfMeasure.id })
    .from(catalogUnitsOfMeasure)
    .where(where)
    .limit(1);

  if (existing) {
    throw new ConflictError(
      ERROR_CODES.UNIT_OF_MEASURE_CONFLICT,
      'A Unit of Measure with that code or name already exists',
    );
  }
}

export async function assertNoSkuCodeConflict(
  db: CatalogDbExecutor,
  code: string,
  excludeSkuId?: string,
): Promise<void> {
  const codeMatch = sql`LOWER(${catalogSkus.code}) = LOWER(${code})`;
  const where = excludeSkuId ? and(codeMatch, ne(catalogSkus.id, excludeSkuId)) : codeMatch;

  const [existing] = await db
    .select({ id: catalogSkus.id })
    .from(catalogSkus)
    .where(where)
    .limit(1);

  if (existing) {
    throw new ConflictError(
      ERROR_CODES.SKU_CODE_CONFLICT,
      `SKU code "${code}" is already in use (including archived SKUs)`,
    );
  }
}

export async function assertProductExists(db: CatalogDbExecutor, productId: string): Promise<void> {
  const [row] = await db
    .select({ id: catalogProducts.id })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, productId))
    .limit(1);
  if (!row) {
    throw new NotFoundError(ERROR_CODES.NOT_FOUND, `Product ${productId} not found`);
  }
}

export async function assertUnitOfMeasureExists(
  db: CatalogDbExecutor,
  unitOfMeasureId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: catalogUnitsOfMeasure.id })
    .from(catalogUnitsOfMeasure)
    .where(eq(catalogUnitsOfMeasure.id, unitOfMeasureId))
    .limit(1);
  if (!row) {
    throw new NotFoundError(
      ERROR_CODES.NOT_FOUND,
      `Unit of Measure ${unitOfMeasureId} not found`,
    );
  }
}

export async function hasUnitOfMeasureReferences(
  db: CatalogDbExecutor,
  unitOfMeasureId: string,
): Promise<boolean> {
  const [ref] = await db
    .select({ id: catalogSkus.id })
    .from(catalogSkus)
    .where(eq(catalogSkus.unitOfMeasureId, unitOfMeasureId))
    .limit(1);
  return ref !== undefined;
}

export async function hasProductReferences(
  db: CatalogDbExecutor,
  productId: string,
): Promise<boolean> {
  const [ref] = await db
    .select({ id: catalogSkus.id })
    .from(catalogSkus)
    .where(eq(catalogSkus.productId, productId))
    .limit(1);
  return ref !== undefined;
}

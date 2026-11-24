import type { Database } from '@iv2/db';
import {
  ConflictError,
  type CreateSupplierInput,
  ERROR_CODES,
  type ListSuppliersQuery,
  NotFoundError,
  type Supplier,
  type SupplierStatus,
  type UpdateSupplierInput,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, eq } from 'drizzle-orm';
import {
  type DbTransaction,
  applyKeysetOrder,
  getPgErrorCode,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { type SupplierRow, purchaseOrders, suppliers } from '../db/index.js';

export function toSupplierDto(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSuppliers(
  db: Database,
  query: ListSuppliersQuery,
): Promise<{ items: Supplier[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    suppliers.createdAt,
    suppliers.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (query.status) {
    conditions.push(eq(suppliers.status, query.status));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(suppliers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  return {
    items: page.items.map(toSupplierDto),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getSupplierById(
  db: Database | DbTransaction,
  id: string,
): Promise<Supplier> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!row) {
    throw new NotFoundError(ERROR_CODES.SUPPLIER_NOT_FOUND, `Supplier ${id} not found`);
  }
  return toSupplierDto(row);
}

export async function createSupplier(
  tx: DbTransaction,
  input: CreateSupplierInput,
): Promise<Supplier> {
  const id = uuidv7();
  const [created] = await tx
    .insert(suppliers)
    .values({
      id,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      status: 'ACTIVE',
    })
    .returning();

  return toSupplierDto(created!);
}

export async function updateSupplier(
  tx: DbTransaction,
  id: string,
  input: UpdateSupplierInput,
): Promise<Supplier> {
  const [existing] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SUPPLIER_NOT_FOUND, `Supplier ${id} not found`);
  }

  const [updated] = await tx
    .update(suppliers)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, id))
    .returning();

  return toSupplierDto(updated!);
}

export async function setSupplierStatus(
  tx: DbTransaction,
  id: string,
  status: SupplierStatus,
): Promise<Supplier> {
  const [updated] = await tx
    .update(suppliers)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, id))
    .returning();

  if (!updated) {
    throw new NotFoundError(ERROR_CODES.SUPPLIER_NOT_FOUND, `Supplier ${id} not found`);
  }

  return toSupplierDto(updated);
}

export async function hasSupplierReferences(
  db: Database | DbTransaction,
  supplierId: string,
): Promise<boolean> {
  const [ref] = await db
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.supplierId, supplierId))
    .limit(1);
  return Boolean(ref);
}

export async function deleteSupplier(
  tx: DbTransaction,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const [existing] = await tx.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SUPPLIER_NOT_FOUND, `Supplier ${id} not found`);
  }

  if (await hasSupplierReferences(tx, id)) {
    throw new ConflictError(
      ERROR_CODES.RESOURCE_IN_USE,
      'Supplier is referenced by one or more Purchase Orders and cannot be deleted',
    );
  }

  try {
    await tx.delete(suppliers).where(eq(suppliers.id, id));
  } catch (err) {
    if (getPgErrorCode(err) === '23503') {
      throw new ConflictError(
        ERROR_CODES.RESOURCE_IN_USE,
        'Supplier is referenced by existing records and cannot be deleted',
      );
    }
    throw err;
  }

  return { id, deleted: true };
}

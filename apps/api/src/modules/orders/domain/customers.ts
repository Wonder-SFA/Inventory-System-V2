import type { Database } from '@iv2/db';
import {
  ConflictError,
  type CreateCustomerInput,
  type Customer,
  type CustomerStatus,
  ERROR_CODES,
  type ListCustomersQuery,
  NotFoundError,
  type UpdateCustomerInput,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, eq } from 'drizzle-orm';
import {
  type DbTransaction,
  type DomainEventInput,
  applyKeysetOrder,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { type CustomerRow, customers, salesOrders } from '../db/index.js';

export type CustomerEmitEventFn = (event: DomainEventInput) => Promise<void>;

function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof err.code === 'string') {
    return err.code;
  }
  if (typeof err.cause?.code === 'string') {
    return err.cause.code;
  }
  return undefined;
}

export function toCustomerDto(row: CustomerRow): Customer {
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

export async function listCustomers(
  db: Database,
  query: ListCustomersQuery,
): Promise<{ items: Customer[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    customers.createdAt,
    customers.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (query.status) {
    conditions.push(eq(customers.status, query.status));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(customers)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  return {
    items: page.items.map(toCustomerDto),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getCustomerById(
  db: Database | DbTransaction,
  id: string,
): Promise<Customer> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!row) {
    throw new NotFoundError(ERROR_CODES.CUSTOMER_NOT_FOUND, `Customer ${id} not found`);
  }
  return toCustomerDto(row);
}

export async function createCustomer(
  tx: DbTransaction,
  input: CreateCustomerInput,
  emit?: CustomerEmitEventFn,
): Promise<Customer> {
  const id = uuidv7();
  const [created] = await tx
    .insert(customers)
    .values({
      id,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      status: 'ACTIVE',
    })
    .returning();

  const dto = toCustomerDto(created!);
  if (emit) {
    await emit({
      eventType: 'CustomerCreated',
      aggregateType: 'customer',
      aggregateId: dto.id,
      payload: { id: dto.id, status: dto.status },
    });
  }
  return dto;
}

export async function updateCustomer(
  tx: DbTransaction,
  id: string,
  input: UpdateCustomerInput,
  emit?: CustomerEmitEventFn,
): Promise<Customer> {
  const [existing] = await tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!existing) {
    throw new NotFoundError(ERROR_CODES.CUSTOMER_NOT_FOUND, `Customer ${id} not found`);
  }

  const [updated] = await tx
    .update(customers)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, id))
    .returning();

  const dto = toCustomerDto(updated!);
  if (emit) {
    await emit({
      eventType: 'CustomerUpdated',
      aggregateType: 'customer',
      aggregateId: dto.id,
      payload: { id: dto.id, status: dto.status },
    });
  }
  return dto;
}

export async function setCustomerStatus(
  tx: DbTransaction,
  id: string,
  status: CustomerStatus,
  emit?: CustomerEmitEventFn,
): Promise<Customer> {
  const [updated] = await tx
    .update(customers)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, id))
    .returning();

  if (!updated) {
    throw new NotFoundError(ERROR_CODES.CUSTOMER_NOT_FOUND, `Customer ${id} not found`);
  }

  const dto = toCustomerDto(updated);
  if (emit) {
    await emit({
      eventType: status === 'ARCHIVED' ? 'CustomerArchived' : 'CustomerUnarchived',
      aggregateType: 'customer',
      aggregateId: dto.id,
      payload: { id: dto.id, status: dto.status },
    });
  }
  return dto;
}

export async function hasCustomerReferences(
  db: Database | DbTransaction,
  customerId: string,
): Promise<boolean> {
  const [ref] = await db
    .select({ id: salesOrders.id })
    .from(salesOrders)
    .where(eq(salesOrders.customerId, customerId))
    .limit(1);
  return Boolean(ref);
}

export async function deleteCustomer(
  tx: DbTransaction,
  id: string,
  emit?: CustomerEmitEventFn,
): Promise<{ id: string; deleted: true }> {
  const [existing] = await tx.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!existing) {
    throw new NotFoundError(ERROR_CODES.CUSTOMER_NOT_FOUND, `Customer ${id} not found`);
  }

  if (await hasCustomerReferences(tx, id)) {
    throw new ConflictError(
      ERROR_CODES.RESOURCE_IN_USE,
      'Customer is referenced by one or more Sales Orders and cannot be deleted',
    );
  }

  try {
    await tx.delete(customers).where(eq(customers.id, id));
  } catch (err) {
    if (getPgErrorCode(err) === '23503') {
      throw new ConflictError(
        ERROR_CODES.RESOURCE_IN_USE,
        'Customer is referenced by existing records and cannot be deleted',
      );
    }
    throw err;
  }

  if (emit) {
    await emit({
      eventType: 'CustomerDeleted',
      aggregateType: 'customer',
      aggregateId: id,
      payload: { id },
    });
  }

  return { id, deleted: true };
}

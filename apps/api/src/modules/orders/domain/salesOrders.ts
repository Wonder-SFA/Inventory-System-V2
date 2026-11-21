import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  ConflictError,
  type CreateSalesOrderInput,
  ERROR_CODES,
  type ListSalesOrdersQuery,
  NotFoundError,
  type Quantity,
  type ReturnSalesOrderInput,
  type ReturnSalesOrderResult,
  type SalesOrder,
  type SalesOrderLine,
  type ShipSalesOrderInput,
  type ShipSalesOrderResult,
  type UUID,
  type UpdateSalesOrderInput,
  ValidationError,
  ZERO_DECIMAL4,
  add,
  gt,
  gte,
  isPositive,
  negate,
  sub,
  toMoney,
  toQuantity,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, asc, eq, inArray } from 'drizzle-orm';
import {
  type DbTransaction,
  applyKeysetOrder,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { getSkusByIds } from '../../catalog/public/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import {
  type PostMovementLine,
  type ReserveStockLine,
  getLocationById,
  getLocationsByIds,
  postMovements,
  releaseReservation,
  reserveStock,
} from '../../inventory/public/index.js';
import {
  type SalesOrderLineRow,
  type SalesOrderRow,
  customers,
  salesOrderLines,
  salesOrders,
} from '../db/index.js';
import { getCustomerById } from './customers.js';
import type { OrderEmitEventFn } from './purchaseOrders.js';

function buildLocationScopeFilter(scope: LocationScope): { empty: boolean; condition?: SQL } {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    return { empty: false, condition: inArray(salesOrders.locationId, [...scope.locationIds]) };
  }
  return { empty: true };
}

function toSalesOrderLineDto(
  row: SalesOrderLineRow,
  skuMeta?: { code: string; name: string },
): SalesOrderLine {
  return {
    id: row.id,
    salesOrderId: row.salesOrderId,
    skuId: row.skuId,
    ...(skuMeta ? { skuCode: skuMeta.code, skuName: skuMeta.name } : {}),
    orderedQty: toQuantity(row.orderedQty),
    fulfilledQty: toQuantity(row.fulfilledQty),
    returnedQty: toQuantity(row.returnedQty),
    unitPrice: toMoney(row.unitPrice),
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function enrichSalesOrders(
  db: Database | DbTransaction,
  rows: readonly SalesOrderRow[],
): Promise<SalesOrder[]> {
  if (rows.length === 0) {
    return [];
  }

  const soIds = rows.map((r) => r.id);
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const locationIds = [...new Set(rows.map((r) => r.locationId))];

  const [lineRows, customerRows, locationDtos] = await Promise.all([
    db
      .select()
      .from(salesOrderLines)
      .where(inArray(salesOrderLines.salesOrderId, soIds))
      .orderBy(asc(salesOrderLines.createdAt), asc(salesOrderLines.id)),
    db.select().from(customers).where(inArray(customers.id, customerIds)),
    getLocationsByIds(db, { allLocations: true }, locationIds),
  ]);

  const skuIds = [...new Set(lineRows.map((l) => l.skuId))];
  const skuDtos = await getSkusByIds(db, skuIds);

  const customerMap = new Map(customerRows.map((c) => [c.id, c.name]));
  const locationMap = new Map(locationDtos.map((l) => [l.id, l.name]));
  const skuMap = new Map(skuDtos.map((s) => [s.id, { code: s.code, name: s.name }]));

  const linesBySoId = new Map<string, SalesOrderLine[]>();
  for (const lineRow of lineRows) {
    const list = linesBySoId.get(lineRow.salesOrderId) ?? [];
    list.push(toSalesOrderLineDto(lineRow, skuMap.get(lineRow.skuId)));
    linesBySoId.set(lineRow.salesOrderId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    customerId: row.customerId,
    ...(customerMap.has(row.customerId) ? { customerName: customerMap.get(row.customerId) } : {}),
    locationId: row.locationId,
    ...(locationMap.has(row.locationId) ? { locationName: locationMap.get(row.locationId) } : {}),
    status: row.status,
    version: row.version,
    note: row.note ?? null,
    lines: linesBySoId.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function assertLocationExists(tx: DbTransaction, locationId: string): Promise<void> {
  const loc = await getLocationById(tx, { allLocations: true }, locationId);
  if (!loc) {
    throw new NotFoundError(ERROR_CODES.LOCATION_NOT_FOUND, `Location ${locationId} not found`);
  }
}

async function assertSkusExist(tx: DbTransaction, skuIds: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(skuIds)];
  const found = await getSkusByIds(tx, uniqueIds);
  if (found.length !== uniqueIds.length) {
    const foundSet = new Set(found.map((s) => s.id));
    const missing = uniqueIds.find((id) => !foundSet.has(id));
    throw new NotFoundError(ERROR_CODES.SKU_NOT_FOUND, `SKU ${missing} not found`);
  }
}

export async function listSalesOrders(
  db: Database,
  scope: LocationScope,
  query: ListSalesOrdersQuery,
): Promise<{ items: SalesOrder[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    salesOrders.createdAt,
    salesOrders.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.status) {
    conditions.push(eq(salesOrders.status, query.status));
  }
  if (query.locationId) {
    conditions.push(eq(salesOrders.locationId, query.locationId));
  }
  if (query.customerId) {
    conditions.push(eq(salesOrders.customerId, query.customerId));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(salesOrders)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  const items = await enrichSalesOrders(db, page.items);

  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getSalesOrderById(
  db: Database | DbTransaction,
  scope: LocationScope,
  id: string,
): Promise<SalesOrder> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  const conditions: SQL[] = [eq(salesOrders.id, id)];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }

  const [row] = await db
    .select()
    .from(salesOrders)
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  const [enriched] = await enrichSalesOrders(db, [row]);
  return enriched!;
}

export async function createSalesOrder(
  tx: DbTransaction,
  input: CreateSalesOrderInput,
  emit?: OrderEmitEventFn,
): Promise<SalesOrder> {
  await getCustomerById(tx, input.customerId);
  await assertLocationExists(tx, input.locationId);
  await assertSkusExist(
    tx,
    input.lines.map((l) => l.skuId),
  );

  const salesOrderId = uuidv7();
  const orderNumber =
    input.orderNumber ??
    `SLS-${Date.now().toString(36).toUpperCase()}-${salesOrderId.slice(-4).toUpperCase()}`;

  const [createdOrder] = await tx
    .insert(salesOrders)
    .values({
      id: salesOrderId,
      orderNumber,
      customerId: input.customerId,
      locationId: input.locationId,
      status: 'DRAFT',
      version: 1,
      note: input.note ?? null,
    })
    .returning();

  await tx.insert(salesOrderLines).values(
    input.lines.map((line) => ({
      id: uuidv7(),
      salesOrderId,
      skuId: line.skuId,
      orderedQty: line.orderedQty,
      fulfilledQty: ZERO_DECIMAL4,
      returnedQty: ZERO_DECIMAL4,
      unitPrice: line.unitPrice,
      currency: line.currency,
    })),
  );

  const [enriched] = await enrichSalesOrders(tx, [createdOrder!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'SalesOrderCreated',
      aggregateType: 'sales_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function updateSalesOrder(
  tx: DbTransaction,
  id: string,
  input: UpdateSalesOrderInput,
  emit?: OrderEmitEventFn,
): Promise<SalesOrder> {
  const [existing] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order cannot be edited in ${existing.status} status`,
    );
  }

  if (existing.version !== input.expectedVersion) {
    throw new ConflictError(
      ERROR_CODES.STALE_VERSION,
      `Sales Order version mismatch: expected ${input.expectedVersion}, actual ${existing.version}`,
    );
  }

  if (input.customerId !== undefined) {
    await getCustomerById(tx, input.customerId);
  }
  if (input.locationId !== undefined) {
    await assertLocationExists(tx, input.locationId);
  }
  if (input.lines !== undefined) {
    await assertSkusExist(
      tx,
      input.lines.map((l) => l.skuId),
    );
    await tx.delete(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id));
    await tx.insert(salesOrderLines).values(
      input.lines.map((line) => ({
        id: uuidv7(),
        salesOrderId: id,
        skuId: line.skuId,
        orderedQty: line.orderedQty,
        fulfilledQty: ZERO_DECIMAL4,
        returnedQty: ZERO_DECIMAL4,
        unitPrice: line.unitPrice,
        currency: line.currency,
      })),
    );
  }

  const [updated] = await tx
    .update(salesOrders)
    .set({
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, id))
    .returning();

  const [enriched] = await enrichSalesOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'SalesOrderUpdated',
      aggregateType: 'sales_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function confirmSalesOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<{ order: SalesOrder; warnings: ApiWarning[] }> {
  const [existing] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order cannot be confirmed from ${existing.status} status`,
    );
  }

  const lineRows = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, existing.id))
    .for('update');

  const reserveLines: ReserveStockLine[] = lineRows.map((line) => ({
    skuId: line.skuId,
    locationId: existing.locationId,
    quantity: toQuantity(line.orderedQty),
    referenceType: 'SALES_ORDER',
    referenceId: existing.id,
  }));

  const reserved = await reserveStock(tx, reserveLines, { emit });

  const [updated] = await tx
    .update(salesOrders)
    .set({
      status: 'CONFIRMED',
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, id))
    .returning();

  const [enriched] = await enrichSalesOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderConfirmed',
      aggregateType: 'sales_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return { order: dto, warnings: reserved.warnings };
}

export async function shipSalesOrder(
  tx: DbTransaction,
  id: string,
  input: ShipSalesOrderInput,
  options: {
    actorId: string;
    deriveLineIdempotencyKey: (lineId: string) => UUID;
    emit?: OrderEmitEventFn;
  },
): Promise<{ result: ShipSalesOrderResult; warnings: ApiWarning[] }> {
  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!so) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (so.status !== 'CONFIRMED' && so.status !== 'PARTIALLY_SHIPPED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order cannot be shipped in ${so.status} status`,
    );
  }

  const soLineRows = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .for('update');

  const lineById = new Map<string, SalesOrderLineRow>(soLineRows.map((l) => [l.id, l]));
  const incomingQtyByLineId = new Map<string, Quantity>();

  for (const reqLine of input.lines) {
    if (!lineById.has(reqLine.orderLineId)) {
      throw new NotFoundError(
        ERROR_CODES.SALES_ORDER_LINE_NOT_FOUND,
        `Sales Order line ${reqLine.orderLineId} not found on order ${so.id}`,
      );
    }
    const prev = incomingQtyByLineId.get(reqLine.orderLineId) ?? toQuantity(ZERO_DECIMAL4);
    incomingQtyByLineId.set(reqLine.orderLineId, add(prev, reqLine.quantity));
  }

  for (const [lineId, shipQty] of incomingQtyByLineId.entries()) {
    const line = lineById.get(lineId)!;
    const orderedQty = toQuantity(line.orderedQty);
    const currentFulfilled = toQuantity(line.fulfilledQty);
    const nextFulfilled = add(currentFulfilled, shipQty);

    if (gt(nextFulfilled, orderedQty)) {
      throw new ValidationError(
        ERROR_CODES.OVER_SHIP_NOT_ALLOWED,
        `Shipping ${shipQty} on line ${lineId} would bring fulfilled quantity to ${nextFulfilled}, exceeding ordered quantity ${orderedQty}.`,
        [
          {
            field: 'lines',
            code: ERROR_CODES.OVER_SHIP_NOT_ALLOWED,
            message: `Cumulative shipped (${nextFulfilled}) exceeds ordered (${orderedQty})`,
          },
        ],
      );
    }
  }

  const releaseLines: ReserveStockLine[] = input.lines.map((reqLine) => {
    const line = lineById.get(reqLine.orderLineId)!;
    return {
      skuId: line.skuId,
      locationId: so.locationId,
      quantity: reqLine.quantity,
      referenceType: 'SALES_ORDER',
      referenceId: so.id,
    };
  });

  await releaseReservation(tx, releaseLines, { emit: options.emit });

  const lineOccurrenceCount = new Map<string, number>();
  const movementLines: PostMovementLine[] = input.lines.map((reqLine) => {
    const line = lineById.get(reqLine.orderLineId)!;
    const count = (lineOccurrenceCount.get(line.id) ?? 0) + 1;
    lineOccurrenceCount.set(line.id, count);
    const keySeed = count === 1 ? line.id : `${line.id}:${count}`;

    return {
      type: 'ISSUE',
      skuId: line.skuId,
      locationId: so.locationId,
      quantityDelta: negate(reqLine.quantity) as Quantity,
      currency: line.currency,
      note: input.note ?? null,
      referenceType: 'SALES_ORDER',
      referenceId: so.id,
      actorId: options.actorId,
      idempotencyKey: options.deriveLineIdempotencyKey(keySeed),
    };
  });

  const posted = await postMovements(tx, movementLines, { emit: options.emit });

  const now = new Date();
  const updatedFulfilledByLineId = new Map<string, Quantity>();
  for (const line of soLineRows) {
    const delta = incomingQtyByLineId.get(line.id);
    if (delta) {
      const nextFulfilled = add(toQuantity(line.fulfilledQty), delta);
      updatedFulfilledByLineId.set(line.id, nextFulfilled);
      await tx
        .update(salesOrderLines)
        .set({
          fulfilledQty: nextFulfilled,
          updatedAt: now,
        })
        .where(eq(salesOrderLines.id, line.id));
    } else {
      updatedFulfilledByLineId.set(line.id, toQuantity(line.fulfilledQty));
    }
  }

  const allLinesFulfilled = soLineRows.every((line) => {
    const fulfilled = updatedFulfilledByLineId.get(line.id) ?? toQuantity(line.fulfilledQty);
    return gte(fulfilled, toQuantity(line.orderedQty));
  });

  const nextStatus = allLinesFulfilled ? 'SHIPPED' : 'PARTIALLY_SHIPPED';

  await tx
    .update(salesOrders)
    .set({
      status: nextStatus,
      updatedAt: now,
    })
    .where(eq(salesOrders.id, so.id));

  const result: ShipSalesOrderResult = {
    salesOrderId: so.id,
    status: nextStatus,
    movements: posted.movements,
  };

  if (options.emit) {
    await options.emit({
      eventType: 'SalesOrderShipped',
      aggregateType: 'sales_order',
      aggregateId: so.id,
      payload: { ...result, locationId: so.locationId },
    });
  }

  return {
    result,
    warnings: posted.warnings,
  };
}

export async function deliverSalesOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<SalesOrder> {
  const [existing] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (existing.status !== 'SHIPPED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order can only be marked Delivered from SHIPPED status (current: ${existing.status})`,
    );
  }

  const [updated] = await tx
    .update(salesOrders)
    .set({
      status: 'DELIVERED',
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, id))
    .returning();

  const [enriched] = await enrichSalesOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'SalesOrderDelivered',
      aggregateType: 'sales_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function returnSalesOrder(
  tx: DbTransaction,
  id: string,
  input: ReturnSalesOrderInput,
  options: {
    actorId: string;
    deriveLineIdempotencyKey: (lineId: string) => UUID;
    emit?: OrderEmitEventFn;
  },
): Promise<{ result: ReturnSalesOrderResult; warnings: ApiWarning[] }> {
  const [so] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!so) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (
    so.status !== 'PARTIALLY_SHIPPED' &&
    so.status !== 'SHIPPED' &&
    so.status !== 'DELIVERED'
  ) {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order cannot accept returns in ${so.status} status`,
    );
  }

  const soLineRows = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, so.id))
    .for('update');

  const lineById = new Map<string, SalesOrderLineRow>(soLineRows.map((l) => [l.id, l]));
  const incomingQtyByLineId = new Map<string, Quantity>();

  for (const reqLine of input.lines) {
    if (!lineById.has(reqLine.orderLineId)) {
      throw new NotFoundError(
        ERROR_CODES.SALES_ORDER_LINE_NOT_FOUND,
        `Sales Order line ${reqLine.orderLineId} not found on order ${so.id}`,
      );
    }
    const prev = incomingQtyByLineId.get(reqLine.orderLineId) ?? toQuantity(ZERO_DECIMAL4);
    incomingQtyByLineId.set(reqLine.orderLineId, add(prev, reqLine.quantity));
  }

  for (const [lineId, returnQty] of incomingQtyByLineId.entries()) {
    const line = lineById.get(lineId)!;
    const fulfilledQty = toQuantity(line.fulfilledQty);
    const currentReturned = toQuantity(line.returnedQty);
    const nextReturned = add(currentReturned, returnQty);

    if (gt(nextReturned, fulfilledQty)) {
      throw new ValidationError(
        ERROR_CODES.OVER_RETURN_NOT_ALLOWED,
        `Returning ${returnQty} on line ${lineId} would bring returned quantity to ${nextReturned}, exceeding fulfilled quantity ${fulfilledQty}.`,
        [
          {
            field: 'lines',
            code: ERROR_CODES.OVER_RETURN_NOT_ALLOWED,
            message: `Cumulative returned (${nextReturned}) exceeds fulfilled (${fulfilledQty})`,
          },
        ],
      );
    }
  }

  const lineOccurrenceCount = new Map<string, number>();
  const movementLines: PostMovementLine[] = input.lines.map((reqLine) => {
    const line = lineById.get(reqLine.orderLineId)!;
    const count = (lineOccurrenceCount.get(line.id) ?? 0) + 1;
    lineOccurrenceCount.set(line.id, count);
    const keySeed = count === 1 ? line.id : `${line.id}:${count}`;

    return {
      type: 'RECEIPT',
      skuId: line.skuId,
      locationId: so.locationId,
      quantityDelta: reqLine.quantity,
      currency: line.currency,
      reasonCategory: 'CUSTOMER_RETURN',
      note: input.note ?? null,
      referenceType: 'SALES_ORDER',
      referenceId: so.id,
      actorId: options.actorId,
      idempotencyKey: options.deriveLineIdempotencyKey(keySeed),
    };
  });

  const posted = await postMovements(tx, movementLines, { emit: options.emit });

  const now = new Date();
  for (const line of soLineRows) {
    const delta = incomingQtyByLineId.get(line.id);
    if (delta) {
      const nextReturned = add(toQuantity(line.returnedQty), delta);
      await tx
        .update(salesOrderLines)
        .set({
          returnedQty: nextReturned,
          updatedAt: now,
        })
        .where(eq(salesOrderLines.id, line.id));
    }
  }

  await tx
    .update(salesOrders)
    .set({ updatedAt: now })
    .where(eq(salesOrders.id, so.id));

  const result: ReturnSalesOrderResult = {
    salesOrderId: so.id,
    status: so.status,
    movements: posted.movements,
  };

  if (options.emit) {
    await options.emit({
      eventType: 'SalesOrderReturned',
      aggregateType: 'sales_order',
      aggregateId: so.id,
      payload: { ...result, locationId: so.locationId },
    });
  }

  return {
    result,
    warnings: posted.warnings,
  };
}

export async function cancelSalesOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<SalesOrder> {
  const [existing] = await tx
    .select()
    .from(salesOrders)
    .where(eq(salesOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.SALES_ORDER_NOT_FOUND, `Sales Order ${id} not found`);
  }

  if (
    existing.status !== 'DRAFT' &&
    existing.status !== 'CONFIRMED' &&
    existing.status !== 'PARTIALLY_SHIPPED'
  ) {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Sales Order cannot be cancelled from ${existing.status} status`,
    );
  }

  if (existing.status === 'CONFIRMED' || existing.status === 'PARTIALLY_SHIPPED') {
    const lineRows = await tx
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, existing.id))
      .for('update');

    const releaseLines: ReserveStockLine[] = [];
    for (const line of lineRows) {
      const remaining = sub(toQuantity(line.orderedQty), toQuantity(line.fulfilledQty));
      if (isPositive(remaining)) {
        releaseLines.push({
          skuId: line.skuId,
          locationId: existing.locationId,
          quantity: remaining,
          referenceType: 'SALES_ORDER',
          referenceId: existing.id,
        });
      }
    }

    if (releaseLines.length > 0) {
      await releaseReservation(tx, releaseLines, { emit });
    }
  }

  const [updated] = await tx
    .update(salesOrders)
    .set({
      status: 'CANCELLED',
      updatedAt: new Date(),
    })
    .where(eq(salesOrders.id, id))
    .returning();

  const [enriched] = await enrichSalesOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderCancelled',
      aggregateType: 'sales_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

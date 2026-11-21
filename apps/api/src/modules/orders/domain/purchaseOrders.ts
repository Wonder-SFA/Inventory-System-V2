import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  ConflictError,
  type CreatePurchaseOrderInput,
  ERROR_CODES,
  type ListPurchaseOrdersQuery,
  NotFoundError,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Quantity,
  type ReceivePurchaseOrderInput,
  type ReceivePurchaseOrderResult,
  type UUID,
  type UpdatePurchaseOrderInput,
  ValidationError,
  WARNING_CODES,
  ZERO_DECIMAL4,
  add,
  gt,
  gte,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, asc, eq, inArray } from 'drizzle-orm';
import {
  type DbTransaction,
  type DomainEventInput,
  applyKeysetOrder,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { getSkusByIds, registerSkuReferenceChecker } from '../../catalog/public/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import {
  type PostMovementLine,
  getLocationById,
  getLocationsByIds,
  postMovements,
  registerLocationReferenceChecker,
} from '../../inventory/public/index.js';
import {
  type PurchaseOrderLineRow,
  type PurchaseOrderRow,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  suppliers,
} from '../db/index.js';
import { getSupplierById } from './suppliers.js';

export type OrderEmitEventFn = (event: DomainEventInput) => Promise<void>;

let referenceCheckersRegistered = false;

export async function hasOrderSkuReferences(
  db: Database | DbTransaction,
  skuId: string,
): Promise<boolean> {
  const [poRef] = await db
    .select({ id: purchaseOrderLines.id })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.skuId, skuId))
    .limit(1);
  if (poRef) {
    return true;
  }
  const [soRef] = await db
    .select({ id: salesOrderLines.id })
    .from(salesOrderLines)
    .where(eq(salesOrderLines.skuId, skuId))
    .limit(1);
  return Boolean(soRef);
}

export async function hasOrderLocationReferences(
  db: Database | DbTransaction,
  locationId: string,
): Promise<boolean> {
  const [poRef] = await db
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.locationId, locationId))
    .limit(1);
  if (poRef) {
    return true;
  }
  const [soRef] = await db
    .select({ id: salesOrders.id })
    .from(salesOrders)
    .where(eq(salesOrders.locationId, locationId))
    .limit(1);
  return Boolean(soRef);
}

export function registerOrdersReferenceCheckers(): void {
  if (referenceCheckersRegistered) {
    return;
  }
  registerSkuReferenceChecker(hasOrderSkuReferences);
  registerLocationReferenceChecker(hasOrderLocationReferences);
  referenceCheckersRegistered = true;
}

function buildLocationScopeFilter(scope: LocationScope): { empty: boolean; condition?: SQL } {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    return { empty: false, condition: inArray(purchaseOrders.locationId, [...scope.locationIds]) };
  }
  return { empty: true };
}

function toPurchaseOrderLineDto(
  row: PurchaseOrderLineRow,
  skuMeta?: { code: string; name: string },
): PurchaseOrderLine {
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    skuId: row.skuId,
    ...(skuMeta ? { skuCode: skuMeta.code, skuName: skuMeta.name } : {}),
    orderedQty: toQuantity(row.orderedQty),
    fulfilledQty: toQuantity(row.fulfilledQty),
    unitCost: toUnitCost(row.unitCost),
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function enrichPurchaseOrders(
  db: Database | DbTransaction,
  rows: readonly PurchaseOrderRow[],
): Promise<PurchaseOrder[]> {
  if (rows.length === 0) {
    return [];
  }

  const poIds = rows.map((r) => r.id);
  const supplierIds = [...new Set(rows.map((r) => r.supplierId))];
  const locationIds = [...new Set(rows.map((r) => r.locationId))];

  const [lineRows, supplierRows, locationDtos] = await Promise.all([
    db
      .select()
      .from(purchaseOrderLines)
      .where(inArray(purchaseOrderLines.purchaseOrderId, poIds))
      .orderBy(asc(purchaseOrderLines.createdAt), asc(purchaseOrderLines.id)),
    db.select().from(suppliers).where(inArray(suppliers.id, supplierIds)),
    getLocationsByIds(db, { allLocations: true }, locationIds),
  ]);

  const skuIds = [...new Set(lineRows.map((l) => l.skuId))];
  const skuDtos = await getSkusByIds(db, skuIds);

  const supplierMap = new Map(supplierRows.map((s) => [s.id, s.name]));
  const locationMap = new Map(locationDtos.map((l) => [l.id, l.name]));
  const skuMap = new Map(skuDtos.map((s) => [s.id, { code: s.code, name: s.name }]));

  const linesByPoId = new Map<string, PurchaseOrderLine[]>();
  for (const lineRow of lineRows) {
    const list = linesByPoId.get(lineRow.purchaseOrderId) ?? [];
    list.push(toPurchaseOrderLineDto(lineRow, skuMap.get(lineRow.skuId)));
    linesByPoId.set(lineRow.purchaseOrderId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    supplierId: row.supplierId,
    ...(supplierMap.has(row.supplierId) ? { supplierName: supplierMap.get(row.supplierId) } : {}),
    locationId: row.locationId,
    ...(locationMap.has(row.locationId) ? { locationName: locationMap.get(row.locationId) } : {}),
    status: row.status,
    version: row.version,
    note: row.note ?? null,
    lines: linesByPoId.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function assertLocationExists(
  tx: DbTransaction,
  locationId: string,
): Promise<void> {
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

export async function listPurchaseOrders(
  db: Database,
  scope: LocationScope,
  query: ListPurchaseOrdersQuery,
): Promise<{ items: PurchaseOrder[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    purchaseOrders.createdAt,
    purchaseOrders.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.status) {
    conditions.push(eq(purchaseOrders.status, query.status));
  }
  if (query.locationId) {
    conditions.push(eq(purchaseOrders.locationId, query.locationId));
  }
  if (query.supplierId) {
    conditions.push(eq(purchaseOrders.supplierId, query.supplierId));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(purchaseOrders)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  const items = await enrichPurchaseOrders(db, page.items);

  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getPurchaseOrderById(
  db: Database | DbTransaction,
  scope: LocationScope,
  id: string,
): Promise<PurchaseOrder> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  const conditions: SQL[] = [eq(purchaseOrders.id, id)];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }

  const [row] = await db
    .select()
    .from(purchaseOrders)
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  const [enriched] = await enrichPurchaseOrders(db, [row]);
  return enriched!;
}

export async function createPurchaseOrder(
  tx: DbTransaction,
  input: CreatePurchaseOrderInput,
): Promise<PurchaseOrder> {
  await getSupplierById(tx, input.supplierId);
  await assertLocationExists(tx, input.locationId);
  await assertSkusExist(
    tx,
    input.lines.map((l) => l.skuId),
  );

  const poId = uuidv7();
  const orderNumber =
    input.orderNumber ?? `PO-${Date.now().toString(36).toUpperCase()}-${poId.slice(-4).toUpperCase()}`;

  const [createdPo] = await tx
    .insert(purchaseOrders)
    .values({
      id: poId,
      orderNumber,
      supplierId: input.supplierId,
      locationId: input.locationId,
      status: 'DRAFT',
      version: 1,
      note: input.note ?? null,
    })
    .returning();

  await tx.insert(purchaseOrderLines).values(
    input.lines.map((line) => ({
      id: uuidv7(),
      purchaseOrderId: poId,
      skuId: line.skuId,
      orderedQty: line.orderedQty,
      fulfilledQty: ZERO_DECIMAL4,
      unitCost: line.unitCost,
      currency: line.currency,
    })),
  );

  const [enriched] = await enrichPurchaseOrders(tx, [createdPo!]);
  return enriched!;
}

export async function updatePurchaseOrder(
  tx: DbTransaction,
  id: string,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrder> {
  const [existing] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Purchase Order cannot be edited in ${existing.status} status`,
    );
  }

  if (existing.version !== input.expectedVersion) {
    throw new ConflictError(
      ERROR_CODES.STALE_VERSION,
      `Purchase Order version mismatch: expected ${input.expectedVersion}, actual ${existing.version}`,
    );
  }

  if (input.supplierId !== undefined) {
    await getSupplierById(tx, input.supplierId);
  }
  if (input.locationId !== undefined) {
    await assertLocationExists(tx, input.locationId);
  }
  if (input.lines !== undefined) {
    await assertSkusExist(
      tx,
      input.lines.map((l) => l.skuId),
    );
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id));
    await tx.insert(purchaseOrderLines).values(
      input.lines.map((line) => ({
        id: uuidv7(),
        purchaseOrderId: id,
        skuId: line.skuId,
        orderedQty: line.orderedQty,
        fulfilledQty: ZERO_DECIMAL4,
        unitCost: line.unitCost,
        currency: line.currency,
      })),
    );
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId } : {}),
      ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, id))
    .returning();

  const [enriched] = await enrichPurchaseOrders(tx, [updated!]);
  return enriched!;
}

export async function confirmPurchaseOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<PurchaseOrder> {
  const [existing] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Purchase Order cannot be confirmed from ${existing.status} status`,
    );
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      status: 'CONFIRMED',
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, id))
    .returning();

  const [enriched] = await enrichPurchaseOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderConfirmed',
      aggregateType: 'purchase_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function receivePurchaseOrder(
  tx: DbTransaction,
  id: string,
  input: ReceivePurchaseOrderInput,
  options: {
    actorId: string;
    deriveLineIdempotencyKey: (lineId: string) => UUID;
    emit?: OrderEmitEventFn;
  },
): Promise<{ result: ReceivePurchaseOrderResult; warnings: ApiWarning[] }> {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .for('update')
    .limit(1);

  if (!po) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  if (po.status !== 'CONFIRMED' && po.status !== 'PARTIALLY_RECEIVED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Purchase Order cannot be received in ${po.status} status`,
    );
  }

  const poLineRows = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .for('update');

  const lineById = new Map<string, PurchaseOrderLineRow>(poLineRows.map((l) => [l.id, l]));
  const incomingQtyByLineId = new Map<string, Quantity>();

  for (const reqLine of input.lines) {
    if (!lineById.has(reqLine.orderLineId)) {
      throw new NotFoundError(
        ERROR_CODES.PURCHASE_ORDER_LINE_NOT_FOUND,
        `Purchase Order line ${reqLine.orderLineId} not found on order ${po.id}`,
      );
    }
    const prev = incomingQtyByLineId.get(reqLine.orderLineId) ?? toQuantity(ZERO_DECIMAL4);
    incomingQtyByLineId.set(reqLine.orderLineId, add(prev, reqLine.quantity));
  }

  const overReceiveWarnings: ApiWarning[] = [];
  for (const [lineId, receiveQty] of incomingQtyByLineId.entries()) {
    const line = lineById.get(lineId)!;
    const orderedQty = toQuantity(line.orderedQty);
    const currentFulfilled = toQuantity(line.fulfilledQty);
    const nextFulfilled = add(currentFulfilled, receiveQty);

    if (gt(nextFulfilled, orderedQty)) {
      if (!input.allowOverReceive) {
        throw new ValidationError(
          ERROR_CODES.OVER_RECEIVE_CONFIRMATION_REQUIRED,
          `Receiving ${receiveQty} on line ${lineId} would bring fulfilled quantity to ${nextFulfilled}, exceeding ordered quantity ${orderedQty}. Set allowOverReceive: true to confirm.`,
          [
            {
              field: 'allowOverReceive',
              code: ERROR_CODES.OVER_RECEIVE_CONFIRMATION_REQUIRED,
              message: `Cumulative received (${nextFulfilled}) exceeds ordered (${orderedQty})`,
            },
          ],
        );
      }

      overReceiveWarnings.push({
        code: WARNING_CODES.PURCHASE_ORDER_OVER_RECEIVED,
        message: `Received ${nextFulfilled} vs ordered ${orderedQty} on line ${lineId}.`,
        orderLineId: lineId,
      });
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
      locationId: po.locationId,
      quantityDelta: reqLine.quantity,
      unitCost: reqLine.unitCost ?? toUnitCost(line.unitCost),
      currency: reqLine.currency ?? line.currency,
      note: input.note ?? null,
      referenceType: 'PURCHASE_ORDER',
      referenceId: po.id,
      actorId: options.actorId,
      idempotencyKey: options.deriveLineIdempotencyKey(keySeed),
    };
  });

  const posted = await postMovements(tx, movementLines, { emit: options.emit });

  const now = new Date();
  const updatedFulfilledByLineId = new Map<string, Quantity>();
  for (const line of poLineRows) {
    const delta = incomingQtyByLineId.get(line.id);
    if (delta) {
      const nextFulfilled = add(toQuantity(line.fulfilledQty), delta);
      updatedFulfilledByLineId.set(line.id, nextFulfilled);
      await tx
        .update(purchaseOrderLines)
        .set({
          fulfilledQty: nextFulfilled,
          updatedAt: now,
        })
        .where(eq(purchaseOrderLines.id, line.id));
    } else {
      updatedFulfilledByLineId.set(line.id, toQuantity(line.fulfilledQty));
    }
  }

  const allLinesFulfilled = poLineRows.every((line) => {
    const fulfilled = updatedFulfilledByLineId.get(line.id) ?? toQuantity(line.fulfilledQty);
    return gte(fulfilled, toQuantity(line.orderedQty));
  });

  const nextStatus = allLinesFulfilled ? 'RECEIVED' : 'PARTIALLY_RECEIVED';

  await tx
    .update(purchaseOrders)
    .set({
      status: nextStatus,
      updatedAt: now,
    })
    .where(eq(purchaseOrders.id, po.id));

  const result: ReceivePurchaseOrderResult = {
    purchaseOrderId: po.id,
    status: nextStatus,
    movements: posted.movements,
  };

  if (options.emit) {
    await options.emit({
      eventType: 'PurchaseOrderReceived',
      aggregateType: 'purchase_order',
      aggregateId: po.id,
      payload: result,
    });
  }

  return {
    result,
    warnings: [...posted.warnings, ...overReceiveWarnings],
  };
}

export async function cancelPurchaseOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<PurchaseOrder> {
  const [existing] = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.PURCHASE_ORDER_NOT_FOUND, `Purchase Order ${id} not found`);
  }

  if (
    existing.status !== 'DRAFT' &&
    existing.status !== 'CONFIRMED' &&
    existing.status !== 'PARTIALLY_RECEIVED'
  ) {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Purchase Order cannot be cancelled from ${existing.status} status`,
    );
  }

  const [updated] = await tx
    .update(purchaseOrders)
    .set({
      status: 'CANCELLED',
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrders.id, id))
    .returning();

  const [enriched] = await enrichPurchaseOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderCancelled',
      aggregateType: 'purchase_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

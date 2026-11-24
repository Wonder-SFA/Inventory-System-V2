import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  type CloseTransferDiscrepancyInput,
  ConflictError,
  type CreateTransferOrderInput,
  type DispatchTransferOrderInput,
  ERROR_CODES,
  type ListTransferOrdersQuery,
  NotFoundError,
  type Quantity,
  type ReceiveTransferOrderInput,
  type ReceiveTransferOrderResult,
  type TransferOrder,
  type TransferOrderLine,
  type TransferOrderLineLot,
  type UUID,
  type UpdateTransferOrderInput,
  ValidationError,
  ZERO_DECIMAL4,
  add,
  gt,
  gte,
  isPositive,
  isZero,
  lt,
  sub,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, asc, eq, inArray, or } from 'drizzle-orm';
import {
  type DbTransaction,
  applyKeysetOrder,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { getSkusByIds } from '../../catalog/public/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import {
  type CloseTransferDiscrepancyLine,
  type DispatchTransferLine,
  type ReceiveTransferLine,
  closeTransferDiscrepancy,
  dispatchTransfer,
  getLocationById,
  getLocationsByIds,
  getStockLotsByIds,
  receiveTransfer,
} from '../../inventory/public/index.js';
import {
  type TransferOrderLineLotRow,
  type TransferOrderLineRow,
  type TransferOrderRow,
  transferOrderLineLots,
  transferOrderLines,
  transferOrders,
} from '../db/index.js';
import type { OrderEmitEventFn } from './purchaseOrders.js';

function buildLocationScopeFilter(scope: LocationScope): {
  empty: boolean;
  condition?: SQL | undefined;
} {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    const ids = [...scope.locationIds];
    return {
      empty: false,
      condition: or(
        inArray(transferOrders.sourceLocationId, ids),
        inArray(transferOrders.destinationLocationId, ids),
      ),
    };
  }
  return { empty: true };
}

function toTransferOrderLineLotDto(
  row: TransferOrderLineLotRow,
  lotCode: string | null,
): TransferOrderLineLot {
  return {
    id: row.id,
    transferOrderLineId: row.transferOrderLineId,
    lotId: row.lotId ?? null,
    lotCode,
    dispatchedQty: toQuantity(row.dispatchedQty),
    receivedQty: toQuantity(row.receivedQty),
    discrepancyQty: toQuantity(row.discrepancyQty),
    dispatchUnitCost: toUnitCost(row.dispatchUnitCost),
    dispatchWacUnitCost: toUnitCost(row.dispatchWacUnitCost),
    currency: row.currency,
    expDate: row.expDate ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTransferOrderLineDto(
  row: TransferOrderLineRow,
  skuMeta?: { code: string; name: string },
  lots?: TransferOrderLineLot[],
): TransferOrderLine {
  return {
    id: row.id,
    transferOrderId: row.transferOrderId,
    skuId: row.skuId,
    ...(skuMeta ? { skuCode: skuMeta.code, skuName: skuMeta.name } : {}),
    orderedQty: toQuantity(row.orderedQty),
    dispatchedQty: toQuantity(row.dispatchedQty),
    receivedQty: toQuantity(row.receivedQty),
    dispatchUnitCost: row.dispatchUnitCost !== null ? toUnitCost(row.dispatchUnitCost) : null,
    currency: row.currency,
    lots: lots ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function enrichTransferOrders(
  db: Database | DbTransaction,
  rows: readonly TransferOrderRow[],
): Promise<TransferOrder[]> {
  if (rows.length === 0) {
    return [];
  }

  const toIds = rows.map((r) => r.id);
  const locationIds = [
    ...new Set(rows.flatMap((r) => [r.sourceLocationId, r.destinationLocationId])),
  ];

  const [lineRows, locationDtos] = await Promise.all([
    db
      .select()
      .from(transferOrderLines)
      .where(inArray(transferOrderLines.transferOrderId, toIds))
      .orderBy(asc(transferOrderLines.createdAt), asc(transferOrderLines.id)),
    getLocationsByIds(db, { allLocations: true }, locationIds),
  ]);

  const skuIds = [...new Set(lineRows.map((l) => l.skuId))];
  const lineIds = lineRows.map((l) => l.id);

  const [skuDtos, lineLotRows] = await Promise.all([
    getSkusByIds(db, skuIds),
    lineIds.length > 0
      ? db
          .select()
          .from(transferOrderLineLots)
          .where(inArray(transferOrderLineLots.transferOrderLineId, lineIds))
          .orderBy(
            asc(transferOrderLineLots.expDate),
            asc(transferOrderLineLots.createdAt),
            asc(transferOrderLineLots.id),
          )
      : Promise.resolve([]),
  ]);

  const lotIds = lineLotRows.map((l) => l.lotId).filter((id): id is string => id !== null);
  const stockLotDtos = lotIds.length > 0 ? await getStockLotsByIds(db, lotIds) : [];
  const lotCodeMap = new Map(stockLotDtos.map((l) => [l.id, l.lotCode]));

  const lotsByLineId = new Map<string, TransferOrderLineLot[]>();
  for (const lotRow of lineLotRows) {
    const list = lotsByLineId.get(lotRow.transferOrderLineId) ?? [];
    const lotCode = lotRow.lotId ? (lotCodeMap.get(lotRow.lotId) ?? null) : null;
    list.push(toTransferOrderLineLotDto(lotRow, lotCode));
    lotsByLineId.set(lotRow.transferOrderLineId, list);
  }

  const locationMap = new Map(locationDtos.map((l) => [l.id, l.name]));
  const skuMap = new Map(skuDtos.map((s) => [s.id, { code: s.code, name: s.name }]));

  const linesByToId = new Map<string, TransferOrderLine[]>();
  for (const lineRow of lineRows) {
    const list = linesByToId.get(lineRow.transferOrderId) ?? [];
    list.push(
      toTransferOrderLineDto(lineRow, skuMap.get(lineRow.skuId), lotsByLineId.get(lineRow.id)),
    );
    linesByToId.set(lineRow.transferOrderId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    sourceLocationId: row.sourceLocationId,
    ...(locationMap.has(row.sourceLocationId)
      ? { sourceLocationName: locationMap.get(row.sourceLocationId) }
      : {}),
    destinationLocationId: row.destinationLocationId,
    ...(locationMap.has(row.destinationLocationId)
      ? { destinationLocationName: locationMap.get(row.destinationLocationId) }
      : {}),
    status: row.status,
    version: row.version,
    note: row.note ?? null,
    discrepancyReason: row.discrepancyReason ?? null,
    discrepancyNote: row.discrepancyNote ?? null,
    lines: linesByToId.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function assertDistinctLocations(sourceLocationId: string, destinationLocationId: string): void {
  if (sourceLocationId === destinationLocationId) {
    throw new ValidationError(
      ERROR_CODES.SAME_SOURCE_AND_DESTINATION_LOCATION,
      'Source and destination locations must be different',
      [
        {
          field: 'destinationLocationId',
          code: ERROR_CODES.SAME_SOURCE_AND_DESTINATION_LOCATION,
          message: 'Destination location must differ from source location',
        },
      ],
    );
  }
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

export async function listTransferOrders(
  db: Database,
  scope: LocationScope,
  query: ListTransferOrdersQuery,
): Promise<{ items: TransferOrder[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    transferOrders.createdAt,
    transferOrders.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.status) {
    conditions.push(eq(transferOrders.status, query.status));
  }
  if (query.sourceLocationId) {
    conditions.push(eq(transferOrders.sourceLocationId, query.sourceLocationId));
  }
  if (query.destinationLocationId) {
    conditions.push(eq(transferOrders.destinationLocationId, query.destinationLocationId));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(transferOrders)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  const items = await enrichTransferOrders(db, page.items);

  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getTransferOrderById(
  db: Database | DbTransaction,
  scope: LocationScope,
  id: string,
): Promise<TransferOrder> {
  const scopeFilter = buildLocationScopeFilter(scope);
  if (scopeFilter.empty) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  const conditions: SQL[] = [eq(transferOrders.id, id)];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }

  const [row] = await db
    .select()
    .from(transferOrders)
    .where(and(...conditions))
    .limit(1);

  if (!row) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  const [enriched] = await enrichTransferOrders(db, [row]);
  return enriched!;
}

export async function createTransferOrder(
  tx: DbTransaction,
  input: CreateTransferOrderInput,
  emit?: OrderEmitEventFn,
): Promise<TransferOrder> {
  assertDistinctLocations(input.sourceLocationId, input.destinationLocationId);
  await Promise.all([
    assertLocationExists(tx, input.sourceLocationId),
    assertLocationExists(tx, input.destinationLocationId),
    assertSkusExist(
      tx,
      input.lines.map((l) => l.skuId),
    ),
  ]);

  const toId = uuidv7();
  const orderNumber =
    input.orderNumber ??
    `TO-${Date.now().toString(36).toUpperCase()}-${toId.slice(-4).toUpperCase()}`;

  const [createdTo] = await tx
    .insert(transferOrders)
    .values({
      id: toId,
      orderNumber,
      sourceLocationId: input.sourceLocationId,
      destinationLocationId: input.destinationLocationId,
      status: 'DRAFT',
      version: 1,
      note: input.note ?? null,
    })
    .returning();

  await tx.insert(transferOrderLines).values(
    input.lines.map((line) => ({
      id: uuidv7(),
      transferOrderId: toId,
      skuId: line.skuId,
      orderedQty: line.orderedQty,
      dispatchedQty: ZERO_DECIMAL4,
      receivedQty: ZERO_DECIMAL4,
      dispatchUnitCost: null,
      currency: 'USD',
    })),
  );

  const [enriched] = await enrichTransferOrders(tx, [createdTo!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'TransferOrderCreated',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function updateTransferOrder(
  tx: DbTransaction,
  id: string,
  input: UpdateTransferOrderInput,
  emit?: OrderEmitEventFn,
): Promise<TransferOrder> {
  const [existing] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order cannot be edited in ${existing.status} status`,
    );
  }

  if (existing.version !== input.expectedVersion) {
    throw new ConflictError(
      ERROR_CODES.STALE_VERSION,
      `Transfer Order version mismatch: expected ${input.expectedVersion}, actual ${existing.version}`,
    );
  }

  const nextSourceId = input.sourceLocationId ?? existing.sourceLocationId;
  const nextDestId = input.destinationLocationId ?? existing.destinationLocationId;
  assertDistinctLocations(nextSourceId, nextDestId);

  if (input.sourceLocationId !== undefined) {
    await assertLocationExists(tx, input.sourceLocationId);
  }
  if (input.destinationLocationId !== undefined) {
    await assertLocationExists(tx, input.destinationLocationId);
  }
  if (input.lines !== undefined) {
    await assertSkusExist(
      tx,
      input.lines.map((l) => l.skuId),
    );
    await tx.delete(transferOrderLines).where(eq(transferOrderLines.transferOrderId, id));
    await tx.insert(transferOrderLines).values(
      input.lines.map((line) => ({
        id: uuidv7(),
        transferOrderId: id,
        skuId: line.skuId,
        orderedQty: line.orderedQty,
        dispatchedQty: ZERO_DECIMAL4,
        receivedQty: ZERO_DECIMAL4,
        dispatchUnitCost: null,
        currency: 'USD',
      })),
    );
  }

  const [updated] = await tx
    .update(transferOrders)
    .set({
      ...(input.sourceLocationId !== undefined ? { sourceLocationId: input.sourceLocationId } : {}),
      ...(input.destinationLocationId !== undefined
        ? { destinationLocationId: input.destinationLocationId }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(transferOrders.id, id))
    .returning();

  const [enriched] = await enrichTransferOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'TransferOrderUpdated',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function confirmTransferOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<TransferOrder> {
  const [existing] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order cannot be confirmed from ${existing.status} status`,
    );
  }

  const [updated] = await tx
    .update(transferOrders)
    .set({
      status: 'CONFIRMED',
      updatedAt: new Date(),
    })
    .where(eq(transferOrders.id, id))
    .returning();

  const [enriched] = await enrichTransferOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderConfirmed',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function dispatchTransferOrder(
  tx: DbTransaction,
  id: string,
  input: DispatchTransferOrderInput | undefined,
  options: {
    actorId: string;
    deriveLineIdempotencyKey: (lineId: string) => UUID;
    emit?: OrderEmitEventFn;
    resolveLotPolicy?: (locationId: string) => {
      pickingMode: 'AUTO_FEFO' | 'MANUAL_REQUIRED' | 'MANUAL_OPTIONAL';
      allowExpiredLotOverride?: boolean;
      negativeStockPolicy: 'FLEXIBLE_UNASSIGNED' | 'STRICT_BLOCK';
    };
    canManualFefoOverride?: (locationId: string) => boolean;
  },
): Promise<{ order: TransferOrder; warnings: ApiWarning[] }> {
  const [existing] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (existing.status !== 'CONFIRMED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order cannot be dispatched from ${existing.status} status`,
    );
  }

  const lineRows = await tx
    .select()
    .from(transferOrderLines)
    .where(eq(transferOrderLines.transferOrderId, existing.id))
    .orderBy(asc(transferOrderLines.createdAt), asc(transferOrderLines.id))
    .for('update');

  const inputLineById = new Map((input?.lines ?? []).map((l) => [l.orderLineId, l]));
  const lotPolicy = options.resolveLotPolicy
    ? options.resolveLotPolicy(existing.sourceLocationId)
    : undefined;
  const allowManualFefoOverride = options.canManualFefoOverride
    ? options.canManualFefoOverride(existing.sourceLocationId)
    : true;

  const dispatchLines: DispatchTransferLine[] = lineRows.map((line) => {
    const reqLine = inputLineById.get(line.id);
    return {
      skuId: line.skuId,
      sourceLocationId: existing.sourceLocationId,
      destinationLocationId: existing.destinationLocationId,
      quantity: toQuantity(line.orderedQty),
      lotAllocations: reqLine?.lotAllocations,
      pickingMode: lotPolicy?.pickingMode,
      negativeStockPolicy: lotPolicy?.negativeStockPolicy,
      allowManualFefoOverride,
      allowExpiredLotOverride: lotPolicy?.allowExpiredLotOverride ?? false,
      confirmExpiredLotOverride:
        reqLine?.confirmExpiredLotOverride ?? input?.confirmExpiredLotOverride ?? false,
      overrideReason: reqLine?.overrideReason ?? input?.overrideReason ?? null,
      referenceType: 'TRANSFER_ORDER',
      referenceId: existing.id,
      actorId: options.actorId,
      idempotencyKey: options.deriveLineIdempotencyKey(line.id),
      note: input?.note ?? null,
    };
  });

  const dispatched = await dispatchTransfer(tx, dispatchLines, { emit: options.emit });

  const now = new Date();
  const lineLotInserts: Array<typeof transferOrderLineLots.$inferInsert> = [];
  for (let i = 0; i < lineRows.length; i++) {
    const lineRow = lineRows[i]!;
    const dispLine = dispatched.dispatchedLines[i]!;
    await tx
      .update(transferOrderLines)
      .set({
        dispatchedQty: dispLine.quantity,
        dispatchUnitCost: dispLine.dispatchUnitCost,
        currency: dispLine.currency,
        updatedAt: now,
      })
      .where(eq(transferOrderLines.id, lineRow.id));

    for (const lot of dispLine.lots) {
      lineLotInserts.push({
        id: uuidv7(),
        transferOrderLineId: lineRow.id,
        lotId: lot.lotId,
        dispatchedQty: lot.quantity,
        receivedQty: ZERO_DECIMAL4,
        discrepancyQty: ZERO_DECIMAL4,
        dispatchUnitCost: lot.dispatchUnitCost,
        dispatchWacUnitCost: lot.dispatchWacUnitCost,
        currency: lot.currency,
        expDate: lot.expDate,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  if (lineLotInserts.length > 0) {
    await tx.insert(transferOrderLineLots).values(lineLotInserts);
  }

  const [updated] = await tx
    .update(transferOrders)
    .set({
      status: 'IN_TRANSIT',
      updatedAt: now,
    })
    .where(eq(transferOrders.id, existing.id))
    .returning();

  const [enriched] = await enrichTransferOrders(tx, [updated!]);
  const dto = enriched!;

  if (options.emit) {
    await options.emit({
      eventType: 'TransferOrderDispatched',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return { order: dto, warnings: dispatched.warnings };
}

function lotKey(lotId: string | null): string {
  return lotId ?? '__UNLOTTED__';
}

function compareEarliestExpiringFirst(
  a: TransferOrderLineLotRow,
  b: TransferOrderLineLotRow,
): number {
  if (a.expDate && b.expDate) {
    if (a.expDate < b.expDate) return -1;
    if (a.expDate > b.expDate) return 1;
  } else if (a.expDate && !b.expDate) {
    return -1;
  } else if (!a.expDate && b.expDate) {
    return 1;
  }
  const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareLatestExpiringFirst(
  a: TransferOrderLineLotRow,
  b: TransferOrderLineLotRow,
): number {
  if (a.expDate && b.expDate) {
    if (a.expDate > b.expDate) return -1;
    if (a.expDate < b.expDate) return 1;
  } else if (a.expDate && !b.expDate) {
    return -1;
  } else if (!a.expDate && b.expDate) {
    return 1;
  }
  const createdDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

export async function receiveTransferOrder(
  tx: DbTransaction,
  id: string,
  input: ReceiveTransferOrderInput,
  options: {
    actorId: string;
    deriveLineIdempotencyKey: (lineId: string) => UUID;
    emit?: OrderEmitEventFn;
  },
): Promise<{ result: ReceiveTransferOrderResult; warnings: ApiWarning[] }> {
  const [to] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!to) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (to.status !== 'IN_TRANSIT' && to.status !== 'PARTIALLY_RECEIVED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order cannot be received in ${to.status} status`,
    );
  }

  const lineRows = await tx
    .select()
    .from(transferOrderLines)
    .where(eq(transferOrderLines.transferOrderId, to.id))
    .for('update');

  const lineIds = lineRows.map((l) => l.id);
  const lineLotRows =
    lineIds.length > 0
      ? await tx
          .select()
          .from(transferOrderLineLots)
          .where(inArray(transferOrderLineLots.transferOrderLineId, lineIds))
          .for('update')
      : [];

  const lineLotsByLineId = new Map<string, TransferOrderLineLotRow[]>();
  for (const row of lineLotRows) {
    const list = lineLotsByLineId.get(row.transferOrderLineId) ?? [];
    list.push(row);
    lineLotsByLineId.set(row.transferOrderLineId, list);
  }

  const lineById = new Map<string, TransferOrderLineRow>(lineRows.map((l) => [l.id, l]));
  const incomingQtyByLineId = new Map<string, Quantity>();

  for (const reqLine of input.lines) {
    if (!lineById.has(reqLine.orderLineId)) {
      throw new NotFoundError(
        ERROR_CODES.TRANSFER_ORDER_LINE_NOT_FOUND,
        `Transfer Order line ${reqLine.orderLineId} not found on order ${to.id}`,
      );
    }
    const prev = incomingQtyByLineId.get(reqLine.orderLineId) ?? toQuantity(ZERO_DECIMAL4);
    incomingQtyByLineId.set(reqLine.orderLineId, add(prev, reqLine.quantity));
  }

  for (const [lineId, incomingQty] of incomingQtyByLineId.entries()) {
    const line = lineById.get(lineId)!;
    const dispatchedQty = toQuantity(line.dispatchedQty);
    const currentReceived = toQuantity(line.receivedQty);
    const nextReceived = add(currentReceived, incomingQty);

    if (gt(nextReceived, dispatchedQty)) {
      throw new ValidationError(
        ERROR_CODES.OVER_RECEIVE_TRANSFER_NOT_ALLOWED,
        `Receiving ${incomingQty} on line ${lineId} would bring received quantity to ${nextReceived}, exceeding dispatched quantity ${dispatchedQty}.`,
        [
          {
            field: 'lines',
            code: ERROR_CODES.OVER_RECEIVE_TRANSFER_NOT_ALLOWED,
            message: `Cumulative received (${nextReceived}) exceeds dispatched (${dispatchedQty})`,
          },
        ],
      );
    }
  }

  const now = new Date();
  const lineOccurrenceCount = new Map<string, number>();
  const receiveLines: ReceiveTransferLine[] = [];

  for (const reqLine of input.lines) {
    const line = lineById.get(reqLine.orderLineId)!;
    const count = (lineOccurrenceCount.get(line.id) ?? 0) + 1;
    lineOccurrenceCount.set(line.id, count);
    const keySeed = count === 1 ? line.id : `${line.id}:${count}`;
    const lineIdemKey = options.deriveLineIdempotencyKey(keySeed);
    const lotsForLine = lineLotsByLineId.get(line.id) ?? [];

    if (reqLine.lotAllocations && reqLine.lotAllocations.length > 0) {
      let allocSum = toQuantity(ZERO_DECIMAL4);
      const seenLots = new Set<string>();
      for (const alloc of reqLine.lotAllocations) {
        const lk = lotKey(alloc.lotId);
        if (seenLots.has(lk)) {
          throw new ValidationError(
            ERROR_CODES.VALIDATION_ERROR,
            `Duplicate lotId ${alloc.lotId} in lotAllocations`,
          );
        }
        seenLots.add(lk);
        allocSum = add(allocSum, alloc.quantity);
      }
      if (!isZero(sub(allocSum, reqLine.quantity))) {
        throw new ValidationError(
          ERROR_CODES.LOT_ALLOCATION_MISMATCH,
          `Lot allocations sum (${allocSum}) must equal received quantity (${reqLine.quantity})`,
        );
      }

      const groupId = reqLine.lotAllocations.length > 1 ? uuidv7() : null;
      for (let idx = 0; idx < reqLine.lotAllocations.length; idx++) {
        const alloc = reqLine.lotAllocations[idx]!;
        const lotRow = lotsForLine.find((l) => l.lotId === alloc.lotId);
        if (!lotRow) {
          throw new NotFoundError(
            ERROR_CODES.NOT_FOUND,
            `Dispatched lot ${alloc.lotId} not found on Transfer Order line ${line.id}`,
          );
        }
        const openQty = sub(
          toQuantity(lotRow.dispatchedQty),
          add(toQuantity(lotRow.receivedQty), toQuantity(lotRow.discrepancyQty)),
        );
        if (gt(alloc.quantity, openQty)) {
          throw new ValidationError(
            ERROR_CODES.OVER_RECEIVE_TRANSFER_NOT_ALLOWED,
            `Receiving ${alloc.quantity} for lot ${alloc.lotId} exceeds remaining in-transit quantity ${openQty}.`,
          );
        }
        lotRow.receivedQty = add(toQuantity(lotRow.receivedQty), alloc.quantity);
        await tx
          .update(transferOrderLineLots)
          .set({ receivedQty: lotRow.receivedQty, updatedAt: now })
          .where(eq(transferOrderLineLots.id, lotRow.id));

        receiveLines.push({
          skuId: line.skuId,
          destinationLocationId: to.destinationLocationId,
          lotId: lotRow.lotId,
          sliceIndex: idx,
          movementGroupId: groupId,
          quantity: alloc.quantity,
          dispatchUnitCost: toUnitCost(lotRow.dispatchUnitCost),
          currency: lotRow.currency,
          note: input.note ?? null,
          referenceType: 'TRANSFER_ORDER',
          referenceId: to.id,
          actorId: options.actorId,
          idempotencyKey: lineIdemKey,
        });
      }
    } else if (lotsForLine.length > 0) {
      const sortedLots = [...lotsForLine].sort(compareEarliestExpiringFirst);
      let remaining = reqLine.quantity;
      const slices: Array<{ lotRow: TransferOrderLineLotRow; quantity: Quantity }> = [];

      for (const lotRow of sortedLots) {
        if (!isPositive(remaining)) break;
        const openQty = sub(
          toQuantity(lotRow.dispatchedQty),
          add(toQuantity(lotRow.receivedQty), toQuantity(lotRow.discrepancyQty)),
        );
        if (!isPositive(openQty)) continue;
        const take = lt(remaining, openQty) ? remaining : openQty;
        lotRow.receivedQty = add(toQuantity(lotRow.receivedQty), take);
        await tx
          .update(transferOrderLineLots)
          .set({ receivedQty: lotRow.receivedQty, updatedAt: now })
          .where(eq(transferOrderLineLots.id, lotRow.id));
        slices.push({ lotRow, quantity: take });
        remaining = sub(remaining, take);
      }

      const groupId = slices.length > 1 ? uuidv7() : null;
      for (let idx = 0; idx < slices.length; idx++) {
        const s = slices[idx]!;
        receiveLines.push({
          skuId: line.skuId,
          destinationLocationId: to.destinationLocationId,
          lotId: s.lotRow.lotId,
          sliceIndex: idx,
          movementGroupId: groupId,
          quantity: s.quantity,
          dispatchUnitCost: toUnitCost(s.lotRow.dispatchUnitCost),
          currency: s.lotRow.currency,
          note: input.note ?? null,
          referenceType: 'TRANSFER_ORDER',
          referenceId: to.id,
          actorId: options.actorId,
          idempotencyKey: lineIdemKey,
        });
      }
    } else {
      receiveLines.push({
        skuId: line.skuId,
        destinationLocationId: to.destinationLocationId,
        lotId: null,
        quantity: reqLine.quantity,
        dispatchUnitCost: toUnitCost(line.dispatchUnitCost ?? ZERO_DECIMAL4),
        currency: line.currency,
        note: input.note ?? null,
        referenceType: 'TRANSFER_ORDER',
        referenceId: to.id,
        actorId: options.actorId,
        idempotencyKey: lineIdemKey,
      });
    }
  }

  const received = await receiveTransfer(tx, receiveLines, { emit: options.emit });

  const updatedReceivedByLineId = new Map<string, Quantity>();
  for (const line of lineRows) {
    const delta = incomingQtyByLineId.get(line.id);
    if (delta) {
      const nextReceived = add(toQuantity(line.receivedQty), delta);
      updatedReceivedByLineId.set(line.id, nextReceived);
      await tx
        .update(transferOrderLines)
        .set({
          receivedQty: nextReceived,
          updatedAt: now,
        })
        .where(eq(transferOrderLines.id, line.id));
    } else {
      updatedReceivedByLineId.set(line.id, toQuantity(line.receivedQty));
    }
  }

  const allLinesReceived = lineRows.every((line) => {
    const rec = updatedReceivedByLineId.get(line.id) ?? toQuantity(line.receivedQty);
    return gte(rec, toQuantity(line.dispatchedQty));
  });

  const nextStatus = allLinesReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED';

  await tx
    .update(transferOrders)
    .set({
      status: nextStatus,
      updatedAt: now,
    })
    .where(eq(transferOrders.id, to.id));

  const result: ReceiveTransferOrderResult = {
    transferOrderId: to.id,
    status: nextStatus,
    movements: received.movements,
  };

  if (options.emit) {
    await options.emit({
      eventType: 'TransferOrderReceived',
      aggregateType: 'transfer_order',
      aggregateId: to.id,
      payload: {
        ...result,
        sourceLocationId: to.sourceLocationId,
        destinationLocationId: to.destinationLocationId,
      },
    });
  }

  return {
    result,
    warnings: received.warnings,
  };
}

export async function closeTransferOrderDiscrepancy(
  tx: DbTransaction,
  id: string,
  input: CloseTransferDiscrepancyInput,
  options: {
    actorId: string;
    emit?: OrderEmitEventFn;
  },
): Promise<TransferOrder> {
  const [to] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!to) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (to.status !== 'IN_TRANSIT' && to.status !== 'PARTIALLY_RECEIVED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order discrepancy cannot be closed from ${to.status} status`,
    );
  }

  const lineRows = await tx
    .select()
    .from(transferOrderLines)
    .where(eq(transferOrderLines.transferOrderId, to.id))
    .for('update');

  const lineIds = lineRows.map((l) => l.id);
  const lineLotRows =
    lineIds.length > 0
      ? await tx
          .select()
          .from(transferOrderLineLots)
          .where(inArray(transferOrderLineLots.transferOrderLineId, lineIds))
          .for('update')
      : [];

  const lineLotsByLineId = new Map<string, TransferOrderLineLotRow[]>();
  for (const row of lineLotRows) {
    const list = lineLotsByLineId.get(row.transferOrderLineId) ?? [];
    list.push(row);
    lineLotsByLineId.set(row.transferOrderLineId, list);
  }

  const inputLineById = new Map((input.lines ?? []).map((l) => [l.orderLineId, l]));
  const now = new Date();
  const closeLines: CloseTransferDiscrepancyLine[] = [];

  for (const line of lineRows) {
    const remaining = sub(toQuantity(line.dispatchedQty), toQuantity(line.receivedQty));
    if (!isPositive(remaining)) {
      continue;
    }

    const lotsForLine = lineLotsByLineId.get(line.id) ?? [];
    const reqLine = inputLineById.get(line.id);

    if (reqLine?.lotAllocations && reqLine.lotAllocations.length > 0) {
      let allocSum = toQuantity(ZERO_DECIMAL4);
      const seenLots = new Set<string>();
      for (const alloc of reqLine.lotAllocations) {
        const lk = lotKey(alloc.lotId);
        if (seenLots.has(lk)) {
          throw new ValidationError(
            ERROR_CODES.VALIDATION_ERROR,
            `Duplicate lotId ${alloc.lotId} in discrepancy lotAllocations`,
          );
        }
        seenLots.add(lk);
        allocSum = add(allocSum, alloc.quantity);
      }
      if (!isZero(sub(allocSum, remaining))) {
        throw new ValidationError(
          ERROR_CODES.LOT_ALLOCATION_MISMATCH,
          `Discrepancy lot allocations sum (${allocSum}) must equal remaining short quantity (${remaining})`,
        );
      }

      for (const alloc of reqLine.lotAllocations) {
        const lotRow = lotsForLine.find((l) => l.lotId === alloc.lotId);
        if (!lotRow) {
          throw new NotFoundError(
            ERROR_CODES.NOT_FOUND,
            `Dispatched lot ${alloc.lotId} not found on Transfer Order line ${line.id}`,
          );
        }
        const openQty = sub(
          toQuantity(lotRow.dispatchedQty),
          add(toQuantity(lotRow.receivedQty), toQuantity(lotRow.discrepancyQty)),
        );
        if (gt(alloc.quantity, openQty)) {
          throw new ValidationError(
            ERROR_CODES.VALIDATION_ERROR,
            `Discrepancy quantity ${alloc.quantity} for lot ${alloc.lotId} exceeds remaining in-transit quantity ${openQty}`,
          );
        }
        lotRow.discrepancyQty = add(toQuantity(lotRow.discrepancyQty), alloc.quantity);
        await tx
          .update(transferOrderLineLots)
          .set({ discrepancyQty: lotRow.discrepancyQty, updatedAt: now })
          .where(eq(transferOrderLineLots.id, lotRow.id));

        closeLines.push({
          skuId: line.skuId,
          destinationLocationId: to.destinationLocationId,
          lotId: lotRow.lotId,
          quantity: alloc.quantity,
          referenceType: 'TRANSFER_ORDER',
          referenceId: to.id,
          actorId: options.actorId,
        });
      }
    } else if (lotsForLine.length > 0) {
      // Default: attribute shortages to latest-expiring in-transit Stock Lot first
      const sortedLots = [...lotsForLine].sort(compareLatestExpiringFirst);
      let toAllocate = remaining;
      for (const lotRow of sortedLots) {
        if (!isPositive(toAllocate)) break;
        const openQty = sub(
          toQuantity(lotRow.dispatchedQty),
          add(toQuantity(lotRow.receivedQty), toQuantity(lotRow.discrepancyQty)),
        );
        if (!isPositive(openQty)) continue;
        const take = lt(toAllocate, openQty) ? toAllocate : openQty;
        lotRow.discrepancyQty = add(toQuantity(lotRow.discrepancyQty), take);
        await tx
          .update(transferOrderLineLots)
          .set({ discrepancyQty: lotRow.discrepancyQty, updatedAt: now })
          .where(eq(transferOrderLineLots.id, lotRow.id));

        closeLines.push({
          skuId: line.skuId,
          destinationLocationId: to.destinationLocationId,
          lotId: lotRow.lotId,
          quantity: take,
          referenceType: 'TRANSFER_ORDER',
          referenceId: to.id,
          actorId: options.actorId,
        });
        toAllocate = sub(toAllocate, take);
      }
    } else {
      closeLines.push({
        skuId: line.skuId,
        destinationLocationId: to.destinationLocationId,
        lotId: null,
        quantity: remaining,
        referenceType: 'TRANSFER_ORDER',
        referenceId: to.id,
        actorId: options.actorId,
      });
    }
  }

  if (closeLines.length > 0) {
    await closeTransferDiscrepancy(tx, closeLines, { emit: options.emit });
  }

  const [updated] = await tx
    .update(transferOrders)
    .set({
      status: 'CLOSED_WITH_DISCREPANCY',
      discrepancyReason: input.reason,
      discrepancyNote: input.note,
      updatedAt: now,
    })
    .where(eq(transferOrders.id, to.id))
    .returning();

  const [enriched] = await enrichTransferOrders(tx, [updated!]);
  const dto = enriched!;

  if (options.emit) {
    await options.emit({
      eventType: 'TransferOrderDiscrepancyClosed',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

export async function cancelTransferOrder(
  tx: DbTransaction,
  id: string,
  emit?: OrderEmitEventFn,
): Promise<TransferOrder> {
  const [existing] = await tx
    .select()
    .from(transferOrders)
    .where(eq(transferOrders.id, id))
    .for('update')
    .limit(1);

  if (!existing) {
    throw new NotFoundError(
      ERROR_CODES.TRANSFER_ORDER_NOT_FOUND,
      `Transfer Order ${id} not found`,
    );
  }

  if (existing.status !== 'DRAFT' && existing.status !== 'CONFIRMED') {
    throw new ConflictError(
      ERROR_CODES.INVALID_ORDER_STATE,
      `Transfer Order cannot be cancelled from ${existing.status} status`,
    );
  }

  const [updated] = await tx
    .update(transferOrders)
    .set({
      status: 'CANCELLED',
      updatedAt: new Date(),
    })
    .where(eq(transferOrders.id, id))
    .returning();

  const [enriched] = await enrichTransferOrders(tx, [updated!]);
  const dto = enriched!;

  if (emit) {
    await emit({
      eventType: 'OrderCancelled',
      aggregateType: 'transfer_order',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  return dto;
}

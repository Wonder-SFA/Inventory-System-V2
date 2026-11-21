import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  BadRequestError,
  type Decimal4,
  ERROR_CODES,
  type ListStockBalancesQuery,
  type ListStockMovementsQuery,
  type Money,
  NotFoundError,
  type Quantity,
  type StockBalance,
  type StockMovement,
  type StockMovementType,
  type UUID,
  type UnitCost,
  type ValuationStatus,
  ZERO_DECIMAL4,
  add,
  calculateWeightedAverageCost,
  div,
  formatDecimal4,
  isNegative,
  isPositive,
  isZero,
  isZeroOrNegative,
  mul,
  negate,
  round4,
  sub,
  toMoney,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import {
  type DbTransaction,
  type DomainEventInput,
  applyKeysetOrder,
  outboxEvents,
  paginateKeysetResult,
} from '../../../shared/index.js';
import { findSkuByIdOrCode, getSkusByIds, registerSkuReferenceChecker } from '../../catalog/public/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import {
  type StockBalanceRow,
  type StockMovementRow,
  locations,
  stockBalances,
  stockMovements,
} from '../db/index.js';
import { registerLocationReferenceChecker } from './locations.js';

export type EmitEventFn = (event: DomainEventInput) => Promise<void>;

export interface InventoryIntentOptions {
  emit?: EmitEventFn | undefined;
}

export interface StockPair {
  skuId: UUID;
  locationId: UUID;
}

export interface ReserveStockLine {
  skuId: UUID;
  locationId: UUID;
  quantity: Quantity;
  referenceType?: string | undefined;
  referenceId?: UUID | undefined;
}

export interface PostMovementLine {
  id?: UUID | undefined;
  type: StockMovementType;
  skuId: UUID;
  locationId: UUID;
  quantityDelta: Quantity;
  unitCost?: UnitCost | null | undefined;
  currency?: string | undefined;
  reasonCategory?: string | null | undefined;
  note?: string | null | undefined;
  referenceType?: string | null | undefined;
  referenceId?: UUID | null | undefined;
  actorId: string;
  idempotencyKey: UUID;
}

export interface DispatchTransferLine {
  skuId: UUID;
  sourceLocationId: UUID;
  destinationLocationId: UUID;
  quantity: Quantity;
  referenceType?: string | undefined;
  referenceId: UUID;
  actorId: string;
  idempotencyKey: UUID;
  note?: string | null | undefined;
}

export interface DispatchedTransferLineResult {
  skuId: UUID;
  sourceLocationId: UUID;
  destinationLocationId: UUID;
  quantity: Quantity;
  dispatchUnitCost: UnitCost;
  currency: string;
}

export interface ReceiveTransferLine {
  skuId: UUID;
  destinationLocationId: UUID;
  quantity: Quantity;
  dispatchUnitCost: UnitCost;
  currency?: string | undefined;
  referenceType?: string | undefined;
  referenceId: UUID;
  actorId: string;
  idempotencyKey: UUID;
  note?: string | null | undefined;
}

export interface CloseTransferDiscrepancyLine {
  skuId: UUID;
  destinationLocationId: UUID;
  quantity: Quantity;
  referenceType?: string | undefined;
  referenceId: UUID;
  actorId: string;
}

export interface LockedBalanceState {
  skuId: UUID;
  locationId: UUID;
  onHand: Quantity;
  reserved: Quantity;
  available: Quantity;
  inTransit: Quantity;
  weightedAverageCost: UnitCost;
  currency: string;
  updatedAt: Date;
}

function pairKey(skuId: string, locationId: string): string {
  return `${skuId}:${locationId}`;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortUniquePairs(pairs: readonly StockPair[]): StockPair[] {
  const unique = new Map<string, StockPair>();
  for (const p of pairs) {
    unique.set(pairKey(p.skuId, p.locationId), p);
  }
  return [...unique.values()].sort(
    (a, b) => compareStrings(a.skuId, b.skuId) || compareStrings(a.locationId, b.locationId),
  );
}

async function emitOutboxEvent(
  tx: DbTransaction,
  emit: EmitEventFn | undefined,
  event: DomainEventInput,
): Promise<void> {
  if (emit) {
    await emit(event);
    return;
  }
  await tx.insert(outboxEvents).values({
    eventId: event.eventId ?? uuidv7(),
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
}

async function upsertAndLockBalances(
  tx: DbTransaction,
  pairs: readonly StockPair[],
): Promise<Map<string, LockedBalanceState>> {
  const sorted = sortUniquePairs(pairs);
  if (sorted.length === 0) {
    return new Map();
  }

  await tx
    .insert(stockBalances)
    .values(
      sorted.map((p) => ({
        skuId: p.skuId,
        locationId: p.locationId,
      })),
    )
    .onConflictDoNothing({
      target: [stockBalances.skuId, stockBalances.locationId],
    });

  const pairPredicates = sorted.map((p) =>
    and(eq(stockBalances.skuId, p.skuId), eq(stockBalances.locationId, p.locationId)),
  );

  const lockedRows = await tx
    .select()
    .from(stockBalances)
    .where(pairPredicates.length === 1 ? pairPredicates[0] : or(...pairPredicates))
    .orderBy(asc(stockBalances.skuId), asc(stockBalances.locationId))
    .for('update');

  const map = new Map<string, LockedBalanceState>();
  for (const row of lockedRows) {
    map.set(pairKey(row.skuId, row.locationId), {
      skuId: row.skuId,
      locationId: row.locationId,
      onHand: toQuantity(row.onHand),
      reserved: toQuantity(row.reserved),
      available: toQuantity(row.available),
      inTransit: toQuantity(row.inTransit),
      weightedAverageCost: toUnitCost(row.weightedAverageCost),
      currency: row.currency,
      updatedAt: row.updatedAt,
    });
  }
  return map;
}

async function persistLockedBalances(
  tx: DbTransaction,
  map: Map<string, LockedBalanceState>,
  dirtyKeys: ReadonlySet<string>,
): Promise<void> {
  const now = new Date();
  for (const key of dirtyKeys) {
    const state = map.get(key);
    if (!state) continue;
    state.available = sub(state.onHand, state.reserved);
    state.updatedAt = now;

    await tx
      .update(stockBalances)
      .set({
        onHand: state.onHand,
        reserved: state.reserved,
        inTransit: state.inTransit,
        weightedAverageCost: state.weightedAverageCost,
        currency: state.currency,
        updatedAt: now,
      })
      .where(
        and(eq(stockBalances.skuId, state.skuId), eq(stockBalances.locationId, state.locationId)),
      );
  }
}

function collectStockWarnings(state: LockedBalanceState): ApiWarning[] {
  const warnings: ApiWarning[] = [];
  const available = sub(state.onHand, state.reserved);
  if (isZeroOrNegative(state.onHand)) {
    warnings.push({
      code: 'NEGATIVE_ON_HAND_STOCK',
      message: `On-Hand Stock is ${state.onHand} (<= 0) for SKU ${state.skuId} at Location ${state.locationId}`,
      skuId: state.skuId,
      locationId: state.locationId,
      onHand: state.onHand,
    });
  }
  if (isZeroOrNegative(available)) {
    warnings.push({
      code: 'ZERO_OR_NEGATIVE_AVAILABLE_STOCK',
      message: `Available Stock is ${available} (<= 0) for SKU ${state.skuId} at Location ${state.locationId}`,
      skuId: state.skuId,
      locationId: state.locationId,
      available,
    });
  }
  return warnings;
}

function toStockMovementDto(
  row: StockMovementRow,
  skuInfo?: { code: string; name: string },
  locationName?: string,
): StockMovement {
  return {
    id: row.id,
    type: row.type,
    skuId: row.skuId,
    ...(skuInfo ? { skuCode: skuInfo.code, skuName: skuInfo.name } : {}),
    locationId: row.locationId,
    ...(locationName !== undefined ? { locationName } : {}),
    quantityDelta: toQuantity(row.quantityDelta),
    unitCost: row.unitCost !== null ? toUnitCost(row.unitCost) : null,
    currency: row.currency,
    reasonCategory: row.reasonCategory ?? null,
    note: row.note ?? null,
    referenceType: row.referenceType ?? null,
    referenceId: row.referenceId ?? null,
    actorId: row.actorId,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  };
}

function assertPositiveQty(qty: Quantity, label: string): void {
  if (!isPositive(qty)) {
    throw new BadRequestError(ERROR_CODES.VALIDATION_ERROR, `${label} must be greater than zero`);
  }
}

export async function reserveStock(
  tx: DbTransaction,
  lines: readonly ReserveStockLine[],
  options?: InventoryIntentOptions,
): Promise<{ balances: LockedBalanceState[]; warnings: ApiWarning[] }> {
  if (lines.length === 0) {
    return { balances: [], warnings: [] };
  }
  for (const line of lines) {
    assertPositiveQty(line.quantity, 'Reservation quantity');
  }

  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId })),
  );
  const dirtyKeys = new Set<string>();
  const warnings: ApiWarning[] = [];

  for (const line of lines) {
    const key = pairKey(line.skuId, line.locationId);
    const state = map.get(key)!;
    state.reserved = add(state.reserved, line.quantity);
    state.available = sub(state.onHand, state.reserved);
    dirtyKeys.add(key);

    warnings.push(...collectStockWarnings(state));
    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'StockReserved',
      aggregateType: 'stock_balance',
      aggregateId: `${line.skuId}:${line.locationId}`,
      payload: {
        skuId: line.skuId,
        locationId: line.locationId,
        quantity: line.quantity,
        referenceType: line.referenceType ?? null,
        referenceId: line.referenceId ?? null,
      },
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return {
    balances: [...dirtyKeys].map((k) => map.get(k)!),
    warnings,
  };
}

export async function releaseReservation(
  tx: DbTransaction,
  lines: readonly ReserveStockLine[],
  options?: InventoryIntentOptions,
): Promise<{ balances: LockedBalanceState[]; warnings: ApiWarning[] }> {
  if (lines.length === 0) {
    return { balances: [], warnings: [] };
  }
  for (const line of lines) {
    assertPositiveQty(line.quantity, 'Release quantity');
  }

  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId })),
  );
  const dirtyKeys = new Set<string>();

  for (const line of lines) {
    const key = pairKey(line.skuId, line.locationId);
    const state = map.get(key)!;
    const nextReserved = sub(state.reserved, line.quantity);
    state.reserved = isNegative(nextReserved) ? toQuantity('0') : nextReserved;
    state.available = sub(state.onHand, state.reserved);
    dirtyKeys.add(key);

    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'StockReservationReleased',
      aggregateType: 'stock_balance',
      aggregateId: `${line.skuId}:${line.locationId}`,
      payload: {
        skuId: line.skuId,
        locationId: line.locationId,
        quantity: line.quantity,
        referenceType: line.referenceType ?? null,
        referenceId: line.referenceId ?? null,
      },
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return {
    balances: [...dirtyKeys].map((k) => map.get(k)!),
    warnings: [],
  };
}

function eventTypeForMovement(type: StockMovementType): string {
  switch (type) {
    case 'RECEIPT':
      return 'StockReceived';
    case 'ISSUE':
      return 'StockIssued';
    case 'ADJUSTMENT':
      return 'StockAdjusted';
    case 'TRANSFER_OUT':
      return 'TransferDispatched';
    case 'TRANSFER_IN':
      return 'TransferReceived';
  }
}

export async function postMovements(
  tx: DbTransaction,
  lines: readonly PostMovementLine[],
  options?: InventoryIntentOptions,
): Promise<{
  movements: StockMovement[];
  balances: LockedBalanceState[];
  warnings: ApiWarning[];
}> {
  if (lines.length === 0) {
    return { movements: [], balances: [], warnings: [] };
  }
  for (const line of lines) {
    if (isZero(line.quantityDelta)) {
      throw new BadRequestError(
        ERROR_CODES.VALIDATION_ERROR,
        'Movement quantityDelta must be non-zero',
      );
    }
  }

  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId })),
  );
  const dirtyKeys = new Set<string>();
  const warnings: ApiWarning[] = [];
  const insertedMovements: StockMovement[] = [];

  for (const line of lines) {
    const key = pairKey(line.skuId, line.locationId);
    const state = map.get(key)!;
    const oldQty = state.onHand;
    const oldWac = state.weightedAverageCost;
    const newQty = add(oldQty, line.quantityDelta);

    let recordedUnitCost: UnitCost | null = line.unitCost ?? null;

    if (
      (line.type === 'RECEIPT' ||
        line.type === 'TRANSFER_IN' ||
        (line.type === 'ADJUSTMENT' && isPositive(line.quantityDelta))) &&
      line.unitCost !== undefined &&
      line.unitCost !== null
    ) {
      const wacResult = calculateWeightedAverageCost(oldQty, oldWac, line.quantityDelta, line.unitCost);
      state.weightedAverageCost = wacResult.weightedAverageCost;
      recordedUnitCost = line.unitCost;
    } else if (line.type === 'ISSUE' || line.type === 'TRANSFER_OUT') {
      recordedUnitCost = line.unitCost ?? oldWac;
    }

    state.onHand = newQty;
    state.available = sub(state.onHand, state.reserved);
    if (line.currency) {
      state.currency = line.currency;
    }
    dirtyKeys.add(key);

    const movementId = line.id ?? uuidv7();
    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: movementId,
        type: line.type,
        skuId: line.skuId,
        locationId: line.locationId,
        quantityDelta: line.quantityDelta,
        unitCost: recordedUnitCost,
        currency: line.currency ?? state.currency ?? 'USD',
        reasonCategory: line.reasonCategory ?? null,
        note: line.note ?? null,
        referenceType: line.referenceType ?? null,
        referenceId: line.referenceId ?? null,
        actorId: line.actorId,
        idempotencyKey: line.idempotencyKey,
      })
      .returning();

    const dto = toStockMovementDto(row!);
    insertedMovements.push(dto);
    warnings.push(...collectStockWarnings(state));

    await emitOutboxEvent(tx, options?.emit, {
      eventType: eventTypeForMovement(line.type),
      aggregateType: 'stock_movement',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return {
    movements: insertedMovements,
    balances: [...dirtyKeys].map((k) => map.get(k)!),
    warnings,
  };
}

export async function dispatchTransfer(
  tx: DbTransaction,
  lines: readonly DispatchTransferLine[],
  options?: InventoryIntentOptions,
): Promise<{
  movements: StockMovement[];
  dispatchedLines: DispatchedTransferLineResult[];
  warnings: ApiWarning[];
}> {
  if (lines.length === 0) {
    return { movements: [], dispatchedLines: [], warnings: [] };
  }

  const pairs: StockPair[] = [];
  for (const line of lines) {
    assertPositiveQty(line.quantity, 'Transfer dispatch quantity');
    if (line.sourceLocationId === line.destinationLocationId) {
      throw new BadRequestError(
        ERROR_CODES.VALIDATION_ERROR,
        'Source and destination locations must be different',
      );
    }
    pairs.push(
      { skuId: line.skuId, locationId: line.sourceLocationId },
      { skuId: line.skuId, locationId: line.destinationLocationId },
    );
  }

  const map = await upsertAndLockBalances(tx, pairs);
  const dirtyKeys = new Set<string>();
  const movements: StockMovement[] = [];
  const dispatchedLines: DispatchedTransferLineResult[] = [];
  const warnings: ApiWarning[] = [];

  for (const line of lines) {
    const srcKey = pairKey(line.skuId, line.sourceLocationId);
    const dstKey = pairKey(line.skuId, line.destinationLocationId);
    const srcState = map.get(srcKey)!;
    const dstState = map.get(dstKey)!;

    const dispatchUnitCost = srcState.weightedAverageCost;
    const currency = srcState.currency;

    srcState.onHand = sub(srcState.onHand, line.quantity);
    srcState.available = sub(srcState.onHand, srcState.reserved);
    dstState.inTransit = add(dstState.inTransit, line.quantity);
    dirtyKeys.add(srcKey);
    dirtyKeys.add(dstKey);

    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: uuidv7(),
        type: 'TRANSFER_OUT',
        skuId: line.skuId,
        locationId: line.sourceLocationId,
        quantityDelta: negate(line.quantity),
        unitCost: dispatchUnitCost,
        currency,
        reasonCategory: null,
        note: line.note ?? null,
        referenceType: line.referenceType ?? 'TRANSFER_ORDER',
        referenceId: line.referenceId,
        actorId: line.actorId,
        idempotencyKey: line.idempotencyKey,
      })
      .returning();

    const dto = toStockMovementDto(row!);
    movements.push(dto);
    dispatchedLines.push({
      skuId: line.skuId,
      sourceLocationId: line.sourceLocationId,
      destinationLocationId: line.destinationLocationId,
      quantity: line.quantity,
      dispatchUnitCost,
      currency,
    });
    warnings.push(...collectStockWarnings(srcState));

    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'TransferDispatched',
      aggregateType: 'stock_movement',
      aggregateId: dto.id,
      payload: {
        ...dto,
        destinationLocationId: line.destinationLocationId,
        dispatchUnitCost,
      },
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return { movements, dispatchedLines, warnings };
}

export async function receiveTransfer(
  tx: DbTransaction,
  lines: readonly ReceiveTransferLine[],
  options?: InventoryIntentOptions,
): Promise<{
  movements: StockMovement[];
  balances: LockedBalanceState[];
  warnings: ApiWarning[];
}> {
  if (lines.length === 0) {
    return { movements: [], balances: [], warnings: [] };
  }
  for (const line of lines) {
    assertPositiveQty(line.quantity, 'Transfer receipt quantity');
  }

  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.destinationLocationId })),
  );
  const dirtyKeys = new Set<string>();
  const movements: StockMovement[] = [];
  const warnings: ApiWarning[] = [];

  for (const line of lines) {
    const key = pairKey(line.skuId, line.destinationLocationId);
    const state = map.get(key)!;

    const nextInTransit = sub(state.inTransit, line.quantity);
    state.inTransit = isNegative(nextInTransit) ? toQuantity('0') : nextInTransit;

    const wacResult = calculateWeightedAverageCost(
      state.onHand,
      state.weightedAverageCost,
      line.quantity,
      line.dispatchUnitCost,
    );
    state.onHand = add(state.onHand, line.quantity);
    state.available = sub(state.onHand, state.reserved);
    state.weightedAverageCost = wacResult.weightedAverageCost;
    if (line.currency) {
      state.currency = line.currency;
    }
    dirtyKeys.add(key);

    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: uuidv7(),
        type: 'TRANSFER_IN',
        skuId: line.skuId,
        locationId: line.destinationLocationId,
        quantityDelta: line.quantity,
        unitCost: line.dispatchUnitCost,
        currency: line.currency ?? state.currency ?? 'USD',
        reasonCategory: null,
        note: line.note ?? null,
        referenceType: line.referenceType ?? 'TRANSFER_ORDER',
        referenceId: line.referenceId,
        actorId: line.actorId,
        idempotencyKey: line.idempotencyKey,
      })
      .returning();

    const dto = toStockMovementDto(row!);
    movements.push(dto);
    warnings.push(...collectStockWarnings(state));

    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'TransferReceived',
      aggregateType: 'stock_movement',
      aggregateId: dto.id,
      payload: dto,
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return {
    movements,
    balances: [...dirtyKeys].map((k) => map.get(k)!),
    warnings,
  };
}

export async function closeTransferDiscrepancy(
  tx: DbTransaction,
  lines: readonly CloseTransferDiscrepancyLine[],
  options?: InventoryIntentOptions,
): Promise<{ balances: LockedBalanceState[] }> {
  if (lines.length === 0) {
    return { balances: [] };
  }
  for (const line of lines) {
    assertPositiveQty(line.quantity, 'Discrepancy quantity');
  }

  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.destinationLocationId })),
  );
  const dirtyKeys = new Set<string>();

  for (const line of lines) {
    const key = pairKey(line.skuId, line.destinationLocationId);
    const state = map.get(key)!;
    const nextInTransit = sub(state.inTransit, line.quantity);
    state.inTransit = isNegative(nextInTransit) ? toQuantity('0') : nextInTransit;
    dirtyKeys.add(key);

    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'TransferDiscrepancyClosed',
      aggregateType: 'stock_balance',
      aggregateId: `${line.skuId}:${line.destinationLocationId}`,
      payload: {
        skuId: line.skuId,
        destinationLocationId: line.destinationLocationId,
        quantity: line.quantity,
        referenceType: line.referenceType ?? 'TRANSFER_ORDER',
        referenceId: line.referenceId,
        actorId: line.actorId,
      },
    });
  }

  await persistLockedBalances(tx, map, dirtyKeys);
  return {
    balances: [...dirtyKeys].map((k) => map.get(k)!),
  };
}

export async function recordManualAdjustment(
  tx: DbTransaction,
  input: {
    skuId: string;
    locationId: string;
    quantityDelta: Quantity;
    reasonCategory: string;
    unitCost?: UnitCost | undefined;
    currency: string;
    note?: string | null | undefined;
    actorId: string;
    idempotencyKey: UUID;
  },
  options?: InventoryIntentOptions & {
    assertCanPushNegative?: (locationId: string) => void;
  },
): Promise<{ movement: StockMovement; warnings: ApiWarning[] }> {
  const sku = await findSkuByIdOrCode(tx, { skuId: input.skuId });
  if (!sku) {
    throw new NotFoundError(ERROR_CODES.SKU_NOT_FOUND, `SKU ${input.skuId} not found`);
  }

  const [location] = await tx
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(eq(locations.id, input.locationId))
    .limit(1);

  if (!location) {
    throw new NotFoundError(
      ERROR_CODES.LOCATION_NOT_FOUND,
      `Location ${input.locationId} not found`,
    );
  }

  const result = await postMovements(
    tx,
    [
      {
        type: 'ADJUSTMENT',
        skuId: input.skuId,
        locationId: input.locationId,
        quantityDelta: input.quantityDelta,
        unitCost: input.unitCost,
        currency: input.currency,
        reasonCategory: input.reasonCategory,
        note: input.note ?? null,
        referenceType: 'MANUAL_ADJUSTMENT',
        referenceId: null,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      },
    ],
    options,
  );

  const balance = result.balances[0];
  if (
    balance &&
    options?.assertCanPushNegative &&
    (isNegative(balance.onHand) || isNegative(balance.available))
  ) {
    options.assertCanPushNegative(input.locationId);
  }

  const movement = result.movements[0]!;
  return {
    movement: {
      ...movement,
      skuCode: sku.code,
      skuName: sku.name,
      locationName: location.name,
    },
    warnings: result.warnings,
  };
}

function buildBalanceScopeFilter(scope: LocationScope): { empty: boolean; condition?: SQL } {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    return { empty: false, condition: inArray(stockBalances.locationId, [...scope.locationIds]) };
  }
  return { empty: true };
}

function buildMovementScopeFilter(scope: LocationScope): { empty: boolean; condition?: SQL } {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    return { empty: false, condition: inArray(stockMovements.locationId, [...scope.locationIds]) };
  }
  return { empty: true };
}

function computeMargins(
  sellingPrice: Money | null,
  weightedAverageCost: UnitCost,
): { grossMargin: Money | null; grossMarginPercent: string | null } {
  if (sellingPrice === null) {
    return { grossMargin: null, grossMarginPercent: null };
  }
  const margin = toMoney(sub(sellingPrice as Decimal4, weightedAverageCost as Decimal4));
  if (!isPositive(sellingPrice)) {
    return { grossMargin: margin, grossMarginPercent: null };
  }
  const pct = round4(div(mul(margin, '100.0000' as Decimal4), sellingPrice));
  return { grossMargin: margin, grossMarginPercent: pct };
}

function encodeBalanceCursor(skuId: string, locationId: string | null): string {
  return Buffer.from(JSON.stringify({ s: skuId, l: locationId }), 'utf8').toString('base64url');
}

function decodeBalanceCursor(cursor: string): { skuId: string; locationId: string | null } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: unknown;
      l?: unknown;
    };
    if (typeof parsed.s !== 'string') {
      throw new Error('Invalid cursor');
    }
    return {
      skuId: parsed.s,
      locationId: typeof parsed.l === 'string' ? parsed.l : null,
    };
  } catch {
    throw new BadRequestError(ERROR_CODES.INVALID_CURSOR, 'Invalid pagination cursor');
  }
}

export async function listStockBalances(
  db: Database,
  scope: LocationScope,
  query: ListStockBalancesQuery,
): Promise<{ items: StockBalance[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildBalanceScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.locationId) {
    conditions.push(eq(stockBalances.locationId, query.locationId));
  }
  if (query.skuId) {
    conditions.push(eq(stockBalances.skuId, query.skuId));
  }

  if (query.view === 'company-wide') {
    const rows = await db
      .select()
      .from(stockBalances)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(stockBalances.skuId), asc(stockBalances.locationId));

    const bySku = new Map<string, StockBalanceRow[]>();
    for (const row of rows) {
      const list = bySku.get(row.skuId) ?? [];
      list.push(row);
      bySku.set(row.skuId, list);
    }

    let skuIds = [...bySku.keys()].sort(compareStrings);
    if (query.cursor) {
      const decoded = decodeBalanceCursor(query.cursor);
      skuIds = skuIds.filter((id) => id > decoded.skuId);
    }

    const skus = await getSkusByIds(db, skuIds);
    const skuMap = new Map(skus.map((s) => [s.id, s]));

    const aggregated: StockBalance[] = [];
    for (const skuId of skuIds) {
      const group = bySku.get(skuId)!;
      let onHand = toQuantity('0');
      let reserved = toQuantity('0');
      let inTransit = toQuantity('0');
      let totalValue = toMoney('0');
      let latestUpdatedAt: Date | null = null;
      let fallbackWac = toUnitCost('0');

      for (const r of group) {
        const rowOnHand = toQuantity(r.onHand);
        const rowWac = toUnitCost(r.weightedAverageCost);
        onHand = add(onHand, rowOnHand);
        reserved = add(reserved, toQuantity(r.reserved));
        inTransit = add(inTransit, toQuantity(r.inTransit));
        totalValue = add(totalValue, toMoney(mul(rowOnHand, rowWac)));
        if (!latestUpdatedAt || r.updatedAt > latestUpdatedAt) {
          latestUpdatedAt = r.updatedAt;
          if (isPositive(rowWac)) {
            fallbackWac = rowWac;
          }
        }
      }

      const available = sub(onHand, reserved);
      const zeroOrNegativeFlag = isZeroOrNegative(onHand) || isZeroOrNegative(available);
      if (query.zeroOrNegativeOnly && !zeroOrNegativeFlag) {
        continue;
      }

      const valuationStatus: ValuationStatus = isZeroOrNegative(onHand)
        ? 'ESTIMATED_NEGATIVE_STOCK'
        : 'NORMAL';

      let weightedAverageCost: UnitCost;
      if (isPositive(onHand)) {
        weightedAverageCost = toUnitCost(div(totalValue, onHand));
      } else {
        weightedAverageCost = fallbackWac;
        totalValue = toMoney(mul(onHand, weightedAverageCost));
      }

      const sku = skuMap.get(skuId);
      const sellingPrice = sku?.defaultSellingPrice ?? null;
      const { grossMargin, grossMarginPercent } = computeMargins(sellingPrice, weightedAverageCost);

      aggregated.push({
        skuId,
        skuCode: sku?.code ?? skuId,
        skuName: sku?.name ?? 'Unknown SKU',
        locationId: null,
        locationName: null,
        onHand,
        reserved,
        available,
        inTransit,
        weightedAverageCost,
        totalValue,
        sellingPrice,
        grossMargin,
        grossMarginPercent,
        currency: group[0]?.currency ?? 'USD',
        valuationStatus,
        zeroOrNegativeFlag,
        updatedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null,
      });
    }

    const hasMore = aggregated.length > limit;
    const items = hasMore ? aggregated.slice(0, limit) : aggregated;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeBalanceCursor(last.skuId, null) : null;
    return { items, nextCursor, hasMore };
  }

  // Per-location view
  if (query.zeroOrNegativeOnly) {
    conditions.push(
      or(lte(stockBalances.onHand, ZERO_DECIMAL4), lte(stockBalances.available, ZERO_DECIMAL4))!,
    );
  }
  if (query.cursor) {
    const decoded = decodeBalanceCursor(query.cursor);
    if (decoded.locationId) {
      conditions.push(
        or(
          sql`${stockBalances.skuId} > ${decoded.skuId}`,
          and(
            eq(stockBalances.skuId, decoded.skuId),
            sql`${stockBalances.locationId} > ${decoded.locationId}`,
          ),
        )!,
      );
    } else {
      conditions.push(sql`${stockBalances.skuId} > ${decoded.skuId}`);
    }
  }

  const rows = await db
    .select()
    .from(stockBalances)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(stockBalances.skuId), asc(stockBalances.locationId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const skuIds = [...new Set(pageRows.map((r) => r.skuId))];
  const locIds = [...new Set(pageRows.map((r) => r.locationId))];

  const [skus, locRows] = await Promise.all([
    getSkusByIds(db, skuIds),
    locIds.length > 0
      ? db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds))
      : Promise.resolve([]),
  ]);

  const skuMap = new Map(skus.map((s) => [s.id, s]));
  const locMap = new Map(locRows.map((l) => [l.id, l.name]));

  const items: StockBalance[] = pageRows.map((row) => {
    const onHand = toQuantity(row.onHand);
    const reserved = toQuantity(row.reserved);
    const available = toQuantity(row.available);
    const inTransit = toQuantity(row.inTransit);
    const wac = toUnitCost(row.weightedAverageCost);
    const totalValue = toMoney(mul(onHand, wac));
    const valuationStatus: ValuationStatus = isZeroOrNegative(onHand)
      ? 'ESTIMATED_NEGATIVE_STOCK'
      : 'NORMAL';
    const zeroOrNegativeFlag = isZeroOrNegative(onHand) || isZeroOrNegative(available);
    const sku = skuMap.get(row.skuId);
    const sellingPrice = sku?.defaultSellingPrice ?? null;
    const { grossMargin, grossMarginPercent } = computeMargins(sellingPrice, wac);

    return {
      skuId: row.skuId,
      skuCode: sku?.code ?? row.skuId,
      skuName: sku?.name ?? 'Unknown SKU',
      locationId: row.locationId,
      locationName: locMap.get(row.locationId) ?? 'Unknown Location',
      onHand,
      reserved,
      available,
      inTransit,
      weightedAverageCost: wac,
      totalValue,
      sellingPrice,
      grossMargin,
      grossMarginPercent,
      currency: row.currency,
      valuationStatus,
      zeroOrNegativeFlag,
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeBalanceCursor(last.skuId, last.locationId) : null;
  return { items, nextCursor, hasMore };
}

export async function listStockMovements(
  db: Database,
  scope: LocationScope,
  query: ListStockMovementsQuery,
): Promise<{ items: StockMovement[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildMovementScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    stockMovements.createdAt,
    stockMovements.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.skuId) {
    conditions.push(eq(stockMovements.skuId, query.skuId));
  }
  if (query.locationId) {
    conditions.push(eq(stockMovements.locationId, query.locationId));
  }
  if (query.type) {
    conditions.push(eq(stockMovements.type, query.type));
  }
  if (query.referenceType) {
    conditions.push(eq(stockMovements.referenceType, query.referenceType));
  }
  if (query.referenceId) {
    conditions.push(eq(stockMovements.referenceId, query.referenceId));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(stockMovements)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  const skuIds = [...new Set(page.items.map((r) => r.skuId))];
  const locIds = [...new Set(page.items.map((r) => r.locationId))];

  const [skus, locRows] = await Promise.all([
    getSkusByIds(db, skuIds),
    locIds.length > 0
      ? db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds))
      : Promise.resolve([]),
  ]);

  const skuMap = new Map(skus.map((s) => [s.id, { code: s.code, name: s.name }]));
  const locMap = new Map(locRows.map((l) => [l.id, l.name]));

  return {
    items: page.items.map((r) => toStockMovementDto(r, skuMap.get(r.skuId), locMap.get(r.locationId))),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

let referenceCheckersRegistered = false;

async function hasInventorySkuReferences(
  db: Database | DbTransaction,
  skuId: string,
): Promise<boolean> {
  const [mov] = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(eq(stockMovements.skuId, skuId))
    .limit(1);
  if (mov) return true;

  const [bal] = await db
    .select({ skuId: stockBalances.skuId })
    .from(stockBalances)
    .where(eq(stockBalances.skuId, skuId))
    .limit(1);
  return Boolean(bal);
}

async function hasInventoryLocationReferences(
  db: Database | DbTransaction,
  locationId: string,
): Promise<boolean> {
  const [mov] = await db
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(eq(stockMovements.locationId, locationId))
    .limit(1);
  if (mov) return true;

  const [bal] = await db
    .select({ locationId: stockBalances.locationId })
    .from(stockBalances)
    .where(eq(stockBalances.locationId, locationId))
    .limit(1);
  return Boolean(bal);
}

export function registerInventoryReferenceCheckers(): void {
  if (referenceCheckersRegistered) {
    return;
  }
  registerSkuReferenceChecker(hasInventorySkuReferences);
  registerLocationReferenceChecker(hasInventoryLocationReferences);
  referenceCheckersRegistered = true;
}

// Keep unused gte import check clean if not needed
void formatDecimal4;
void gte;

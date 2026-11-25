import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  type AssignOpeningLotLineInput,
  BadRequestError,
  DEFAULT_EXPIRING_SOON_DAYS,
  type Decimal4,
  ERROR_CODES,
  type ExpiryStatusFilter,
  type FefoCandidateLot,
  type FefoPreviewQuery,
  ForbiddenError,
  type ListLotBalancesQuery,
  type ListStockBalancesQuery,
  type ListStockLotsQuery,
  type ListStockMovementsQuery,
  type LotAllocationInput,
  type LotBalanceItem,
  type LotInput,
  type LotNegativeStockPolicy,
  type LotPickingMode,
  type Money,
  NotFoundError,
  type PlanFefoAllocationResult,
  type Quantity,
  type RecentReceiptCostItem,
  type RecentReceiptCostsQuery,
  type RecentReceiptCostsResult,
  type StockBalance,
  type StockLotView,
  type StockMovement,
  type StockMovementType,
  type UUID,
  type UnitCost,
  type ValuationCostBasis,
  type ValuationStatus,
  type ValuationSummary,
  type ValuationSummaryQuery,
  ValidationError,
  WARNING_CODES,
  ZERO_DECIMAL4,
  abs,
  add,
  calculateBlendedLotCost,
  calculateWeightedAverageCost,
  computeExpiryStatus,
  div,
  formatDecimal4,
  getExpiryCutoffDate,
  getTodayUtcDate,
  isNegative,
  isPositive,
  isZero,
  isZeroOrNegative,
  lt,
  mul,
  negate,
  planFefoAllocation,
  round4,
  sub,
  toMoney,
  toQuantity,
  toUnitCost,
  uuidv7,
} from '@iv2/shared-domain';
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  lt as drizzleLt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  type DbTransaction,
  type DomainEventInput,
  applyKeysetOrder,
  outboxEvents,
  paginateKeysetResult,
} from '../../../shared/index.js';
import {
  findSkuByIdOrCode,
  getSkusByIds,
  registerSkuReferenceChecker,
} from '../../catalog/public/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import {
  type StockBalanceRow,
  type StockMovementRow,
  locations,
  stockBalances,
  stockLotBalances,
  stockLots,
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
  lotInput?: LotInput | undefined;
  lotId?: UUID | null | undefined;
  lotAllocations?: readonly LotAllocationInput[] | undefined;
  pickingMode?: LotPickingMode | undefined;
  negativeStockPolicy?: LotNegativeStockPolicy | undefined;
  allowManualFefoOverride?: boolean | undefined;
  allowExpiredLotOverride?: boolean | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
  today?: string | undefined;
  sliceIndex?: number | undefined;
  movementGroupId?: UUID | null | undefined;
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
  lotAllocations?: readonly LotAllocationInput[] | undefined;
  pickingMode?: LotPickingMode | undefined;
  negativeStockPolicy?: LotNegativeStockPolicy | undefined;
  allowManualFefoOverride?: boolean | undefined;
  allowExpiredLotOverride?: boolean | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
  today?: string | undefined;
  referenceType?: string | undefined;
  referenceId: UUID;
  actorId: string;
  idempotencyKey: UUID;
  note?: string | null | undefined;
}

export interface DispatchedTransferLotResult {
  lotId: UUID | null;
  lotCode: string | null;
  expDate: string | null;
  quantity: Quantity;
  dispatchUnitCost: UnitCost;
  dispatchWacUnitCost: UnitCost;
  currency: string;
}

export interface DispatchedTransferLineResult {
  skuId: UUID;
  sourceLocationId: UUID;
  destinationLocationId: UUID;
  quantity: Quantity;
  dispatchUnitCost: UnitCost;
  currency: string;
  lots: DispatchedTransferLotResult[];
}

export interface ReceiveTransferLine {
  skuId: UUID;
  destinationLocationId: UUID;
  lotId?: UUID | null | undefined;
  sliceIndex?: number | undefined;
  movementGroupId?: UUID | null | undefined;
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
  lotId?: UUID | null | undefined;
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

function validateLotAllocationsSum(
  lotAllocations: readonly { lotId: UUID; quantity: Quantity }[],
  expectedQty: Quantity,
  verb: 'issued' | 'dispatched',
): void {
  let allocatedSum = toQuantity(ZERO_DECIMAL4);
  const seenLotIds = new Set<string>();
  for (const alloc of lotAllocations) {
    if (seenLotIds.has(alloc.lotId)) {
      throw new ValidationError(
        ERROR_CODES.VALIDATION_ERROR,
        `Duplicate lotId ${alloc.lotId} in lotAllocations`,
      );
    }
    seenLotIds.add(alloc.lotId);
    allocatedSum = add(allocatedSum, alloc.quantity);
  }

  if (!isZero(sub(allocatedSum, expectedQty))) {
    throw new ValidationError(
      ERROR_CODES.LOT_ALLOCATION_MISMATCH,
      `Lot allocations sum (${allocatedSum}) must equal ${verb} quantity (${expectedQty})`,
    );
  }
}

function toStockMovementDto(
  row: StockMovementRow,
  skuInfo?: { code: string; name: string },
  locationName?: string,
  lotCode?: string | null,
): StockMovement {
  return {
    id: row.id,
    type: row.type,
    skuId: row.skuId,
    ...(skuInfo ? { skuCode: skuInfo.code, skuName: skuInfo.name } : {}),
    locationId: row.locationId,
    ...(locationName !== undefined ? { locationName } : {}),
    lotId: row.lotId ?? null,
    ...(lotCode !== undefined ? { lotCode } : {}),
    sliceIndex: row.sliceIndex,
    movementGroupId: row.movementGroupId ?? null,
    quantityDelta: toQuantity(row.quantityDelta),
    unitCost: row.unitCost !== null ? toUnitCost(row.unitCost) : null,
    wacUnitCost: row.wacUnitCost !== null ? toUnitCost(row.wacUnitCost) : null,
    currency: row.currency,
    reasonCategory: row.reasonCategory ?? null,
    note: row.note ?? null,
    referenceType: row.referenceType ?? null,
    referenceId: row.referenceId ?? null,
    actorId: row.actorId,
    idempotencyKey: row.idempotencyKey,
    eodReconciliationRequired: row.eodReconciliationRequired,
    expiredLotOverride: row.expiredLotOverride,
    overrideReason: row.overrideReason ?? null,
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

async function upsertAndUpdateStockLot(
  tx: DbTransaction,
  params: {
    skuId: string;
    locationId: string;
    lotInput: LotInput;
    quantityDelta: Quantity;
    incomingUnitCost: UnitCost | null;
    currency: string;
    blendCost: boolean;
  },
): Promise<{ lotId: string; lotCode: string }> {
  const normalizedCode = params.lotInput.lotCode.trim();
  const [existingLot] = await tx
    .select()
    .from(stockLots)
    .where(and(eq(stockLots.skuId, params.skuId), sql`LOWER(${stockLots.lotCode}) = LOWER(${normalizedCode})`))
    .for('update')
    .limit(1);

  let lotId: string;
  let lotCode: string;

  if (existingLot) {
    if (
      params.lotInput.expDate !== undefined &&
      existingLot.expDate !== params.lotInput.expDate
    ) {
      throw new ValidationError(
        ERROR_CODES.LOT_EXPIRY_MISMATCH,
        `Lot "${existingLot.lotCode}" already exists with expiry date ${existingLot.expDate ?? 'none'}, cannot receive with ${params.lotInput.expDate ?? 'none'}`,
      );
    }
    lotId = existingLot.id;
    lotCode = existingLot.lotCode;
  } else {
    lotId = uuidv7();
    lotCode = normalizedCode;
    await tx.insert(stockLots).values({
      id: lotId,
      skuId: params.skuId,
      lotCode,
      mfgDate: params.lotInput.mfgDate ?? null,
      expDate: params.lotInput.expDate ?? null,
    });
  }

  await tx
    .insert(stockLotBalances)
    .values({
      lotId,
      locationId: params.locationId,
      onHand: ZERO_DECIMAL4,
      inTransit: ZERO_DECIMAL4,
      unitCost: params.incomingUnitCost ?? ZERO_DECIMAL4,
      currency: params.currency,
    })
    .onConflictDoNothing();

  const [lotBal] = await tx
    .select()
    .from(stockLotBalances)
    .where(and(eq(stockLotBalances.lotId, lotId), eq(stockLotBalances.locationId, params.locationId)))
    .for('update')
    .limit(1);

  const currentOnHand = toQuantity(lotBal!.onHand);
  const currentUnitCost = toUnitCost(lotBal!.unitCost);
  const nextOnHand = add(currentOnHand, params.quantityDelta);
  const nextUnitCost =
    params.blendCost && params.incomingUnitCost !== null
      ? calculateBlendedLotCost(currentOnHand, currentUnitCost, params.quantityDelta, params.incomingUnitCost)
      : currentUnitCost;

  await tx
    .update(stockLotBalances)
    .set({
      onHand: nextOnHand,
      unitCost: nextUnitCost,
      currency: params.currency,
      updatedAt: new Date(),
    })
    .where(and(eq(stockLotBalances.lotId, lotId), eq(stockLotBalances.locationId, params.locationId)));

  return { lotId, lotCode };
}

interface LockedLotBalanceEntry {
  lotId: string;
  skuId: string;
  lotCode: string;
  expDate: string | null;
  createdAt: string;
  locationId: string;
  onHand: Quantity;
  inTransit: Quantity;
  unitCost: UnitCost;
  currency: string;
}

async function lockLotBalancesForPairs(
  tx: DbTransaction,
  pairs: readonly StockPair[],
): Promise<Map<string, LockedLotBalanceEntry[]>> {
  const sortedPairs = sortUniquePairs(pairs);
  if (sortedPairs.length === 0) {
    return new Map();
  }

  const skuIds = [...new Set(sortedPairs.map((p) => p.skuId))];
  const locationIds = [...new Set(sortedPairs.map((p) => p.locationId))];
  const lotRows = await tx
    .select()
    .from(stockLots)
    .where(inArray(stockLots.skuId, skuIds));

  if (lotRows.length === 0) {
    return new Map();
  }

  const lotById = new Map(lotRows.map((l) => [l.id, l]));
  const lotIds = lotRows.map((l) => l.id);

  // Deterministic lock ordering: (lot_id, location_id) ascending
  const lockedBalances = await tx
    .select()
    .from(stockLotBalances)
    .where(
      and(
        inArray(stockLotBalances.lotId, lotIds),
        inArray(stockLotBalances.locationId, locationIds),
      ),
    )
    .orderBy(asc(stockLotBalances.lotId), asc(stockLotBalances.locationId))
    .for('update');

  const allowedPairKeys = new Set(sortedPairs.map((p) => pairKey(p.skuId, p.locationId)));
  const result = new Map<string, LockedLotBalanceEntry[]>();

  for (const bal of lockedBalances) {
    const lot = lotById.get(bal.lotId);
    if (!lot) continue;
    const key = pairKey(lot.skuId, bal.locationId);
    if (!allowedPairKeys.has(key)) continue;

    const list = result.get(key) ?? [];
    list.push({
      lotId: lot.id,
      skuId: lot.skuId,
      lotCode: lot.lotCode,
      expDate: lot.expDate ?? null,
      createdAt: lot.createdAt.toISOString(),
      locationId: bal.locationId,
      onHand: toQuantity(bal.onHand),
      inTransit: toQuantity(bal.inTransit),
      unitCost: toUnitCost(bal.unitCost),
      currency: bal.currency,
    });
    result.set(key, list);
  }

  return result;
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

  // Composite idempotency replay check by idempotency_key (returning all ordered slices)
  const uniqueIdemKeys = [...new Set(lines.map((l) => l.idempotencyKey))];
  const existingRows = await tx
    .select()
    .from(stockMovements)
    .where(inArray(stockMovements.idempotencyKey, uniqueIdemKeys))
    .orderBy(asc(stockMovements.idempotencyKey), asc(stockMovements.sliceIndex));

  const existingByKey = new Map<string, StockMovementRow[]>();
  for (const row of existingRows) {
    const list = existingByKey.get(row.idempotencyKey) ?? [];
    list.push(row);
    existingByKey.set(row.idempotencyKey, list);
  }

  const existingLotIds = [
    ...new Set(existingRows.map((r) => r.lotId).filter((id): id is string => id !== null)),
  ];
  const existingLotCodeMap = new Map<string, string>();
  if (existingLotIds.length > 0) {
    const lots = await tx
      .select({ id: stockLots.id, lotCode: stockLots.lotCode })
      .from(stockLots)
      .where(inArray(stockLots.id, existingLotIds));
    for (const lot of lots) {
      existingLotCodeMap.set(lot.id, lot.lotCode);
    }
  }

  const newLines = lines.filter((l) => !existingByKey.has(l.idempotencyKey));
  if (newLines.length === 0) {
    const replayedMovements: StockMovement[] = [];
    for (const line of lines) {
      const rows = existingByKey.get(line.idempotencyKey) ?? [];
      for (const row of rows) {
        const lotCode = row.lotId ? (existingLotCodeMap.get(row.lotId) ?? null) : null;
        replayedMovements.push(toStockMovementDto(row, undefined, undefined, lotCode));
      }
    }
    const balanceMap = await upsertAndLockBalances(
      tx,
      lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId })),
    );
    return {
      movements: replayedMovements,
      balances: [...balanceMap.values()],
      warnings: [],
    };
  }

  const uniqueSkuIds = [...new Set(newLines.map((l) => l.skuId))];
  const skus = await getSkusByIds(tx, uniqueSkuIds);
  const skuMap = new Map(skus.map((s) => [s.id, s]));

  // Lock 1: stock_balances sorted by (sku_id, location_id)
  const map = await upsertAndLockBalances(
    tx,
    lines.map((l) => ({ skuId: l.skuId, locationId: l.locationId })),
  );

  // Lock 2: stock_lot_balances sorted by (lot_id, location_id) for lot-tracked outbound issues or lot-targeted adjustments
  const fefoPairs = newLines
    .filter(
      (l) =>
        (l.type === 'ISSUE' &&
          isNegative(l.quantityDelta) &&
          skuMap.get(l.skuId)?.trackLots === true) ||
        (l.type === 'ADJUSTMENT' && Boolean(l.lotId)),
    )
    .map((l) => ({ skuId: l.skuId, locationId: l.locationId }));
  const lockedLotMap = await lockLotBalancesForPairs(tx, fefoPairs);

  const dirtyKeys = new Set<string>();
  const warnings: ApiWarning[] = [];
  const insertedMovements: StockMovement[] = [];

  for (const line of lines) {
    const replayedRows = existingByKey.get(line.idempotencyKey);
    if (replayedRows) {
      for (const row of replayedRows) {
        const lotCode = row.lotId ? (existingLotCodeMap.get(row.lotId) ?? null) : null;
        insertedMovements.push(toStockMovementDto(row, undefined, undefined, lotCode));
      }
      continue;
    }

    const key = pairKey(line.skuId, line.locationId);
    const state = map.get(key)!;
    const oldQty = state.onHand;
    const oldWac = state.weightedAverageCost;
    const newQty = add(oldQty, line.quantityDelta);

    const sku = skuMap.get(line.skuId);
    if (line.type === 'RECEIPT' && sku?.trackLots) {
      if (!line.lotInput?.lotCode?.trim()) {
        throw new ValidationError(
          ERROR_CODES.LOT_CODE_REQUIRED,
          `Lot code is required when receiving lot-tracked SKU ${sku.code}`,
        );
      }
      if (sku.trackExpiry && !line.lotInput.expDate) {
        throw new ValidationError(
          ERROR_CODES.EXPIRY_DATE_REQUIRED,
          `Expiry date is required when receiving expiry-tracked SKU ${sku.code}`,
        );
      }
    }

    const effectiveCurrency = line.currency ?? state.currency ?? 'USD';

    if (line.lotAllocations && line.lotAllocations.length > 0 && !sku?.trackLots) {
      throw new ValidationError(
        ERROR_CODES.VALIDATION_ERROR,
        `Lot allocations are only valid for lot-tracked SKUs (${sku?.code ?? line.skuId})`,
      );
    }

    // Outbound ISSUE on lot-tracked SKU without explicit lotInput -> apply pickingMode / lotAllocations / FEFO
    if (
      line.type === 'ISSUE' &&
      isNegative(line.quantityDelta) &&
      sku?.trackLots &&
      !line.lotInput?.lotCode?.trim()
    ) {
      const pickingMode: LotPickingMode = line.pickingMode ?? 'AUTO_FEFO';
      const negativeStockPolicy: LotNegativeStockPolicy =
        line.negativeStockPolicy ?? 'FLEXIBLE_UNASSIGNED';
      const today = line.today ?? new Date().toISOString().slice(0, 10);

      if (line.lotAllocations && line.lotAllocations.length > 0) {
        if (pickingMode === 'AUTO_FEFO' && line.allowManualFefoOverride === false) {
          throw new ForbiddenError(
            ERROR_CODES.FORBIDDEN,
            'Manual lot selection is not permitted under AUTO_FEFO policy',
          );
        }

        validateLotAllocationsSum(line.lotAllocations, abs(line.quantityDelta), 'issued');

        const lotEntries = lockedLotMap.get(key) ?? [];
        const lotEntryById = new Map(lotEntries.map((e) => [e.lotId, e]));
        interface ResolvedSlice {
          entry: (typeof lotEntries)[number] | null;
          lotId: UUID | null;
          lotCode: string | null;
          expDate: string | null;
          quantity: Quantity;
          unitCost: UnitCost;
          isExpired: boolean;
        }
        const resolvedSlices: ResolvedSlice[] = [];

        for (const alloc of line.lotAllocations) {
          const entry = lotEntryById.get(alloc.lotId);
          if (!entry) {
            throw new NotFoundError(
              ERROR_CODES.NOT_FOUND,
              `Stock lot ${alloc.lotId} not found at location ${line.locationId}`,
            );
          }

          if (negativeStockPolicy === 'STRICT_BLOCK' && lt(entry.onHand, alloc.quantity)) {
            throw new ValidationError(
              ERROR_CODES.INSUFFICIENT_LOT_STOCK,
              `Insufficient stock in lot ${entry.lotCode} (on hand ${entry.onHand}, requested ${alloc.quantity})`,
            );
          }

          const isExpired = entry.expDate !== null && entry.expDate < today;
          if (isExpired) {
            if (!line.allowExpiredLotOverride) {
              throw new ForbiddenError(
                ERROR_CODES.FORBIDDEN,
                `Lot ${entry.lotCode} is expired (${entry.expDate}) and actor lacks expired-lot override permission`,
              );
            }
            if (line.confirmExpiredLotOverride !== true) {
              throw new ValidationError(
                ERROR_CODES.EXPIRED_LOT_CONFIRMATION_REQUIRED,
                `Lot ${entry.lotCode} is expired (${entry.expDate}). Confirm expired-lot override to proceed.`,
              );
            }
          }

          if (lt(entry.onHand, alloc.quantity)) {
            const lotDeduct = isPositive(entry.onHand) ? entry.onHand : toQuantity(ZERO_DECIMAL4);
            const shortfall = sub(alloc.quantity, lotDeduct);
            if (isPositive(lotDeduct)) {
              resolvedSlices.push({
                entry,
                lotId: entry.lotId,
                lotCode: entry.lotCode,
                expDate: entry.expDate,
                quantity: lotDeduct,
                unitCost: entry.unitCost,
                isExpired,
              });
            }
            if (isPositive(shortfall)) {
              resolvedSlices.push({
                entry: null,
                lotId: null,
                lotCode: null,
                expDate: null,
                quantity: shortfall,
                unitCost: line.unitCost ?? oldWac,
                isExpired: false,
              });
            }
          } else {
            resolvedSlices.push({
              entry,
              lotId: entry.lotId,
              lotCode: entry.lotCode,
              expDate: entry.expDate,
              quantity: alloc.quantity,
              unitCost: entry.unitCost,
              isExpired,
            });
          }
        }

        const groupId =
          resolvedSlices.length > 1 ? (line.movementGroupId ?? uuidv7()) : (line.movementGroupId ?? null);

        state.onHand = newQty;
        state.available = sub(state.onHand, state.reserved);
        if (line.currency) state.currency = line.currency;
        dirtyKeys.add(key);

        for (let idx = 0; idx < resolvedSlices.length; idx++) {
          const slice = resolvedSlices[idx]!;
          if (slice.entry) {
            slice.entry.onHand = sub(slice.entry.onHand, slice.quantity);
            await tx
              .update(stockLotBalances)
              .set({ onHand: slice.entry.onHand, updatedAt: new Date() })
              .where(
                and(
                  eq(stockLotBalances.lotId, slice.entry.lotId),
                  eq(stockLotBalances.locationId, line.locationId),
                ),
              );
          }

          const recordedUnitCost = slice.unitCost;
          const recordedWacUnitCost = oldWac;

          const [row] = await tx
            .insert(stockMovements)
            .values({
              id: idx === 0 && line.id ? line.id : uuidv7(),
              type: line.type,
              skuId: line.skuId,
              locationId: line.locationId,
              lotId: slice.lotId,
              sliceIndex: idx,
              movementGroupId: groupId,
              quantityDelta: negate(slice.quantity),
              unitCost: recordedUnitCost,
              wacUnitCost: recordedWacUnitCost,
              currency: effectiveCurrency,
              reasonCategory: line.reasonCategory ?? null,
              note: line.note ?? null,
              referenceType: line.referenceType ?? null,
              referenceId: line.referenceId ?? null,
              actorId: line.actorId,
              idempotencyKey: line.idempotencyKey,
              eodReconciliationRequired: false,
              expiredLotOverride: slice.isExpired,
              overrideReason: slice.isExpired ? (line.overrideReason ?? null) : null,
            })
            .returning();

          const dto = toStockMovementDto(row!, undefined, undefined, slice.lotCode);
          insertedMovements.push(dto);

          if (slice.isExpired && slice.lotId && slice.lotCode) {
            warnings.push({
              code: WARNING_CODES.EXPIRED_LOT_OVERRIDE_USED,
              message: `Issued expired lot ${slice.lotCode} (expired ${slice.expDate}) with authorized override.`,
              skuId: line.skuId,
              locationId: line.locationId,
              lotId: slice.lotId,
              lotCode: slice.lotCode,
            });
          }

          await emitOutboxEvent(tx, options?.emit, {
            eventType: eventTypeForMovement(line.type),
            aggregateType: 'stock_movement',
            aggregateId: dto.id,
            payload: dto,
          });
        }

        warnings.push(...collectStockWarnings(state));
        continue;
      }

      if (pickingMode === 'MANUAL_REQUIRED' && !line.lotId) {
        throw new ValidationError(
          ERROR_CODES.LOT_CODE_REQUIRED,
          `Manual lot selection is required when issuing lot-tracked SKU ${sku.code}`,
        );
      }

      if (pickingMode === 'MANUAL_OPTIONAL' && !line.lotId) {
        if (negativeStockPolicy === 'STRICT_BLOCK' && isNegative(newQty)) {
          throw new ValidationError(
            ERROR_CODES.INSUFFICIENT_LOT_STOCK,
            `Insufficient stock for SKU ${sku.code} at location ${line.locationId}`,
          );
        }

        const recordedUnitCost = line.unitCost ?? oldWac;
        const recordedWacUnitCost = oldWac;
        state.onHand = newQty;
        state.available = sub(state.onHand, state.reserved);
        if (line.currency) state.currency = line.currency;
        dirtyKeys.add(key);

        const [row] = await tx
          .insert(stockMovements)
          .values({
            id: line.id ?? uuidv7(),
            type: line.type,
            skuId: line.skuId,
            locationId: line.locationId,
            lotId: null,
            sliceIndex: line.sliceIndex ?? 0,
            movementGroupId: line.movementGroupId ?? null,
            quantityDelta: line.quantityDelta,
            unitCost: recordedUnitCost,
            wacUnitCost: recordedWacUnitCost,
            currency: effectiveCurrency,
            reasonCategory: line.reasonCategory ?? null,
            note: line.note ?? null,
            referenceType: line.referenceType ?? null,
            referenceId: line.referenceId ?? null,
            actorId: line.actorId,
            idempotencyKey: line.idempotencyKey,
            eodReconciliationRequired: true,
            expiredLotOverride: false,
            overrideReason: null,
          })
          .returning();

        const dto = toStockMovementDto(row!, undefined, undefined, null);
        insertedMovements.push(dto);
        warnings.push({
          code: WARNING_CODES.EOD_RECONCILIATION_REQUIRED,
          message: `Issued ${abs(line.quantityDelta)} of ${sku.code} without lot selection; EOD batch reconciliation required.`,
          skuId: line.skuId,
          locationId: line.locationId,
        });
        warnings.push(...collectStockWarnings(state));
        await emitOutboxEvent(tx, options?.emit, {
          eventType: eventTypeForMovement(line.type),
          aggregateType: 'stock_movement',
          aggregateId: dto.id,
          payload: dto,
        });
        continue;
      }

      if (line.lotId) {
        const lotEntries = lockedLotMap.get(key) ?? [];
        const entry = lotEntries.find((e) => e.lotId === line.lotId);
        if (!entry) {
          throw new NotFoundError(
            ERROR_CODES.NOT_FOUND,
            `Stock lot ${line.lotId} not found at location ${line.locationId}`,
          );
        }
        const requestedQty = abs(line.quantityDelta);
        if (negativeStockPolicy === 'STRICT_BLOCK' && lt(entry.onHand, requestedQty)) {
          throw new ValidationError(
            ERROR_CODES.INSUFFICIENT_LOT_STOCK,
            `Insufficient stock in lot ${entry.lotCode} (on hand ${entry.onHand}, requested ${requestedQty})`,
          );
        }
        const isExpired = entry.expDate !== null && entry.expDate < today;
        if (isExpired) {
          if (!line.allowExpiredLotOverride) {
            throw new ForbiddenError(
              ERROR_CODES.FORBIDDEN,
              `Lot ${entry.lotCode} is expired (${entry.expDate}) and actor lacks expired-lot override permission`,
            );
          }
          if (line.confirmExpiredLotOverride !== true) {
            throw new ValidationError(
              ERROR_CODES.EXPIRED_LOT_CONFIRMATION_REQUIRED,
              `Lot ${entry.lotCode} is expired (${entry.expDate}). Confirm expired-lot override to proceed.`,
            );
          }
        }

        const singleSlices: Array<{
          entry: (typeof lotEntries)[number] | null;
          lotId: UUID | null;
          lotCode: string | null;
          quantity: Quantity;
          unitCost: UnitCost;
          isExpired: boolean;
        }> = [];
        if (lt(entry.onHand, requestedQty)) {
          const lotDeduct = isPositive(entry.onHand) ? entry.onHand : toQuantity(ZERO_DECIMAL4);
          const shortfall = sub(requestedQty, lotDeduct);
          if (isPositive(lotDeduct)) {
            singleSlices.push({
              entry,
              lotId: entry.lotId,
              lotCode: entry.lotCode,
              quantity: lotDeduct,
              unitCost: entry.unitCost,
              isExpired,
            });
          }
          if (isPositive(shortfall)) {
            singleSlices.push({
              entry: null,
              lotId: null,
              lotCode: null,
              quantity: shortfall,
              unitCost: line.unitCost ?? oldWac,
              isExpired: false,
            });
          }
        } else {
          singleSlices.push({
            entry,
            lotId: entry.lotId,
            lotCode: entry.lotCode,
            quantity: requestedQty,
            unitCost: entry.unitCost,
            isExpired,
          });
        }

        const groupId =
          singleSlices.length > 1 ? (line.movementGroupId ?? uuidv7()) : (line.movementGroupId ?? null);

        state.onHand = newQty;
        state.available = sub(state.onHand, state.reserved);
        if (line.currency) state.currency = line.currency;
        dirtyKeys.add(key);

        for (let idx = 0; idx < singleSlices.length; idx++) {
          const slice = singleSlices[idx]!;
          if (slice.entry) {
            slice.entry.onHand = sub(slice.entry.onHand, slice.quantity);
            await tx
              .update(stockLotBalances)
              .set({ onHand: slice.entry.onHand, updatedAt: new Date() })
              .where(
                and(
                  eq(stockLotBalances.lotId, slice.entry.lotId),
                  eq(stockLotBalances.locationId, line.locationId),
                ),
              );
          }

          const [row] = await tx
            .insert(stockMovements)
            .values({
              id: idx === 0 && line.id ? line.id : uuidv7(),
              type: line.type,
              skuId: line.skuId,
              locationId: line.locationId,
              lotId: slice.lotId,
              sliceIndex: line.sliceIndex ?? idx,
              movementGroupId: groupId,
              quantityDelta: negate(slice.quantity),
              unitCost: slice.unitCost,
              wacUnitCost: oldWac,
              currency: effectiveCurrency,
              reasonCategory: line.reasonCategory ?? null,
              note: line.note ?? null,
              referenceType: line.referenceType ?? null,
              referenceId: line.referenceId ?? null,
              actorId: line.actorId,
              idempotencyKey: line.idempotencyKey,
              eodReconciliationRequired: false,
              expiredLotOverride: slice.isExpired,
              overrideReason: slice.isExpired ? (line.overrideReason ?? null) : null,
            })
            .returning();

          const dto = toStockMovementDto(row!, undefined, undefined, slice.lotCode);
          insertedMovements.push(dto);
          if (slice.isExpired && slice.lotId && slice.lotCode) {
            warnings.push({
              code: WARNING_CODES.EXPIRED_LOT_OVERRIDE_USED,
              message: `Issued expired lot ${slice.lotCode} (expired ${entry.expDate}) with authorized override.`,
              skuId: line.skuId,
              locationId: line.locationId,
              lotId: slice.lotId,
              lotCode: slice.lotCode,
            });
          }
          await emitOutboxEvent(tx, options?.emit, {
            eventType: eventTypeForMovement(line.type),
            aggregateType: 'stock_movement',
            aggregateId: dto.id,
            payload: dto,
          });
        }

        warnings.push(...collectStockWarnings(state));
        continue;
      }

      // AUTO_FEFO allocation
      const lotEntries = lockedLotMap.get(key) ?? [];
      let totalSlottedOnHand = toQuantity(ZERO_DECIMAL4);
      for (const entry of lotEntries) {
        totalSlottedOnHand = add(totalSlottedOnHand, entry.onHand);
      }
      const unlottedOnHand = sub(oldQty, totalSlottedOnHand);
      const positiveUnlottedQty = isPositive(unlottedOnHand)
        ? unlottedOnHand
        : toQuantity(ZERO_DECIMAL4);

      const candidates: FefoCandidateLot[] = lotEntries.map((e) => ({
        lotId: e.lotId,
        lotCode: e.lotCode,
        expDate: e.expDate,
        createdAt: e.createdAt,
        onHand: e.onHand,
        unitCost: e.unitCost,
      }));

      const plan = planFefoAllocation({
        requestedQty: abs(line.quantityDelta),
        positiveUnlottedQty,
        lots: candidates,
        today,
        negativeStockPolicy,
      });

      const groupId = line.movementGroupId ?? uuidv7();
      const lotEntryById = new Map(lotEntries.map((e) => [e.lotId, e]));

      state.onHand = newQty;
      state.available = sub(state.onHand, state.reserved);
      if (line.currency) state.currency = line.currency;
      dirtyKeys.add(key);

      for (let idx = 0; idx < plan.slices.length; idx++) {
        const slice = plan.slices[idx]!;
        if (slice.lotId !== null) {
          const entry = lotEntryById.get(slice.lotId)!;
          entry.onHand = sub(entry.onHand, slice.quantity);
          await tx
            .update(stockLotBalances)
            .set({ onHand: entry.onHand, updatedAt: new Date() })
            .where(
              and(
                eq(stockLotBalances.lotId, entry.lotId),
                eq(stockLotBalances.locationId, line.locationId),
              ),
            );
        }

        const recordedUnitCost = slice.unitCost ?? line.unitCost ?? oldWac;
        const recordedWacUnitCost = oldWac;

        const [row] = await tx
          .insert(stockMovements)
          .values({
            id: idx === 0 && line.id ? line.id : uuidv7(),
            type: line.type,
            skuId: line.skuId,
            locationId: line.locationId,
            lotId: slice.lotId,
            sliceIndex: idx,
            movementGroupId: groupId,
            quantityDelta: negate(slice.quantity),
            unitCost: recordedUnitCost,
            wacUnitCost: recordedWacUnitCost,
            currency: effectiveCurrency,
            reasonCategory: line.reasonCategory ?? null,
            note: line.note ?? null,
            referenceType: line.referenceType ?? null,
            referenceId: line.referenceId ?? null,
            actorId: line.actorId,
            idempotencyKey: line.idempotencyKey,
          })
          .returning();

        const dto = toStockMovementDto(row!, undefined, undefined, slice.lotCode);
        insertedMovements.push(dto);

        await emitOutboxEvent(tx, options?.emit, {
          eventType: eventTypeForMovement(line.type),
          aggregateType: 'stock_movement',
          aggregateId: dto.id,
          payload: dto,
        });
      }

      warnings.push(...collectStockWarnings(state));
      continue;
    }

    let recordedUnitCost: UnitCost | null = line.unitCost ?? null;
    const isPositiveInbound =
      line.type === 'RECEIPT' ||
      line.type === 'TRANSFER_IN' ||
      (line.type === 'ADJUSTMENT' && isPositive(line.quantityDelta));

    if (isPositiveInbound && line.unitCost !== undefined && line.unitCost !== null) {
      const wacResult = calculateWeightedAverageCost(oldQty, oldWac, line.quantityDelta, line.unitCost);
      state.weightedAverageCost = wacResult.weightedAverageCost;
      recordedUnitCost = line.unitCost;
    } else if (line.type === 'ISSUE' || line.type === 'TRANSFER_OUT') {
      recordedUnitCost = line.unitCost ?? oldWac;
    }

    const recordedWacUnitCost: UnitCost = state.weightedAverageCost;

    let lotId: string | null = null;
    let lotCode: string | undefined;
    if (line.lotInput?.lotCode?.trim()) {
      const lotResult = await upsertAndUpdateStockLot(tx, {
        skuId: line.skuId,
        locationId: line.locationId,
        lotInput: line.lotInput,
        quantityDelta: line.quantityDelta,
        incomingUnitCost: recordedUnitCost,
        currency: effectiveCurrency,
        blendCost: isPositiveInbound,
      });
      lotId = lotResult.lotId;
      lotCode = lotResult.lotCode;
    } else if (line.type === 'ADJUSTMENT' && line.lotId) {
      const lotEntries = lockedLotMap.get(key) ?? [];
      const entry = lotEntries.find((e) => e.lotId === line.lotId);
      if (!entry) {
        throw new NotFoundError(
          ERROR_CODES.NOT_FOUND,
          `Stock lot ${line.lotId} not found at location ${line.locationId}`,
        );
      }
      entry.onHand = add(entry.onHand, line.quantityDelta);
      await tx
        .update(stockLotBalances)
        .set({ onHand: entry.onHand, updatedAt: new Date() })
        .where(
          and(
            eq(stockLotBalances.lotId, entry.lotId),
            eq(stockLotBalances.locationId, line.locationId),
          ),
        );
      lotId = entry.lotId;
      lotCode = entry.lotCode;
      if (recordedUnitCost === null) {
        recordedUnitCost = entry.unitCost;
      }
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
        lotId,
        sliceIndex: line.sliceIndex ?? 0,
        movementGroupId: line.movementGroupId ?? null,
        quantityDelta: line.quantityDelta,
        unitCost: recordedUnitCost,
        wacUnitCost: recordedWacUnitCost,
        currency: effectiveCurrency,
        reasonCategory: line.reasonCategory ?? null,
        note: line.note ?? null,
        referenceType: line.referenceType ?? null,
        referenceId: line.referenceId ?? null,
        actorId: line.actorId,
        idempotencyKey: line.idempotencyKey,
      })
      .returning();

    const dto = toStockMovementDto(row!, undefined, undefined, lotCode);
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

  const uniqueSkuIds = [...new Set(lines.map((l) => l.skuId))];
  const skus = await getSkusByIds(tx, uniqueSkuIds);
  const skuMap = new Map(skus.map((s) => [s.id, s]));

  const map = await upsertAndLockBalances(tx, pairs);
  const lotPairs = lines
    .filter((l) => skuMap.get(l.skuId)?.trackLots === true)
    .flatMap((l) => [
      { skuId: l.skuId, locationId: l.sourceLocationId },
      { skuId: l.skuId, locationId: l.destinationLocationId },
    ]);
  const lockedLotMap = await lockLotBalancesForPairs(tx, lotPairs);

  const dirtyKeys = new Set<string>();
  const movements: StockMovement[] = [];
  const dispatchedLines: DispatchedTransferLineResult[] = [];
  const warnings: ApiWarning[] = [];

  for (const line of lines) {
    const srcKey = pairKey(line.skuId, line.sourceLocationId);
    const dstKey = pairKey(line.skuId, line.destinationLocationId);
    const srcState = map.get(srcKey)!;
    const dstState = map.get(dstKey)!;
    const sku = skuMap.get(line.skuId);

    const srcWac = srcState.weightedAverageCost;
    const currency = srcState.currency;

    if (line.lotAllocations && line.lotAllocations.length > 0 && !sku?.trackLots) {
      throw new ValidationError(
        ERROR_CODES.VALIDATION_ERROR,
        `Lot allocations are only valid for lot-tracked SKUs (${sku?.code ?? line.skuId})`,
      );
    }

    if (!sku?.trackLots) {
      const dispatchUnitCost = srcWac;
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
          lotId: null,
          sliceIndex: 0,
          movementGroupId: null,
          quantityDelta: negate(line.quantity),
          unitCost: dispatchUnitCost,
          wacUnitCost: dispatchUnitCost,
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
        lots: [
          {
            lotId: null,
            lotCode: null,
            expDate: null,
            quantity: line.quantity,
            dispatchUnitCost,
            dispatchWacUnitCost: dispatchUnitCost,
            currency,
          },
        ],
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
      continue;
    }

    // Lot-tracked SKU dispatch
    const pickingMode: LotPickingMode = line.pickingMode ?? 'AUTO_FEFO';
    const negativeStockPolicy: LotNegativeStockPolicy =
      line.negativeStockPolicy ?? 'FLEXIBLE_UNASSIGNED';
    const today = line.today ?? new Date().toISOString().slice(0, 10);
    const srcLotEntries = lockedLotMap.get(srcKey) ?? [];
    const srcLotById = new Map(srcLotEntries.map((e) => [e.lotId, e]));
    const dstLotEntries = lockedLotMap.get(dstKey) ?? [];
    const dstLotById = new Map(dstLotEntries.map((e) => [e.lotId, e]));

    interface DispatchSlice {
      lotId: UUID | null;
      lotCode: string | null;
      expDate: string | null;
      quantity: Quantity;
      dispatchUnitCost: UnitCost;
      isExpired: boolean;
      eodReconciliationRequired: boolean;
    }

    const slicesToDispatch: DispatchSlice[] = [];

    if (line.lotAllocations && line.lotAllocations.length > 0) {
      if (pickingMode === 'AUTO_FEFO' && line.allowManualFefoOverride === false) {
        throw new ForbiddenError(
          ERROR_CODES.FORBIDDEN,
          'Manual lot selection is not permitted under AUTO_FEFO policy',
        );
      }

      validateLotAllocationsSum(line.lotAllocations, line.quantity, 'dispatched');

      for (const alloc of line.lotAllocations) {
        const entry = srcLotById.get(alloc.lotId);
        if (!entry) {
          throw new NotFoundError(
            ERROR_CODES.NOT_FOUND,
            `Stock lot ${alloc.lotId} not found at location ${line.sourceLocationId}`,
          );
        }
        if (negativeStockPolicy === 'STRICT_BLOCK' && lt(entry.onHand, alloc.quantity)) {
          throw new ValidationError(
            ERROR_CODES.INSUFFICIENT_LOT_STOCK,
            `Insufficient stock in lot ${entry.lotCode} (on hand ${entry.onHand}, requested ${alloc.quantity})`,
          );
        }
        const isExpired = entry.expDate !== null && entry.expDate < today;
        if (isExpired) {
          if (!line.allowExpiredLotOverride) {
            throw new ForbiddenError(
              ERROR_CODES.FORBIDDEN,
              `Lot ${entry.lotCode} is expired (${entry.expDate}) and actor lacks expired-lot override permission`,
            );
          }
          if (line.confirmExpiredLotOverride !== true) {
            throw new ValidationError(
              ERROR_CODES.EXPIRED_LOT_CONFIRMATION_REQUIRED,
              `Lot ${entry.lotCode} is expired (${entry.expDate}). Confirm expired-lot override to proceed.`,
            );
          }
        }
        if (lt(entry.onHand, alloc.quantity)) {
          const lotDeduct = isPositive(entry.onHand) ? entry.onHand : toQuantity(ZERO_DECIMAL4);
          const shortfall = sub(alloc.quantity, lotDeduct);
          if (isPositive(lotDeduct)) {
            slicesToDispatch.push({
              lotId: entry.lotId,
              lotCode: entry.lotCode,
              expDate: entry.expDate,
              quantity: lotDeduct,
              dispatchUnitCost: entry.unitCost,
              isExpired,
              eodReconciliationRequired: false,
            });
          }
          if (isPositive(shortfall)) {
            slicesToDispatch.push({
              lotId: null,
              lotCode: null,
              expDate: null,
              quantity: shortfall,
              dispatchUnitCost: srcWac,
              isExpired: false,
              eodReconciliationRequired: false,
            });
          }
        } else {
          slicesToDispatch.push({
            lotId: entry.lotId,
            lotCode: entry.lotCode,
            expDate: entry.expDate,
            quantity: alloc.quantity,
            dispatchUnitCost: entry.unitCost,
            isExpired,
            eodReconciliationRequired: false,
          });
        }
      }
    } else if (pickingMode === 'MANUAL_REQUIRED') {
      throw new ValidationError(
        ERROR_CODES.LOT_CODE_REQUIRED,
        `Manual lot selection is required when dispatching lot-tracked SKU ${sku.code}`,
      );
    } else if (pickingMode === 'MANUAL_OPTIONAL') {
      if (negativeStockPolicy === 'STRICT_BLOCK' && lt(srcState.onHand, line.quantity)) {
        throw new ValidationError(
          ERROR_CODES.INSUFFICIENT_LOT_STOCK,
          `Insufficient stock for SKU ${sku.code} at location ${line.sourceLocationId}`,
        );
      }
      slicesToDispatch.push({
        lotId: null,
        lotCode: null,
        expDate: null,
        quantity: line.quantity,
        dispatchUnitCost: srcWac,
        isExpired: false,
        eodReconciliationRequired: true,
      });
    } else {
      // AUTO_FEFO
      let totalSlottedOnHand = toQuantity(ZERO_DECIMAL4);
      for (const entry of srcLotEntries) {
        totalSlottedOnHand = add(totalSlottedOnHand, entry.onHand);
      }
      const unlottedOnHand = sub(srcState.onHand, totalSlottedOnHand);
      const positiveUnlottedQty = isPositive(unlottedOnHand)
        ? unlottedOnHand
        : toQuantity(ZERO_DECIMAL4);

      const candidates: FefoCandidateLot[] = srcLotEntries.map((e) => ({
        lotId: e.lotId,
        lotCode: e.lotCode,
        expDate: e.expDate,
        createdAt: e.createdAt,
        onHand: e.onHand,
        unitCost: e.unitCost,
      }));

      const plan = planFefoAllocation({
        requestedQty: line.quantity,
        positiveUnlottedQty,
        lots: candidates,
        today,
        negativeStockPolicy,
      });

      for (const slice of plan.slices) {
        const entry = slice.lotId ? srcLotById.get(slice.lotId) : undefined;
        slicesToDispatch.push({
          lotId: slice.lotId,
          lotCode: slice.lotCode,
          expDate: entry?.expDate ?? null,
          quantity: slice.quantity,
          dispatchUnitCost: slice.unitCost ?? srcWac,
          isExpired: false,
          eodReconciliationRequired: false,
        });
      }
    }

    srcState.onHand = sub(srcState.onHand, line.quantity);
    srcState.available = sub(srcState.onHand, srcState.reserved);
    dstState.inTransit = add(dstState.inTransit, line.quantity);
    dirtyKeys.add(srcKey);
    dirtyKeys.add(dstKey);

    const groupId = slicesToDispatch.length > 1 ? uuidv7() : null;
    const lotResults: DispatchedTransferLotResult[] = [];
    let totalCost: Decimal4 = ZERO_DECIMAL4;

    for (let idx = 0; idx < slicesToDispatch.length; idx++) {
      const slice = slicesToDispatch[idx]!;
      if (slice.lotId !== null) {
        const srcEntry = srcLotById.get(slice.lotId)!;
        srcEntry.onHand = sub(srcEntry.onHand, slice.quantity);
        await tx
          .update(stockLotBalances)
          .set({ onHand: srcEntry.onHand, updatedAt: new Date() })
          .where(
            and(
              eq(stockLotBalances.lotId, srcEntry.lotId),
              eq(stockLotBalances.locationId, line.sourceLocationId),
            ),
          );

        const dstEntry = dstLotById.get(slice.lotId);
        if (dstEntry) {
          dstEntry.inTransit = add(dstEntry.inTransit, slice.quantity);
          await tx
            .update(stockLotBalances)
            .set({ inTransit: dstEntry.inTransit, updatedAt: new Date() })
            .where(
              and(
                eq(stockLotBalances.lotId, slice.lotId),
                eq(stockLotBalances.locationId, line.destinationLocationId),
              ),
            );
        } else {
          const newDstEntry: LockedLotBalanceEntry = {
            lotId: slice.lotId,
            skuId: line.skuId,
            lotCode: slice.lotCode!,
            expDate: slice.expDate,
            createdAt: new Date().toISOString(),
            locationId: line.destinationLocationId,
            onHand: toQuantity(ZERO_DECIMAL4),
            inTransit: slice.quantity,
            unitCost: slice.dispatchUnitCost,
            currency,
          };
          dstLotById.set(slice.lotId, newDstEntry);
          dstLotEntries.push(newDstEntry);
          lockedLotMap.set(dstKey, dstLotEntries);

          await tx
            .insert(stockLotBalances)
            .values({
              lotId: slice.lotId,
              locationId: line.destinationLocationId,
              onHand: ZERO_DECIMAL4,
              inTransit: slice.quantity,
              unitCost: slice.dispatchUnitCost,
              currency,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [stockLotBalances.lotId, stockLotBalances.locationId],
              set: {
                inTransit: sql`${stockLotBalances.inTransit} + ${slice.quantity}::numeric`,
                updatedAt: new Date(),
              },
            });
        }
      }

      totalCost = add(totalCost, mul(slice.quantity, slice.dispatchUnitCost));

      const [row] = await tx
        .insert(stockMovements)
        .values({
          id: uuidv7(),
          type: 'TRANSFER_OUT',
          skuId: line.skuId,
          locationId: line.sourceLocationId,
          lotId: slice.lotId,
          sliceIndex: idx,
          movementGroupId: groupId,
          quantityDelta: negate(slice.quantity),
          unitCost: slice.dispatchUnitCost,
          wacUnitCost: srcWac,
          currency,
          reasonCategory: null,
          note: line.note ?? null,
          referenceType: line.referenceType ?? 'TRANSFER_ORDER',
          referenceId: line.referenceId,
          actorId: line.actorId,
          idempotencyKey: line.idempotencyKey,
          eodReconciliationRequired: slice.eodReconciliationRequired,
          expiredLotOverride: slice.isExpired,
          overrideReason: slice.isExpired ? (line.overrideReason ?? null) : null,
        })
        .returning();

      const dto = toStockMovementDto(row!, undefined, undefined, slice.lotCode);
      movements.push(dto);
      lotResults.push({
        lotId: slice.lotId,
        lotCode: slice.lotCode,
        expDate: slice.expDate,
        quantity: slice.quantity,
        dispatchUnitCost: slice.dispatchUnitCost,
        dispatchWacUnitCost: srcWac,
        currency,
      });

      if (slice.eodReconciliationRequired) {
        warnings.push({
          code: WARNING_CODES.EOD_RECONCILIATION_REQUIRED,
          message: `Dispatched ${slice.quantity} of ${sku.code} without lot selection; EOD batch reconciliation required.`,
          skuId: line.skuId,
          locationId: line.sourceLocationId,
        });
      }
      if (slice.isExpired && slice.lotId && slice.lotCode) {
        warnings.push({
          code: WARNING_CODES.EXPIRED_LOT_OVERRIDE_USED,
          message: `Dispatched expired lot ${slice.lotCode} (expired ${slice.expDate}) with authorized override.`,
          skuId: line.skuId,
          locationId: line.sourceLocationId,
          lotId: slice.lotId,
          lotCode: slice.lotCode,
        });
      }

      await emitOutboxEvent(tx, options?.emit, {
        eventType: 'TransferDispatched',
        aggregateType: 'stock_movement',
        aggregateId: dto.id,
        payload: {
          ...dto,
          destinationLocationId: line.destinationLocationId,
          dispatchUnitCost: slice.dispatchUnitCost,
        },
      });
    }

    const lineDispatchUnitCost =
      lotResults.length === 1
        ? lotResults[0]!.dispatchUnitCost
        : toUnitCost(div(totalCost, line.quantity));

    dispatchedLines.push({
      skuId: line.skuId,
      sourceLocationId: line.sourceLocationId,
      destinationLocationId: line.destinationLocationId,
      quantity: line.quantity,
      dispatchUnitCost: lineDispatchUnitCost,
      currency,
      lots: lotResults,
    });
    warnings.push(...collectStockWarnings(srcState));
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
  const lotPairs = lines
    .filter((l) => l.lotId != null)
    .map((l) => ({ skuId: l.skuId, locationId: l.destinationLocationId }));
  const lockedLotMap = await lockLotBalancesForPairs(tx, lotPairs);

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

    let lotCode: string | null = null;
    if (line.lotId != null) {
      const lotEntries = lockedLotMap.get(key) ?? [];
      const lotEntry = lotEntries.find((e) => e.lotId === line.lotId);
      if (lotEntry) {
        lotCode = lotEntry.lotCode;
        const nextLotInTransit = sub(lotEntry.inTransit, line.quantity);
        lotEntry.inTransit = isNegative(nextLotInTransit) ? toQuantity('0') : nextLotInTransit;
        lotEntry.unitCost = calculateBlendedLotCost(
          lotEntry.onHand,
          lotEntry.unitCost,
          line.quantity,
          line.dispatchUnitCost,
        );
        lotEntry.onHand = add(lotEntry.onHand, line.quantity);
        await tx
          .update(stockLotBalances)
          .set({
            onHand: lotEntry.onHand,
            inTransit: lotEntry.inTransit,
            unitCost: lotEntry.unitCost,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stockLotBalances.lotId, lotEntry.lotId),
              eq(stockLotBalances.locationId, line.destinationLocationId),
            ),
          );
      } else {
        const [lotRow] = await tx
          .select()
          .from(stockLots)
          .where(eq(stockLots.id, line.lotId))
          .limit(1);
        lotCode = lotRow?.lotCode ?? null;
        await tx
          .insert(stockLotBalances)
          .values({
            lotId: line.lotId,
            locationId: line.destinationLocationId,
            onHand: line.quantity,
            inTransit: ZERO_DECIMAL4,
            unitCost: line.dispatchUnitCost,
            currency: line.currency ?? state.currency ?? 'USD',
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [stockLotBalances.lotId, stockLotBalances.locationId],
            set: {
              onHand: sql`${stockLotBalances.onHand} + ${line.quantity}::numeric`,
              updatedAt: new Date(),
            },
          });
      }
    }

    const [row] = await tx
      .insert(stockMovements)
      .values({
        id: uuidv7(),
        type: 'TRANSFER_IN',
        skuId: line.skuId,
        locationId: line.destinationLocationId,
        lotId: line.lotId ?? null,
        sliceIndex: line.sliceIndex ?? 0,
        movementGroupId: line.movementGroupId ?? null,
        quantityDelta: line.quantity,
        unitCost: line.dispatchUnitCost,
        wacUnitCost: state.weightedAverageCost,
        currency: line.currency ?? state.currency ?? 'USD',
        reasonCategory: null,
        note: line.note ?? null,
        referenceType: line.referenceType ?? 'TRANSFER_ORDER',
        referenceId: line.referenceId,
        actorId: line.actorId,
        idempotencyKey: line.idempotencyKey,
      })
      .returning();

    const dto = toStockMovementDto(row!, undefined, undefined, lotCode);
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
  const lotPairs = lines
    .filter((l) => l.lotId != null)
    .map((l) => ({ skuId: l.skuId, locationId: l.destinationLocationId }));
  const lockedLotMap = await lockLotBalancesForPairs(tx, lotPairs);
  const dirtyKeys = new Set<string>();

  for (const line of lines) {
    const key = pairKey(line.skuId, line.destinationLocationId);
    const state = map.get(key)!;
    const nextInTransit = sub(state.inTransit, line.quantity);
    state.inTransit = isNegative(nextInTransit) ? toQuantity('0') : nextInTransit;
    dirtyKeys.add(key);

    if (line.lotId != null) {
      const lotEntries = lockedLotMap.get(key) ?? [];
      const lotEntry = lotEntries.find((e) => e.lotId === line.lotId);
      if (lotEntry) {
        const nextLotInTransit = sub(lotEntry.inTransit, line.quantity);
        lotEntry.inTransit = isNegative(nextLotInTransit) ? toQuantity('0') : nextLotInTransit;
        await tx
          .update(stockLotBalances)
          .set({ inTransit: lotEntry.inTransit, updatedAt: new Date() })
          .where(
            and(
              eq(stockLotBalances.lotId, lotEntry.lotId),
              eq(stockLotBalances.locationId, line.destinationLocationId),
            ),
          );
      }
    }

    await emitOutboxEvent(tx, options?.emit, {
      eventType: 'TransferDiscrepancyClosed',
      aggregateType: 'stock_balance',
      aggregateId: `${line.skuId}:${line.destinationLocationId}`,
      payload: {
        skuId: line.skuId,
        destinationLocationId: line.destinationLocationId,
        lotId: line.lotId ?? null,
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
    lotId?: string | undefined;
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
        lotId: input.lotId,
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

export async function recordManualIssue(
  tx: DbTransaction,
  input: {
    skuId: string;
    locationId: string;
    quantity: Quantity;
    currency: string;
    note?: string | null | undefined;
    lotAllocations?: readonly LotAllocationInput[] | undefined;
    confirmExpiredLotOverride?: boolean | undefined;
    overrideReason?: string | null | undefined;
    actorId: string;
    idempotencyKey: UUID;
  },
  options?: InventoryIntentOptions & {
    pickingMode?: LotPickingMode | undefined;
    negativeStockPolicy?: LotNegativeStockPolicy | undefined;
    allowManualFefoOverride?: boolean | undefined;
    allowExpiredLotOverride?: boolean | undefined;
    assertCanPushNegative?: (locationId: string) => void;
  },
): Promise<{ movements: StockMovement[]; warnings: ApiWarning[] }> {
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
        type: 'ISSUE',
        skuId: input.skuId,
        locationId: input.locationId,
        lotAllocations: input.lotAllocations,
        pickingMode: options?.pickingMode,
        negativeStockPolicy: options?.negativeStockPolicy,
        allowManualFefoOverride: options?.allowManualFefoOverride,
        allowExpiredLotOverride: options?.allowExpiredLotOverride,
        confirmExpiredLotOverride: input.confirmExpiredLotOverride,
        overrideReason: input.overrideReason ?? null,
        quantityDelta: negate(input.quantity) as Quantity,
        currency: input.currency,
        note: input.note ?? null,
        referenceType: 'MANUAL_ISSUE',
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

  return {
    movements: result.movements.map((m) => ({
      ...m,
      skuCode: sku.code,
      skuName: sku.name,
      locationName: location.name,
    })),
    warnings: result.warnings,
  };
}

function buildExpiryStatusCondition(
  expiryStatus: ExpiryStatusFilter | undefined,
  today: string,
  expiringWithinDays: number,
): SQL | undefined {
  if (!expiryStatus) {
    return undefined;
  }
  const cutoff = getExpiryCutoffDate(today, expiringWithinDays);
  if (expiryStatus === 'EXPIRED') {
    return and(isNotNull(stockLots.expDate), drizzleLt(stockLots.expDate, today));
  }
  if (expiryStatus === 'EXPIRING_SOON') {
    return and(
      isNotNull(stockLots.expDate),
      gte(stockLots.expDate, today),
      lte(stockLots.expDate, cutoff),
    );
  }
  return and(isNotNull(stockLots.expDate), gt(stockLots.expDate, cutoff));
}

function encodeLotBalanceCursor(lotId: string, locationId: string): string {
  return Buffer.from(JSON.stringify({ l: lotId, loc: locationId }), 'utf8').toString('base64url');
}

function decodeLotBalanceCursor(cursor: string): { lotId: string; locationId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      l?: unknown;
      loc?: unknown;
    };
    if (typeof parsed.l !== 'string' || typeof parsed.loc !== 'string') {
      throw new Error('Invalid cursor');
    }
    return { lotId: parsed.l, locationId: parsed.loc };
  } catch {
    throw new BadRequestError(ERROR_CODES.INVALID_CURSOR, 'Invalid pagination cursor');
  }
}

export async function listStockLots(
  db: Database,
  scope: LocationScope,
  query: ListStockLotsQuery,
): Promise<{ items: StockLotView[]; nextCursor: string | null; hasMore: boolean }> {
  const isAllLocations = 'allLocations' in scope && scope.allLocations;
  if (!isAllLocations) {
    if (!('locationIds' in scope) || scope.locationIds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    if (query.locationId && !scope.locationIds.includes(query.locationId)) {
      return { items: [], nextCursor: null, hasMore: false };
    }
  }

  const limit = query.limit ?? 50;
  const today = query.today ?? getTodayUtcDate();
  const expiringWithinDays = query.expiringWithinDays ?? DEFAULT_EXPIRING_SOON_DAYS;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    stockLots.createdAt,
    stockLots.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (query.skuId) {
    conditions.push(eq(stockLots.skuId, query.skuId));
  }
  const expiryCondition = buildExpiryStatusCondition(query.expiryStatus, today, expiringWithinDays);
  if (expiryCondition) {
    conditions.push(expiryCondition);
  }

  const balanceScopeConditions: SQL[] = [eq(stockLotBalances.lotId, stockLots.id)];
  if (query.locationId) {
    balanceScopeConditions.push(eq(stockLotBalances.locationId, query.locationId));
  } else if (!isAllLocations && 'locationIds' in scope) {
    balanceScopeConditions.push(inArray(stockLotBalances.locationId, [...scope.locationIds]));
  }

  if (query.locationId || !isAllLocations) {
    conditions.push(
      exists(
        db
          .select({ lotId: stockLotBalances.lotId })
          .from(stockLotBalances)
          .where(and(...balanceScopeConditions)),
      ),
    );
  }

  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(stockLots)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  if (page.items.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const skuIds = [...new Set(page.items.map((r) => r.skuId))];
  const lotIds = page.items.map((r) => r.id);

  const sumConditions: SQL[] = [inArray(stockLotBalances.lotId, lotIds)];
  if (query.locationId) {
    sumConditions.push(eq(stockLotBalances.locationId, query.locationId));
  } else if (!isAllLocations && 'locationIds' in scope) {
    sumConditions.push(inArray(stockLotBalances.locationId, [...scope.locationIds]));
  }

  const [skus, sumRows] = await Promise.all([
    getSkusByIds(db, skuIds),
    db
      .select({
        lotId: stockLotBalances.lotId,
        totalOnHand: sql<string>`COALESCE(SUM(${stockLotBalances.onHand}), 0)`,
        totalInTransit: sql<string>`COALESCE(SUM(${stockLotBalances.inTransit}), 0)`,
      })
      .from(stockLotBalances)
      .where(and(...sumConditions))
      .groupBy(stockLotBalances.lotId),
  ]);

  const skuMap = new Map(skus.map((s) => [s.id, s]));
  const sumMap = new Map(
    sumRows.map((s) => [
      s.lotId,
      { onHand: toQuantity(s.totalOnHand), inTransit: toQuantity(s.totalInTransit) },
    ]),
  );

  return {
    items: page.items.map((row) => {
      const sku = skuMap.get(row.skuId);
      const sums = sumMap.get(row.id);
      return {
        id: row.id,
        skuId: row.skuId,
        skuCode: sku?.code ?? row.skuId,
        skuName: sku?.name ?? 'Unknown SKU',
        lotCode: row.lotCode,
        mfgDate: row.mfgDate ?? null,
        expDate: row.expDate ?? null,
        expiryStatus: computeExpiryStatus(row.expDate, { today, expiringWithinDays }),
        totalOnHand: sums?.onHand ?? toQuantity(ZERO_DECIMAL4),
        totalInTransit: sums?.inTransit ?? toQuantity(ZERO_DECIMAL4),
        createdAt: row.createdAt.toISOString(),
      };
    }),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function listLotBalances(
  db: Database,
  scope: LocationScope,
  query: ListLotBalancesQuery,
): Promise<{ items: LotBalanceItem[]; nextCursor: string | null; hasMore: boolean }> {
  const isAllLocations = 'allLocations' in scope && scope.allLocations;
  if (!isAllLocations) {
    if (!('locationIds' in scope) || scope.locationIds.length === 0) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    if (query.locationId && !scope.locationIds.includes(query.locationId)) {
      return { items: [], nextCursor: null, hasMore: false };
    }
  }

  const limit = query.limit ?? 50;
  const today = query.today ?? getTodayUtcDate();
  const expiringWithinDays = query.expiringWithinDays ?? DEFAULT_EXPIRING_SOON_DAYS;
  const conditions: SQL[] = [];

  if (!isAllLocations && 'locationIds' in scope) {
    conditions.push(inArray(stockLotBalances.locationId, [...scope.locationIds]));
  }
  if (query.locationId) {
    conditions.push(eq(stockLotBalances.locationId, query.locationId));
  }
  if (query.skuId) {
    conditions.push(eq(stockLots.skuId, query.skuId));
  }
  const expiryCondition = buildExpiryStatusCondition(query.expiryStatus, today, expiringWithinDays);
  if (expiryCondition) {
    conditions.push(expiryCondition);
  }
  if (query.cursor) {
    const decoded = decodeLotBalanceCursor(query.cursor);
    conditions.push(
      or(
        sql`${stockLotBalances.lotId} > ${decoded.lotId}`,
        and(
          eq(stockLotBalances.lotId, decoded.lotId),
          sql`${stockLotBalances.locationId} > ${decoded.locationId}`,
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      lotId: stockLotBalances.lotId,
      skuId: stockLots.skuId,
      lotCode: stockLots.lotCode,
      mfgDate: stockLots.mfgDate,
      expDate: stockLots.expDate,
      locationId: stockLotBalances.locationId,
      locationName: locations.name,
      onHand: stockLotBalances.onHand,
      inTransit: stockLotBalances.inTransit,
      unitCost: stockLotBalances.unitCost,
      wacUnitCost: stockBalances.weightedAverageCost,
      currency: stockLotBalances.currency,
      updatedAt: stockLotBalances.updatedAt,
    })
    .from(stockLotBalances)
    .innerJoin(stockLots, eq(stockLotBalances.lotId, stockLots.id))
    .innerJoin(locations, eq(stockLotBalances.locationId, locations.id))
    .leftJoin(
      stockBalances,
      and(
        eq(stockBalances.skuId, stockLots.skuId),
        eq(stockBalances.locationId, stockLotBalances.locationId),
      ),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(stockLotBalances.lotId), asc(stockLotBalances.locationId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  if (pageRows.length === 0) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const skuIds = [...new Set(pageRows.map((r) => r.skuId))];
  const skus = await getSkusByIds(db, skuIds);
  const skuMap = new Map(skus.map((s) => [s.id, s]));

  const items: LotBalanceItem[] = pageRows.map((row) => {
    const sku = skuMap.get(row.skuId);
    const onHand = toQuantity(row.onHand);
    const unitCost = toUnitCost(row.unitCost);
    const wacUnitCost = toUnitCost(row.wacUnitCost ?? row.unitCost);
    const fifoValue = toMoney(mul(onHand, unitCost));
    const wacValue = toMoney(mul(onHand, wacUnitCost));
    return {
      lotId: row.lotId,
      skuId: row.skuId,
      skuCode: sku?.code ?? row.skuId,
      skuName: sku?.name ?? 'Unknown SKU',
      lotCode: row.lotCode,
      mfgDate: row.mfgDate ?? null,
      expDate: row.expDate ?? null,
      expiryStatus: computeExpiryStatus(row.expDate, { today, expiringWithinDays }),
      locationId: row.locationId,
      locationName: row.locationName,
      onHand,
      inTransit: toQuantity(row.inTransit),
      unitCost,
      wacUnitCost,
      totalValue: fifoValue,
      fifoValue,
      wacValue,
      currency: row.currency,
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeLotBalanceCursor(last.lotId, last.locationId) : null;
  return { items, nextCursor, hasMore };
}

export async function getValuationSummary(
  db: Database,
  scope: LocationScope,
  query: ValuationSummaryQuery,
): Promise<ValuationSummary> {
  const costBasis: ValuationCostBasis = query.costBasis ?? 'FIFO';
  const scopeFilter = buildBalanceScopeFilter(scope);
  if (scopeFilter.empty) {
    return {
      costBasis,
      currency: 'USD',
      skuCount: 0,
      locationCount: 0,
      rowCount: 0,
      totalOnHand: toQuantity(ZERO_DECIMAL4),
      totalValue: toMoney(ZERO_DECIMAL4),
      totalFifoValue: toMoney(ZERO_DECIMAL4),
      totalWacValue: toMoney(ZERO_DECIMAL4),
      estimatedNegativeCount: 0,
    };
  }

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

  const rows = await db
    .select()
    .from(stockBalances)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  if (rows.length === 0) {
    return {
      costBasis,
      currency: 'USD',
      skuCount: 0,
      locationCount: 0,
      rowCount: 0,
      totalOnHand: toQuantity(ZERO_DECIMAL4),
      totalValue: toMoney(ZERO_DECIMAL4),
      totalFifoValue: toMoney(ZERO_DECIMAL4),
      totalWacValue: toMoney(ZERO_DECIMAL4),
      estimatedNegativeCount: 0,
    };
  }

  const skuIds = [...new Set(rows.map((r) => r.skuId))];
  const locIds = [...new Set(rows.map((r) => r.locationId))];
  const [skus, slottedMap] = await Promise.all([
    getSkusByIds(db, skuIds),
    fetchSlottedSumsByPair(db, skuIds, locIds),
  ]);
  const skuMap = new Map(skus.map((s) => [s.id, s]));

  let totalOnHand = toQuantity(ZERO_DECIMAL4);
  let totalFifoValue = toMoney(ZERO_DECIMAL4);
  let totalWacValue = toMoney(ZERO_DECIMAL4);
  let estimatedNegativeCount = 0;

  for (const row of rows) {
    const onHand = toQuantity(row.onHand);
    const wac = toUnitCost(row.weightedAverageCost);
    const rowWacVal = toMoney(mul(onHand, wac));

    totalOnHand = add(totalOnHand, onHand);
    totalWacValue = add(totalWacValue, rowWacVal);
    if (isZeroOrNegative(onHand)) {
      estimatedNegativeCount += 1;
    }

    const sku = skuMap.get(row.skuId);
    if (sku?.trackLots) {
      const slotted = slottedMap.get(`${row.skuId}:${row.locationId}`);
      const totalSlotted = slotted?.totalSlotted ?? toQuantity(ZERO_DECIMAL4);
      const slottedFifoValue = slotted?.slottedFifoValue ?? toMoney(ZERO_DECIMAL4);
      const unlotted = sub(onHand, totalSlotted);
      const rowFifoVal = toMoney(add(slottedFifoValue, toMoney(mul(unlotted, wac))));
      totalFifoValue = add(totalFifoValue, rowFifoVal);
    } else {
      totalFifoValue = add(totalFifoValue, rowWacVal);
    }
  }

  return {
    costBasis,
    currency: rows[0]?.currency ?? 'USD',
    skuCount: skuIds.length,
    locationCount: locIds.length,
    rowCount: rows.length,
    totalOnHand,
    totalValue: costBasis === 'FIFO' ? totalFifoValue : totalWacValue,
    totalFifoValue,
    totalWacValue,
    estimatedNegativeCount,
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

interface BalanceValuationInput {
  skuId: string;
  locationId: string | null;
  onHand: Quantity;
  reserved: Quantity;
  available: Quantity;
  inTransit: Quantity;
  weightedAverageCost: UnitCost;
  wacValue: Money;
  fifoValue?: Money | undefined;
  currency: string;
  updatedAt: Date | null;
}

async function fetchSlottedSumsByPair(
  db: Database,
  skuIds: string[],
  locIds: string[],
): Promise<Map<string, { totalSlotted: Quantity; slottedFifoValue: Money }>> {
  if (skuIds.length === 0 || locIds.length === 0) {
    return new Map();
  }
  const lotBalSums = await db
    .select({
      skuId: stockLots.skuId,
      locationId: stockLotBalances.locationId,
      totalSlotted: sql<string>`COALESCE(SUM(${stockLotBalances.onHand}), 0)`,
      slottedFifoValue: sql<string>`COALESCE(ROUND(SUM(${stockLotBalances.onHand} * ${stockLotBalances.unitCost}), 4), 0)`,
    })
    .from(stockLotBalances)
    .innerJoin(stockLots, eq(stockLotBalances.lotId, stockLots.id))
    .where(and(inArray(stockLots.skuId, skuIds), inArray(stockLotBalances.locationId, locIds)))
    .groupBy(stockLots.skuId, stockLotBalances.locationId);

  return new Map(
    lotBalSums.map((r) => [
      `${r.skuId}:${r.locationId}`,
      {
        totalSlotted: toQuantity(r.totalSlotted),
        slottedFifoValue: toMoney(r.slottedFifoValue),
      },
    ]),
  );
}

async function buildBalanceValuationRows(
  db: Database,
  entries: BalanceValuationInput[],
  costBasis: ValuationCostBasis = 'FIFO',
): Promise<StockBalance[]> {
  if (entries.length === 0) {
    return [];
  }

  const skuIds = [...new Set(entries.map((e) => e.skuId))];
  const locIds = [
    ...new Set(entries.map((e) => e.locationId).filter((id): id is string => id !== null)),
  ];

  const [skus, locRows, slottedMap] = await Promise.all([
    getSkusByIds(db, skuIds),
    locIds.length > 0
      ? db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds))
      : Promise.resolve([]),
    fetchSlottedSumsByPair(db, skuIds, locIds),
  ]);

  const skuMap = new Map(skus.map((s) => [s.id, s]));
  const locMap = new Map(locRows.map((l) => [l.id, l.name]));

  return entries.map((entry) => {
    const valuationStatus: ValuationStatus = isZeroOrNegative(entry.onHand)
      ? 'ESTIMATED_NEGATIVE_STOCK'
      : 'NORMAL';
    const zeroOrNegativeFlag =
      isZeroOrNegative(entry.onHand) || isZeroOrNegative(entry.available);
    const sku = skuMap.get(entry.skuId);
    const sellingPrice = sku?.defaultSellingPrice ?? null;

    let unlottedOnHand: Quantity | undefined;
    let fifoValue: Money;

    if (entry.fifoValue !== undefined) {
      fifoValue = entry.fifoValue;
    } else if (entry.locationId !== null && sku?.trackLots) {
      const slotted = slottedMap.get(`${entry.skuId}:${entry.locationId}`);
      const totalSlotted = slotted?.totalSlotted ?? toQuantity(ZERO_DECIMAL4);
      const slottedFifoValue = slotted?.slottedFifoValue ?? toMoney(ZERO_DECIMAL4);
      const diff = sub(entry.onHand, totalSlotted);
      unlottedOnHand = isPositive(diff) ? diff : toQuantity(ZERO_DECIMAL4);
      fifoValue = toMoney(add(slottedFifoValue, toMoney(mul(diff, entry.weightedAverageCost))));
    } else {
      fifoValue = entry.wacValue;
    }

    const totalValue = costBasis === 'FIFO' ? fifoValue : entry.wacValue;
    const effectiveUnitCost =
      costBasis === 'FIFO' && isPositive(entry.onHand)
        ? toUnitCost(div(fifoValue, entry.onHand))
        : entry.weightedAverageCost;

    const { grossMargin, grossMarginPercent } = computeMargins(
      sellingPrice,
      effectiveUnitCost,
    );

    return {
      skuId: entry.skuId,
      skuCode: sku?.code ?? entry.skuId,
      skuName: sku?.name ?? 'Unknown SKU',
      locationId: entry.locationId,
      locationName:
        entry.locationId !== null ? (locMap.get(entry.locationId) ?? 'Unknown Location') : null,
      onHand: entry.onHand,
      reserved: entry.reserved,
      available: entry.available,
      inTransit: entry.inTransit,
      ...(unlottedOnHand !== undefined ? { unlottedOnHand } : {}),
      costBasis,
      unitCost: effectiveUnitCost,
      weightedAverageCost: entry.weightedAverageCost,
      totalValue,
      fifoValue,
      wacValue: entry.wacValue,
      sellingPrice,
      grossMargin,
      grossMarginPercent,
      currency: entry.currency,
      valuationStatus,
      zeroOrNegativeFlag,
      updatedAt: entry.updatedAt ? entry.updatedAt.toISOString() : null,
    };
  });
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

  const costBasis: ValuationCostBasis = query.costBasis ?? 'FIFO';
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

    const allSkuIds = [...new Set(rows.map((r) => r.skuId))];
    const allLocIds = [...new Set(rows.map((r) => r.locationId))];
    const [skus, slottedMap] = await Promise.all([
      getSkusByIds(db, allSkuIds),
      fetchSlottedSumsByPair(db, allSkuIds, allLocIds),
    ]);
    const skuMap = new Map(skus.map((s) => [s.id, s]));

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

    const aggregatedEntries: BalanceValuationInput[] = [];
    for (const skuId of skuIds) {
      const group = bySku.get(skuId)!;
      const sku = skuMap.get(skuId);
      let onHand = toQuantity('0');
      let reserved = toQuantity('0');
      let inTransit = toQuantity('0');
      let wacValue = toMoney('0');
      let fifoValue = toMoney('0');
      let latestUpdatedAt: Date | null = null;
      let fallbackWac = toUnitCost('0');

      for (const r of group) {
        const rowOnHand = toQuantity(r.onHand);
        const rowWac = toUnitCost(r.weightedAverageCost);
        const rowWacVal = toMoney(mul(rowOnHand, rowWac));
        onHand = add(onHand, rowOnHand);
        reserved = add(reserved, toQuantity(r.reserved));
        inTransit = add(inTransit, toQuantity(r.inTransit));
        wacValue = add(wacValue, rowWacVal);

        if (sku?.trackLots) {
          const slotted = slottedMap.get(`${r.skuId}:${r.locationId}`);
          const totalSlotted = slotted?.totalSlotted ?? toQuantity(ZERO_DECIMAL4);
          const slottedFifoValue = slotted?.slottedFifoValue ?? toMoney(ZERO_DECIMAL4);
          const unlotted = sub(rowOnHand, totalSlotted);
          const rowFifoVal = toMoney(add(slottedFifoValue, toMoney(mul(unlotted, rowWac))));
          fifoValue = add(fifoValue, rowFifoVal);
        } else {
          fifoValue = add(fifoValue, rowWacVal);
        }

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

      let weightedAverageCost: UnitCost;
      if (isPositive(onHand)) {
        weightedAverageCost = toUnitCost(div(wacValue, onHand));
      } else {
        weightedAverageCost = fallbackWac;
        wacValue = toMoney(mul(onHand, weightedAverageCost));
        if (!sku?.trackLots) {
          fifoValue = wacValue;
        }
      }

      aggregatedEntries.push({
        skuId,
        locationId: null,
        onHand,
        reserved,
        available,
        inTransit,
        weightedAverageCost,
        wacValue,
        fifoValue,
        currency: group[0]?.currency ?? 'USD',
        updatedAt: latestUpdatedAt,
      });
    }

    const hasMore = aggregatedEntries.length > limit;
    const pageEntries = hasMore ? aggregatedEntries.slice(0, limit) : aggregatedEntries;
    const items = await buildBalanceValuationRows(db, pageEntries, costBasis);
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

  const items = await buildBalanceValuationRows(
    db,
    pageRows.map((row) => {
      const onHand = toQuantity(row.onHand);
      const weightedAverageCost = toUnitCost(row.weightedAverageCost);
      return {
        skuId: row.skuId,
        locationId: row.locationId,
        onHand,
        reserved: toQuantity(row.reserved),
        available: toQuantity(row.available),
        inTransit: toQuantity(row.inTransit),
        weightedAverageCost,
        wacValue: toMoney(mul(onHand, weightedAverageCost)),
        currency: row.currency,
        updatedAt: row.updatedAt,
      };
    }),
    costBasis,
  );

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
  const lotIds = [...new Set(page.items.map((r) => r.lotId).filter((id): id is string => id !== null))];

  const [skus, locRows, lotRows] = await Promise.all([
    getSkusByIds(db, skuIds),
    locIds.length > 0
      ? db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds))
      : Promise.resolve([]),
    lotIds.length > 0
      ? db
          .select({ id: stockLots.id, lotCode: stockLots.lotCode })
          .from(stockLots)
          .where(inArray(stockLots.id, lotIds))
      : Promise.resolve([]),
  ]);

  const skuMap = new Map(skus.map((s) => [s.id, { code: s.code, name: s.name }]));
  const locMap = new Map(locRows.map((l) => [l.id, l.name]));
  const lotMap = new Map(lotRows.map((l) => [l.id, l.lotCode]));

  return {
    items: page.items.map((r) =>
      toStockMovementDto(
        r,
        skuMap.get(r.skuId),
        locMap.get(r.locationId),
        r.lotId ? (lotMap.get(r.lotId) ?? null) : null,
      ),
    ),
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

export async function previewFefoAllocation(
  db: Database | DbTransaction,
  locationScope: LocationScope,
  query: FefoPreviewQuery,
  negativeStockPolicy: LotNegativeStockPolicy = 'FLEXIBLE_UNASSIGNED',
): Promise<PlanFefoAllocationResult> {
  const isLocationAllowed =
    ('allLocations' in locationScope && locationScope.allLocations) ||
    ('locationIds' in locationScope && locationScope.locationIds.includes(query.locationId));
  if (!isLocationAllowed) {
    throw new ForbiddenError(
      ERROR_CODES.FORBIDDEN,
      'Actor does not have access to the requested location',
    );
  }

  const [bal] = await db
    .select({ onHand: stockBalances.onHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.skuId, query.skuId), eq(stockBalances.locationId, query.locationId)))
    .limit(1);

  const totalOnHand = bal ? toQuantity(bal.onHand) : toQuantity(ZERO_DECIMAL4);

  const lotRows = await db
    .select({
      lotId: stockLots.id,
      lotCode: stockLots.lotCode,
      expDate: stockLots.expDate,
      createdAt: stockLots.createdAt,
      onHand: stockLotBalances.onHand,
      unitCost: stockLotBalances.unitCost,
    })
    .from(stockLotBalances)
    .innerJoin(stockLots, eq(stockLotBalances.lotId, stockLots.id))
    .where(and(eq(stockLots.skuId, query.skuId), eq(stockLotBalances.locationId, query.locationId)));

  let totalSlotted = toQuantity(ZERO_DECIMAL4);
  const candidates: FefoCandidateLot[] = [];
  for (const row of lotRows) {
    const qty = toQuantity(row.onHand);
    totalSlotted = add(totalSlotted, qty);
    candidates.push({
      lotId: row.lotId,
      lotCode: row.lotCode,
      expDate: row.expDate ?? null,
      createdAt: row.createdAt.toISOString(),
      onHand: qty,
      unitCost: toUnitCost(row.unitCost),
    });
  }

  const unlotted = sub(totalOnHand, totalSlotted);
  const positiveUnlottedQty = isPositive(unlotted) ? unlotted : toQuantity(ZERO_DECIMAL4);
  const today = query.today ?? new Date().toISOString().slice(0, 10);

  return planFefoAllocation({
    requestedQty: query.quantity,
    positiveUnlottedQty,
    lots: candidates,
    today,
    negativeStockPolicy,
  });
}

export async function getStockLotsByIds(
  db: Database | DbTransaction,
  lotIds: readonly UUID[],
): Promise<Array<{ id: UUID; skuId: UUID; lotCode: string; expDate: string | null }>> {
  const uniqueIds = [...new Set(lotIds)];
  if (uniqueIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      id: stockLots.id,
      skuId: stockLots.skuId,
      lotCode: stockLots.lotCode,
      expDate: stockLots.expDate,
    })
    .from(stockLots)
    .where(inArray(stockLots.id, uniqueIds));
  return rows.map((r) => ({
    id: r.id,
    skuId: r.skuId,
    lotCode: r.lotCode,
    expDate: r.expDate ?? null,
  }));
}

export async function getRecentReceiptCosts(
  db: Database | DbTransaction,
  scope: LocationScope,
  skuId: UUID,
  query: RecentReceiptCostsQuery,
): Promise<RecentReceiptCostsResult> {
  if ('allLocations' in scope && !scope.allLocations) {
    return {
      skuId,
      locationId: query.locationId ?? null,
      suggestedUnitCost: null,
      currency: 'USD',
      recentReceipts: [],
    };
  }
  if ('locationIds' in scope && scope.locationIds.length === 0) {
    return {
      skuId,
      locationId: query.locationId ?? null,
      suggestedUnitCost: null,
      currency: 'USD',
      recentReceipts: [],
    };
  }

  const conditions: SQL[] = [
    eq(stockMovements.skuId, skuId),
    eq(stockMovements.type, 'RECEIPT'),
    eq(stockMovements.referenceType, 'PURCHASE_ORDER'),
    isNotNull(stockMovements.unitCost),
  ];

  if (query.locationId) {
    conditions.push(eq(stockMovements.locationId, query.locationId));
  } else if ('locationIds' in scope) {
    conditions.push(inArray(stockMovements.locationId, [...scope.locationIds]));
  }

  const rows = await db
    .select({
      movementId: stockMovements.id,
      referenceId: stockMovements.referenceId,
      locationId: stockMovements.locationId,
      quantityDelta: stockMovements.quantityDelta,
      unitCost: stockMovements.unitCost,
      currency: stockMovements.currency,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(and(...conditions))
    .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
    .limit(query.limit);

  const recentReceipts: RecentReceiptCostItem[] = rows.map((r) => ({
    movementId: r.movementId,
    referenceId: r.referenceId ?? null,
    locationId: r.locationId,
    quantity: toQuantity(r.quantityDelta),
    recentUnitCost: toUnitCost(r.unitCost!),
    currency: r.currency,
    createdAt: r.createdAt.toISOString(),
  }));

  let suggestedUnitCost: UnitCost | null =
    recentReceipts.length > 0 ? recentReceipts[0]!.recentUnitCost! : null;
  let currency = recentReceipts.length > 0 ? recentReceipts[0]!.currency : 'USD';

  if (suggestedUnitCost === null && query.locationId) {
    const [bal] = await db
      .select({
        weightedAverageCost: stockBalances.weightedAverageCost,
        currency: stockBalances.currency,
      })
      .from(stockBalances)
      .where(and(eq(stockBalances.skuId, skuId), eq(stockBalances.locationId, query.locationId)))
      .limit(1);
    if (bal) {
      currency = bal.currency;
      const wac = toUnitCost(bal.weightedAverageCost);
      if (isPositive(wac)) {
        suggestedUnitCost = wac;
      }
    }
  }

  return {
    skuId,
    locationId: query.locationId ?? null,
    suggestedUnitCost,
    currency,
    recentReceipts,
  };
}

export interface AssignOpeningLotsParams {
  skuId: UUID;
  locationId: UUID;
  lots: readonly AssignOpeningLotLineInput[];
  currency?: string | undefined;
  note?: string | null | undefined;
  actorId: string;
  idempotencyKey: string;
}

export interface AssignOpeningLotsResult {
  movements: StockMovement[];
  assignedQuantity: Quantity;
  remainingUnlottedQuantity: Quantity;
  replayed: boolean;
}

export async function assignOpeningLots(
  tx: DbTransaction,
  params: AssignOpeningLotsParams,
  options?: { emit?: EmitEventFn | undefined },
): Promise<AssignOpeningLotsResult> {
  if (params.lots.length === 0) {
    throw new ValidationError(ERROR_CODES.VALIDATION_ERROR, 'At least one opening lot is required');
  }

  // Idempotency replay check
  const existingMovements = await tx
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.idempotencyKey, params.idempotencyKey))
    .orderBy(asc(stockMovements.sliceIndex));

  if (existingMovements.length > 0) {
    const lotIds = existingMovements
      .map((m) => m.lotId)
      .filter((id): id is string => id !== null);
    const lotMap = new Map(
      (await getStockLotsByIds(tx, lotIds)).map((l) => [l.id, l.lotCode]),
    );
    const negRow = existingMovements.find((m) => m.lotId === null);
    const assignedQuantity = negRow ? abs(toQuantity(negRow.quantityDelta)) : toQuantity(ZERO_DECIMAL4);

    const [bal] = await tx
      .select({ onHand: stockBalances.onHand })
      .from(stockBalances)
      .where(and(eq(stockBalances.skuId, params.skuId), eq(stockBalances.locationId, params.locationId)))
      .limit(1);
    const totalOnHand = bal ? toQuantity(bal.onHand) : toQuantity(ZERO_DECIMAL4);
    const lotBalRows = await tx
      .select({ onHand: stockLotBalances.onHand })
      .from(stockLotBalances)
      .innerJoin(stockLots, eq(stockLotBalances.lotId, stockLots.id))
      .where(and(eq(stockLots.skuId, params.skuId), eq(stockLotBalances.locationId, params.locationId)));
    let slotted = toQuantity(ZERO_DECIMAL4);
    for (const r of lotBalRows) {
      slotted = add(slotted, toQuantity(r.onHand));
    }
    const diff = sub(totalOnHand, slotted);
    const remainingUnlottedQuantity = isPositive(diff) ? diff : toQuantity(ZERO_DECIMAL4);

    return {
      movements: existingMovements.map((m) =>
        toStockMovementDto(m, undefined, undefined, m.lotId ? (lotMap.get(m.lotId) ?? null) : null),
      ),
      assignedQuantity,
      remainingUnlottedQuantity,
      replayed: true,
    };
  }

  const skus = await getSkusByIds(tx, [params.skuId]);
  const sku = skus[0];
  if (!sku) {
    throw new NotFoundError(ERROR_CODES.SKU_NOT_FOUND, `SKU ${params.skuId} not found`);
  }
  if (!sku.trackLots) {
    throw new ValidationError(
      ERROR_CODES.INVALID_LOT_CONFIGURATION,
      `SKU ${sku.code} must have trackLots enabled before assigning opening lots`,
    );
  }

  let totalAssigned = toQuantity(ZERO_DECIMAL4);
  for (const lot of params.lots) {
    if (!isPositive(lot.quantity)) {
      throw new ValidationError(
        ERROR_CODES.VALIDATION_ERROR,
        'Opening lot quantity must be greater than zero',
      );
    }
    if (sku.trackExpiry && !lot.expDate) {
      throw new ValidationError(
        ERROR_CODES.EXPIRY_DATE_REQUIRED,
        `Expiry date is required for lot "${lot.lotCode}" on SKU ${sku.code}`,
      );
    }
    totalAssigned = add(totalAssigned, lot.quantity);
  }

  const pairs: StockPair[] = [{ skuId: params.skuId, locationId: params.locationId }];
  const balanceMap = await upsertAndLockBalances(tx, pairs);
  const lotBalanceMap = await lockLotBalancesForPairs(tx, pairs);

  const key = pairKey(params.skuId, params.locationId);
  const state = balanceMap.get(key);
  if (!state) {
    throw new ValidationError(
      ERROR_CODES.VALIDATION_ERROR,
      'No positive unlotted stock available at this location to assign',
    );
  }

  const lotEntries = lotBalanceMap.get(key) ?? [];
  let totalSlotted = toQuantity(ZERO_DECIMAL4);
  for (const entry of lotEntries) {
    totalSlotted = add(totalSlotted, entry.onHand);
  }
  const unlottedOnHand = sub(state.onHand, totalSlotted);
  if (!isPositive(unlottedOnHand)) {
    throw new ValidationError(
      ERROR_CODES.VALIDATION_ERROR,
      'No positive unlotted stock available at this location to assign',
    );
  }

  if (isPositive(sub(totalAssigned, unlottedOnHand))) {
    throw new ValidationError(
      ERROR_CODES.VALIDATION_ERROR,
      `Declared lot quantities (${totalAssigned}) exceed available positive unlotted stock (${unlottedOnHand})`,
    );
  }

  const effectiveCurrency = params.currency ?? state.currency ?? 'USD';
  const groupId = uuidv7();
  const insertedMovements: StockMovement[] = [];

  // Slice 0: -totalAssigned from unlotted stock (lotId = null)
  const [unlottedRow] = await tx
    .insert(stockMovements)
    .values({
      id: uuidv7(),
      type: 'ADJUSTMENT',
      skuId: params.skuId,
      locationId: params.locationId,
      lotId: null,
      sliceIndex: 0,
      movementGroupId: groupId,
      quantityDelta: negate(totalAssigned),
      unitCost: state.weightedAverageCost,
      wacUnitCost: state.weightedAverageCost,
      currency: effectiveCurrency,
      reasonCategory: 'STOCK_COUNT',
      note: params.note ?? 'Opening lot assignment (unlotted reclassification)',
      referenceType: 'OPENING_LOT_ASSIGNMENT',
      referenceId: groupId,
      actorId: params.actorId,
      idempotencyKey: params.idempotencyKey,
    })
    .returning();

  const unlottedDto = toStockMovementDto(unlottedRow!, undefined, undefined, null);
  insertedMovements.push(unlottedDto);
  await emitOutboxEvent(tx, options?.emit, {
    eventType: eventTypeForMovement('ADJUSTMENT'),
    aggregateType: 'stock_movement',
    aggregateId: unlottedDto.id,
    payload: unlottedDto,
  });

  // Slices 1..N: +qty per declared Stock Lot
  for (let idx = 0; idx < params.lots.length; idx++) {
    const lot = params.lots[idx]!;
    const lotUnitCost = lot.unitCost ?? state.weightedAverageCost;
    const { lotId, lotCode } = await upsertAndUpdateStockLot(tx, {
      skuId: params.skuId,
      locationId: params.locationId,
      lotInput: {
        lotCode: lot.lotCode,
        mfgDate: lot.mfgDate ?? null,
        expDate: lot.expDate ?? null,
      },
      quantityDelta: lot.quantity,
      incomingUnitCost: lotUnitCost,
      currency: effectiveCurrency,
      blendCost: true,
    });

    const [lotRow] = await tx
      .insert(stockMovements)
      .values({
        id: uuidv7(),
        type: 'ADJUSTMENT',
        skuId: params.skuId,
        locationId: params.locationId,
        lotId,
        sliceIndex: idx + 1,
        movementGroupId: groupId,
        quantityDelta: lot.quantity,
        unitCost: lotUnitCost,
        wacUnitCost: state.weightedAverageCost,
        currency: effectiveCurrency,
        reasonCategory: 'STOCK_COUNT',
        note: params.note ?? 'Opening lot assignment',
        referenceType: 'OPENING_LOT_ASSIGNMENT',
        referenceId: groupId,
        actorId: params.actorId,
        idempotencyKey: params.idempotencyKey,
      })
      .returning();

    const lotDto = toStockMovementDto(lotRow!, undefined, undefined, lotCode);
    insertedMovements.push(lotDto);
    await emitOutboxEvent(tx, options?.emit, {
      eventType: eventTypeForMovement('ADJUSTMENT'),
      aggregateType: 'stock_movement',
      aggregateId: lotDto.id,
      payload: lotDto,
    });
  }

  const remainingUnlottedQuantity = sub(unlottedOnHand, totalAssigned);

  return {
    movements: insertedMovements,
    assignedQuantity: totalAssigned,
    remainingUnlottedQuantity,
    replayed: false,
  };
}

// Keep unused gte import check clean if not needed
void formatDecimal4;
void gte;

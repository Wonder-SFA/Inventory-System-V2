import type { Database } from '@iv2/db';
import {
  type ApiWarning,
  BadRequestError,
  type Decimal4,
  ERROR_CODES,
  type FefoCandidateLot,
  type FefoPreviewQuery,
  type ListStockBalancesQuery,
  type ListStockMovementsQuery,
  type LotInput,
  type LotNegativeStockPolicy,
  type LotPickingMode,
  type Money,
  NotFoundError,
  type PlanFefoAllocationResult,
  type Quantity,
  type StockBalance,
  type StockMovement,
  type StockMovementType,
  type UUID,
  type UnitCost,
  type ValuationStatus,
  ValidationError,
  ZERO_DECIMAL4,
  abs,
  add,
  calculateBlendedLotCost,
  calculateWeightedAverageCost,
  div,
  formatDecimal4,
  isNegative,
  isPositive,
  isZero,
  isZeroOrNegative,
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
import { type SQL, and, asc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
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
  registerSkuPositiveStockChecker,
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
  pickingMode?: LotPickingMode | undefined;
  negativeStockPolicy?: LotNegativeStockPolicy | undefined;
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
  unitCost: UnitCost;
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
      unitCost: toUnitCost(bal.unitCost),
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

  // Lock 2: stock_lot_balances sorted by (lot_id, location_id) for lot-tracked outbound issues
  const fefoPairs = newLines
    .filter(
      (l) =>
        l.type === 'ISSUE' &&
        isNegative(l.quantityDelta) &&
        skuMap.get(l.skuId)?.trackLots === true,
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

    // Outbound ISSUE on lot-tracked SKU without explicit lotInput -> apply pickingMode / FEFO
    if (
      line.type === 'ISSUE' &&
      isNegative(line.quantityDelta) &&
      sku?.trackLots &&
      !line.lotInput?.lotCode?.trim()
    ) {
      const pickingMode: LotPickingMode = line.pickingMode ?? 'AUTO_FEFO';

      if (pickingMode === 'MANUAL_REQUIRED' && !line.lotId) {
        throw new ValidationError(
          ERROR_CODES.LOT_CODE_REQUIRED,
          `Manual lot selection is required when issuing lot-tracked SKU ${sku.code}`,
        );
      }

      if (pickingMode === 'MANUAL_OPTIONAL' && !line.lotId) {
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
          })
          .returning();

        const dto = toStockMovementDto(row!, undefined, undefined, null);
        insertedMovements.push(dto);
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

        const recordedUnitCost = entry.unitCost;
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
            lotId: entry.lotId,
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

        const dto = toStockMovementDto(row!, undefined, undefined, entry.lotCode);
        insertedMovements.push(dto);
        warnings.push(...collectStockWarnings(state));
        await emitOutboxEvent(tx, options?.emit, {
          eventType: eventTypeForMovement(line.type),
          aggregateType: 'stock_movement',
          aggregateId: dto.id,
          payload: dto,
        });
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

      const today = line.today ?? new Date().toISOString().slice(0, 10);
      const plan = planFefoAllocation({
        requestedQty: abs(line.quantityDelta),
        positiveUnlottedQty,
        lots: candidates,
        today,
        negativeStockPolicy: line.negativeStockPolicy ?? 'FLEXIBLE_UNASSIGNED',
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

interface BalanceValuationInput {
  skuId: string;
  locationId: string | null;
  onHand: Quantity;
  reserved: Quantity;
  available: Quantity;
  inTransit: Quantity;
  weightedAverageCost: UnitCost;
  totalValue: Money;
  currency: string;
  updatedAt: Date | null;
}

async function buildBalanceValuationRows(
  db: Database,
  entries: BalanceValuationInput[],
): Promise<StockBalance[]> {
  if (entries.length === 0) {
    return [];
  }

  const skuIds = [...new Set(entries.map((e) => e.skuId))];
  const locIds = [
    ...new Set(entries.map((e) => e.locationId).filter((id): id is string => id !== null)),
  ];

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

  return entries.map((entry) => {
    const valuationStatus: ValuationStatus = isZeroOrNegative(entry.onHand)
      ? 'ESTIMATED_NEGATIVE_STOCK'
      : 'NORMAL';
    const zeroOrNegativeFlag =
      isZeroOrNegative(entry.onHand) || isZeroOrNegative(entry.available);
    const sku = skuMap.get(entry.skuId);
    const sellingPrice = sku?.defaultSellingPrice ?? null;
    const { grossMargin, grossMarginPercent } = computeMargins(
      sellingPrice,
      entry.weightedAverageCost,
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
      weightedAverageCost: entry.weightedAverageCost,
      totalValue: entry.totalValue,
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

    const aggregatedEntries: BalanceValuationInput[] = [];
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

      let weightedAverageCost: UnitCost;
      if (isPositive(onHand)) {
        weightedAverageCost = toUnitCost(div(totalValue, onHand));
      } else {
        weightedAverageCost = fallbackWac;
        totalValue = toMoney(mul(onHand, weightedAverageCost));
      }

      aggregatedEntries.push({
        skuId,
        locationId: null,
        onHand,
        reserved,
        available,
        inTransit,
        weightedAverageCost,
        totalValue,
        currency: group[0]?.currency ?? 'USD',
        updatedAt: latestUpdatedAt,
      });
    }

    const hasMore = aggregatedEntries.length > limit;
    const pageEntries = hasMore ? aggregatedEntries.slice(0, limit) : aggregatedEntries;
    const items = await buildBalanceValuationRows(db, pageEntries);
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
        totalValue: toMoney(mul(onHand, weightedAverageCost)),
        currency: row.currency,
        updatedAt: row.updatedAt,
      };
    }),
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

async function hasInventoryPositiveOnHandStock(
  db: Database | DbTransaction,
  skuId: string,
): Promise<boolean> {
  const [bal] = await db
    .select({ skuId: stockBalances.skuId })
    .from(stockBalances)
    .where(and(eq(stockBalances.skuId, skuId), sql`${stockBalances.onHand} > 0`))
    .limit(1);
  return Boolean(bal);
}

export function registerInventoryReferenceCheckers(): void {
  if (referenceCheckersRegistered) {
    return;
  }
  registerSkuReferenceChecker(hasInventorySkuReferences);
  registerSkuPositiveStockChecker(hasInventoryPositiveOnHandStock);
  registerLocationReferenceChecker(hasInventoryLocationReferences);
  referenceCheckersRegistered = true;
}

export async function previewFefoAllocation(
  db: Database | DbTransaction,
  query: FefoPreviewQuery,
  negativeStockPolicy: LotNegativeStockPolicy = 'FLEXIBLE_UNASSIGNED',
): Promise<PlanFefoAllocationResult> {
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

// Keep unused gte import check clean if not needed
void formatDecimal4;
void gte;

import {
  type Quantity,
  type UnitCost,
  ZERO_DECIMAL4,
  gt,
  isPositive,
  lt,
  sub,
  toQuantity,
} from '../decimal/index.js';
import { ERROR_CODES, ValidationError } from '../http/index.js';
import type { LotNegativeStockPolicy } from '../iam/index.js';

export interface FefoCandidateLot {
  lotId: string;
  lotCode: string;
  expDate: string | null;
  createdAt: string;
  onHand: Quantity;
  unitCost: UnitCost;
}

export interface FefoAllocationSlice {
  lotId: string | null;
  lotCode: string | null;
  expDate: string | null;
  quantity: Quantity;
  unitCost: UnitCost | null;
  isUnlotted: boolean;
  negativeStockWarning: boolean;
}

export interface PlanFefoAllocationInput {
  requestedQty: Quantity;
  positiveUnlottedQty: Quantity;
  lots: readonly FefoCandidateLot[];
  today: string;
  negativeStockPolicy: LotNegativeStockPolicy;
}

export interface PlanFefoAllocationResult {
  slices: FefoAllocationSlice[];
  totalAllocatedQty: Quantity;
  shortfallQty: Quantity;
  hasNegativeStockWarning: boolean;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareCreatedAt(a: string, b: string): number {
  const timeA = Date.parse(a);
  const timeB = Date.parse(b);
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
    return timeA - timeB;
  }
  return compareStrings(a, b);
}

function compareCandidateLotsFefo(a: FefoCandidateLot, b: FefoCandidateLot): number {
  if (a.expDate !== null && b.expDate === null) return -1;
  if (a.expDate === null && b.expDate !== null) return 1;
  if (a.expDate !== null && b.expDate !== null) {
    const expCmp = compareStrings(a.expDate, b.expDate);
    if (expCmp !== 0) return expCmp;
  }
  const createdCmp = compareCreatedAt(a.createdAt, b.createdAt);
  if (createdCmp !== 0) return createdCmp;
  return compareStrings(a.lotId, b.lotId);
}

/**
 * Pure FEFO (First-Expired, First-Out) allocation planner.
 *
 * 1. Drains positive unlotted stock first (`lotId: null`).
 * 2. Skips expired lots (`expDate != null && expDate < today`).
 * 3. Allocates remaining positive-balance lots by earliest `expDate` (NULL last),
 *    tie-breaking by oldest `createdAt` (FIFO), then `lotId` ascending.
 * 4. Handles shortfall per `negativeStockPolicy` (`FLEXIBLE_UNASSIGNED` vs `STRICT_BLOCK`).
 */
export function planFefoAllocation(input: PlanFefoAllocationInput): PlanFefoAllocationResult {
  if (!isPositive(input.requestedQty)) {
    throw new ValidationError(
      ERROR_CODES.VALIDATION_ERROR,
      'Requested allocation quantity must be greater than zero',
    );
  }

  let remaining: Quantity = input.requestedQty;
  const slices: FefoAllocationSlice[] = [];

  if (isPositive(input.positiveUnlottedQty)) {
    const take = lt(remaining, input.positiveUnlottedQty) ? remaining : input.positiveUnlottedQty;
    slices.push({
      lotId: null,
      lotCode: null,
      expDate: null,
      quantity: take,
      unitCost: null,
      isUnlotted: true,
      negativeStockWarning: false,
    });
    remaining = sub(remaining, take);
  }

  if (isPositive(remaining)) {
    const eligibleLots = input.lots
      .filter(
        (lot) => isPositive(lot.onHand) && (lot.expDate === null || lot.expDate >= input.today),
      )
      .sort(compareCandidateLotsFefo);

    for (const lot of eligibleLots) {
      if (!isPositive(remaining)) break;
      const take = lt(remaining, lot.onHand) ? remaining : lot.onHand;
      slices.push({
        lotId: lot.lotId,
        lotCode: lot.lotCode,
        expDate: lot.expDate,
        quantity: take,
        unitCost: lot.unitCost,
        isUnlotted: false,
        negativeStockWarning: false,
      });
      remaining = sub(remaining, take);
    }
  }

  let shortfallQty = toQuantity(ZERO_DECIMAL4);
  let hasNegativeStockWarning = false;

  if (isPositive(remaining)) {
    if (input.negativeStockPolicy === 'STRICT_BLOCK') {
      throw new ValidationError(
        ERROR_CODES.INSUFFICIENT_LOT_STOCK,
        `Insufficient non-expired stock to allocate ${input.requestedQty}; shortfall of ${remaining}`,
      );
    }
    shortfallQty = remaining;
    hasNegativeStockWarning = true;
    slices.push({
      lotId: null,
      lotCode: null,
      expDate: null,
      quantity: remaining,
      unitCost: null,
      isUnlotted: true,
      negativeStockWarning: true,
    });
    remaining = toQuantity(ZERO_DECIMAL4);
  }

  const totalAllocatedQty = gt(remaining, toQuantity(ZERO_DECIMAL4))
    ? sub(input.requestedQty, remaining)
    : input.requestedQty;

  return {
    slices,
    totalAllocatedQty,
    shortfallQty,
    hasNegativeStockWarning,
  };
}

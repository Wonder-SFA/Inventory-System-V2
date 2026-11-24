import { Decimal } from 'decimal.js';
import { z } from 'zod';

declare const DECIMAL4_BRAND: unique symbol;
declare const QUANTITY_BRAND: unique symbol;
declare const UNIT_COST_BRAND: unique symbol;
declare const MONEY_BRAND: unique symbol;

export type Decimal4 = string & { readonly [DECIMAL4_BRAND]: true };
export type Quantity = Decimal4 & { readonly [QUANTITY_BRAND]: true };
export type UnitCost = Decimal4 & { readonly [UNIT_COST_BRAND]: true };
export type Money = Decimal4 & { readonly [MONEY_BRAND]: true };

export const DECIMAL_PRECISION_EXCEEDED_CODE = 'DECIMAL_PRECISION_EXCEEDED' as const;
export const DECIMAL_OVERFLOW_CODE = 'DECIMAL_OVERFLOW' as const;

export const MAX_DECIMAL4 = '99999999999999.9999' as Decimal4;
export const MIN_DECIMAL4 = '-99999999999999.9999' as Decimal4;
export const ZERO_DECIMAL4 = '0.0000' as Decimal4;

const DECIMAL4_REGEX = /^-?\d+(\.\d{1,4})?$/;
const EXCESS_PRECISION_REGEX = /^-?\d+\.\d{5,}$/;

// Encapsulated decimal.js instance with 40 digits intermediate precision and half-up rounding.
const DecimalEngine = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

const MAX_ABS_DECIMAL = new DecimalEngine('99999999999999.9999');

function toCanonicalString(d: InstanceType<typeof DecimalEngine>): Decimal4 {
  const rounded = d.toDecimalPlaces(4, DecimalEngine.ROUND_HALF_UP);
  if (rounded.abs().gt(MAX_ABS_DECIMAL)) {
    throw new RangeError('Decimal4 overflow: value exceeds NUMERIC(18, 4) bounds');
  }
  if (rounded.isZero()) {
    return ZERO_DECIMAL4;
  }
  return rounded.toFixed(4) as Decimal4;
}

function parseEngine(value: string): InstanceType<typeof DecimalEngine> {
  if (!DECIMAL4_REGEX.test(value)) {
    if (EXCESS_PRECISION_REGEX.test(value)) {
      throw new RangeError(
        `${DECIMAL_PRECISION_EXCEEDED_CODE}: "${value}" exceeds 4 decimal places`,
      );
    }
    throw new TypeError(`Invalid Decimal4 string: "${value}"`);
  }
  const d = new DecimalEngine(value);
  if (d.abs().gt(MAX_ABS_DECIMAL)) {
    throw new RangeError(`${DECIMAL_OVERFLOW_CODE}: "${value}" exceeds NUMERIC(18, 4) bounds`);
  }
  return d;
}

export function formatDecimal4(value: string): Decimal4 {
  return toCanonicalString(parseEngine(value));
}

export function toQuantity(value: string): Quantity {
  return formatDecimal4(value) as Quantity;
}

export function toUnitCost(value: string): UnitCost {
  return formatDecimal4(value) as UnitCost;
}

export function toMoney(value: string): Money {
  return formatDecimal4(value) as Money;
}

export const zDecimal4: z.ZodType<Decimal4, z.ZodTypeDef, string> = z
  .string()
  .superRefine((val, ctx) => {
    if (EXCESS_PRECISION_REGEX.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Value must have at most 4 decimal places',
        params: { code: DECIMAL_PRECISION_EXCEEDED_CODE },
      });
      return;
    }
    if (!DECIMAL4_REGEX.test(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid decimal format; expected /^-?\\d+(\\.\\d{1,4})?$/',
        params: { code: 'INVALID_DECIMAL_FORMAT' },
      });
      return;
    }
    const d = new DecimalEngine(val);
    if (d.abs().gt(MAX_ABS_DECIMAL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Value exceeds NUMERIC(18, 4) bounds',
        params: { code: DECIMAL_OVERFLOW_CODE },
      });
    }
  })
  .transform((val) => formatDecimal4(val));

export const zQuantity: z.ZodType<Quantity, z.ZodTypeDef, string> = zDecimal4.transform(
  (v) => v as Quantity,
);

export const zUnitCost: z.ZodType<UnitCost, z.ZodTypeDef, string> = zDecimal4.transform(
  (v) => v as UnitCost,
);

export const zMoney: z.ZodType<Money, z.ZodTypeDef, string> = zDecimal4.transform(
  (v) => v as Money,
);

export function round4(value: string): Decimal4 {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new TypeError(`Invalid numeric string for round4: "${value}"`);
  }
  return toCanonicalString(new DecimalEngine(value));
}

export function add<T extends Decimal4>(a: T, b: T): T {
  const result = new DecimalEngine(a).plus(new DecimalEngine(b));
  return toCanonicalString(result) as T;
}

export function sub<T extends Decimal4>(a: T, b: T): T {
  const result = new DecimalEngine(a).minus(new DecimalEngine(b));
  return toCanonicalString(result) as T;
}

export function mul(a: Decimal4, b: Decimal4): Decimal4 {
  const result = new DecimalEngine(a).times(new DecimalEngine(b));
  return toCanonicalString(result);
}

export function div(a: Decimal4, b: Decimal4): Decimal4 {
  const divisor = new DecimalEngine(b);
  if (divisor.isZero()) {
    throw new RangeError('Division by zero');
  }
  const result = new DecimalEngine(a).div(divisor);
  return toCanonicalString(result);
}

export function negate<T extends Decimal4>(a: T): T {
  return toCanonicalString(new DecimalEngine(a).negated()) as T;
}

export function abs<T extends Decimal4>(a: T): T {
  return toCanonicalString(new DecimalEngine(a).abs()) as T;
}

export function eq(a: Decimal4, b: Decimal4): boolean {
  return new DecimalEngine(a).eq(new DecimalEngine(b));
}

export function gt(a: Decimal4, b: Decimal4): boolean {
  return new DecimalEngine(a).gt(new DecimalEngine(b));
}

export function gte(a: Decimal4, b: Decimal4): boolean {
  return new DecimalEngine(a).gte(new DecimalEngine(b));
}

export function lt(a: Decimal4, b: Decimal4): boolean {
  return new DecimalEngine(a).lt(new DecimalEngine(b));
}

export function lte(a: Decimal4, b: Decimal4): boolean {
  return new DecimalEngine(a).lte(new DecimalEngine(b));
}

export function isZero(a: Decimal4): boolean {
  return new DecimalEngine(a).isZero();
}

export function isPositive(a: Decimal4): boolean {
  return new DecimalEngine(a).gt(0);
}

export function isNegative(a: Decimal4): boolean {
  return new DecimalEngine(a).lt(0);
}

export function isZeroOrNegative(a: Decimal4): boolean {
  return new DecimalEngine(a).lte(0);
}

export interface WeightedAverageCostResult {
  weightedAverageCost: UnitCost;
  estimatedNegativeStock: boolean;
}

/**
 * Pure per-Location Weighted Average Cost calculation (ADR-0005):
 * - When `newQty <= 0`: preserve `oldWac` and flag `estimatedNegativeStock: true`.
 * - When `oldQty <= 0 && newQty > 0`: reset WAC to incoming `unitCost`.
 * - When `oldQty > 0 && newQty > 0`: `(oldQty * oldWac + receivedQty * unitCost) / newQty` rounded to 4 decimals.
 */
export function calculateWeightedAverageCost(
  oldQty: Quantity,
  oldWac: UnitCost,
  receivedQty: Quantity,
  unitCost: UnitCost,
): WeightedAverageCostResult {
  const dOldQty = new DecimalEngine(oldQty);
  const dOldWac = new DecimalEngine(oldWac);
  const dReceivedQty = new DecimalEngine(receivedQty);
  const dUnitCost = new DecimalEngine(unitCost);

  const dNewQty = dOldQty.plus(dReceivedQty);

  if (dNewQty.lte(0)) {
    return {
      weightedAverageCost: toCanonicalString(dOldWac) as UnitCost,
      estimatedNegativeStock: true,
    };
  }

  if (dOldQty.lte(0)) {
    return {
      weightedAverageCost: toCanonicalString(dUnitCost) as UnitCost,
      estimatedNegativeStock: false,
    };
  }

  const totalValue = dOldQty.times(dOldWac).plus(dReceivedQty.times(dUnitCost));
  const nextWac = totalValue.div(dNewQty);

  return {
    weightedAverageCost: toCanonicalString(nextWac) as UnitCost,
    estimatedNegativeStock: false,
  };
}

/**
 * Weighted average blending at 4-decimal precision for repeat receipts of the same Stock Lot (ADR-0009):
 * - When `existingQty <= 0`: returns `incomingUnitCost`.
 * - When `existingQty + receivedQty <= 0`: preserves `existingUnitCost`.
 * - Otherwise: `(existingQty * existingUnitCost + receivedQty * incomingUnitCost) / (existingQty + receivedQty)`.
 */
export function calculateBlendedLotCost(
  existingQty: Quantity,
  existingUnitCost: UnitCost,
  receivedQty: Quantity,
  incomingUnitCost: UnitCost,
): UnitCost {
  const dExistingQty = new DecimalEngine(existingQty);
  const dExistingCost = new DecimalEngine(existingUnitCost);
  const dReceivedQty = new DecimalEngine(receivedQty);
  const dIncomingCost = new DecimalEngine(incomingUnitCost);

  const dNewQty = dExistingQty.plus(dReceivedQty);

  if (dNewQty.lte(0)) {
    return toCanonicalString(dExistingCost) as UnitCost;
  }

  if (dExistingQty.lte(0)) {
    return toCanonicalString(dIncomingCost) as UnitCost;
  }

  const totalValue = dExistingQty.times(dExistingCost).plus(dReceivedQty.times(dIncomingCost));
  return toCanonicalString(totalValue.div(dNewQty)) as UnitCost;
}

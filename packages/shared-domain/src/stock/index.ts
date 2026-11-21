import { z } from 'zod';
import {
  type Money,
  type Quantity,
  type UnitCost,
  isNegative,
  isZero,
  zMoney,
  zQuantity,
  zUnitCost,
} from '../decimal/index.js';
import { CursorPaginationQuerySchema } from '../http/index.js';

export const StockMovementTypeSchema = z.enum([
  'RECEIPT',
  'ISSUE',
  'ADJUSTMENT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
]);
export type StockMovementType = z.infer<typeof StockMovementTypeSchema>;

export const AdjustmentReasonCategorySchema = z.enum([
  'STOCK_COUNT',
  'DAMAGED',
  'EXPIRED',
  'LOST',
  'OTHER',
]);
export type AdjustmentReasonCategory = z.infer<typeof AdjustmentReasonCategorySchema>;

export interface StockMovement {
  id: string;
  type: StockMovementType;
  skuId: string;
  skuCode?: string | undefined;
  skuName?: string | undefined;
  locationId: string;
  locationName?: string | undefined;
  quantityDelta: Quantity;
  unitCost?: UnitCost | null | undefined;
  currency: string;
  reasonCategory: string | null;
  note: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string;
  idempotencyKey: string;
  createdAt: string;
}

export const StockMovementSchema: z.ZodType<StockMovement, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  type: StockMovementTypeSchema,
  skuId: z.string().uuid(),
  skuCode: z.string().optional(),
  skuName: z.string().optional(),
  locationId: z.string().uuid(),
  locationName: z.string().optional(),
  quantityDelta: zQuantity,
  unitCost: zUnitCost.nullable().optional(),
  currency: z.string().length(3),
  reasonCategory: z.string().nullable(),
  note: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().uuid().nullable(),
  actorId: z.string(),
  idempotencyKey: z.string().uuid(),
  createdAt: z.string(),
});

export interface CreateStockAdjustmentInput {
  skuId: string;
  locationId: string;
  quantityDelta: Quantity;
  reasonCategory: AdjustmentReasonCategory;
  unitCost?: UnitCost | undefined;
  currency: string;
  note?: string | null | undefined;
}

export interface CreateStockAdjustmentRawInput {
  skuId: string;
  locationId: string;
  quantityDelta: string;
  reasonCategory: AdjustmentReasonCategory;
  unitCost?: string | undefined;
  currency?: string | undefined;
  note?: string | null | undefined;
}

export const CreateStockAdjustmentInputSchema: z.ZodType<
  CreateStockAdjustmentInput,
  z.ZodTypeDef,
  CreateStockAdjustmentRawInput
> = z.object({
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  quantityDelta: zQuantity.refine((val) => !isZero(val), {
    message: 'Quantity delta must be non-zero',
  }),
  reasonCategory: AdjustmentReasonCategorySchema,
  unitCost: zUnitCost
    .refine((val) => !isNegative(val), {
      message: 'Unit cost cannot be negative',
    })
    .optional(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  note: z.string().trim().max(1000).nullable().optional(),
});

export const ValuationStatusSchema = z.enum(['NORMAL', 'ESTIMATED_NEGATIVE_STOCK']);
export type ValuationStatus = z.infer<typeof ValuationStatusSchema>;

export const StockBalanceViewSchema = z.enum(['per-location', 'company-wide']);
export type StockBalanceView = z.infer<typeof StockBalanceViewSchema>;

export interface StockBalance {
  skuId: string;
  skuCode: string;
  skuName: string;
  locationId: string | null;
  locationName: string | null;
  onHand: Quantity;
  reserved: Quantity;
  available: Quantity;
  inTransit: Quantity;
  weightedAverageCost?: UnitCost | undefined;
  totalValue?: Money | undefined;
  sellingPrice: Money | null;
  grossMargin?: Money | null | undefined;
  grossMarginPercent?: string | null | undefined;
  currency: string;
  valuationStatus: ValuationStatus;
  zeroOrNegativeFlag: boolean;
  updatedAt: string | null;
}

export const StockBalanceSchema: z.ZodType<StockBalance, z.ZodTypeDef, unknown> = z.object({
  skuId: z.string().uuid(),
  skuCode: z.string(),
  skuName: z.string(),
  locationId: z.string().uuid().nullable(),
  locationName: z.string().nullable(),
  onHand: zQuantity,
  reserved: zQuantity,
  available: zQuantity,
  inTransit: zQuantity,
  weightedAverageCost: zUnitCost.optional(),
  totalValue: zMoney.optional(),
  sellingPrice: zMoney.nullable(),
  grossMargin: zMoney.nullable().optional(),
  grossMarginPercent: z.string().nullable().optional(),
  currency: z.string().length(3),
  valuationStatus: ValuationStatusSchema,
  zeroOrNegativeFlag: z.boolean(),
  updatedAt: z.string().nullable(),
});

const zBooleanQueryParam = z.preprocess((val) => {
  if (val === 'true' || val === true) return true;
  if (val === 'false' || val === false) return false;
  return val;
}, z.boolean());

export const ListStockBalancesQuerySchema = CursorPaginationQuerySchema.extend({
  locationId: z.string().uuid().optional(),
  skuId: z.string().uuid().optional(),
  zeroOrNegativeOnly: zBooleanQueryParam.optional(),
  view: StockBalanceViewSchema.default('per-location'),
});
export type ListStockBalancesQuery = z.infer<typeof ListStockBalancesQuerySchema>;

export const ListStockMovementsQuerySchema = CursorPaginationQuerySchema.extend({
  skuId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  type: StockMovementTypeSchema.optional(),
  referenceType: z.string().trim().min(1).max(100).optional(),
  referenceId: z.string().uuid().optional(),
});
export type ListStockMovementsQuery = z.infer<typeof ListStockMovementsQuerySchema>;

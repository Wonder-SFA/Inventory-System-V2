import { z } from 'zod';
import {
  type Money,
  type Quantity,
  type UnitCost,
  isNegative,
  isPositive,
  isZero,
  zMoney,
  zQuantity,
  zUnitCost,
} from '../decimal/index.js';
import { CursorPaginationQuerySchema } from '../http/index.js';

export * from './fefo.js';
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

export const zIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine((val) => {
    const d = new Date(`${val}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(val);
  }, 'Invalid calendar date');

export interface LotInput {
  lotCode: string;
  mfgDate?: string | null | undefined;
  expDate?: string | null | undefined;
}

export const LotInputSchema: z.ZodType<LotInput, z.ZodTypeDef, LotInput> = z.object({
  lotCode: z.string().trim().min(1, 'Lot code is required').max(100),
  mfgDate: zIsoDate.nullable().optional(),
  expDate: zIsoDate.nullable().optional(),
});

export interface StockLot {
  id: string;
  skuId: string;
  lotCode: string;
  mfgDate: string | null;
  expDate: string | null;
  createdAt: string;
}

export const StockLotSchema: z.ZodType<StockLot, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  skuId: z.string().uuid(),
  lotCode: z.string().min(1),
  mfgDate: zIsoDate.nullable(),
  expDate: zIsoDate.nullable(),
  createdAt: z.string(),
});

export interface StockLotBalance {
  lotId: string;
  skuId: string;
  lotCode: string;
  mfgDate: string | null;
  expDate: string | null;
  locationId: string;
  locationName?: string | undefined;
  onHand: Quantity;
  inTransit: Quantity;
  unitCost?: UnitCost | undefined;
  currency: string;
  updatedAt: string;
}

export const StockLotBalanceSchema: z.ZodType<StockLotBalance, z.ZodTypeDef, unknown> = z.object({
  lotId: z.string().uuid(),
  skuId: z.string().uuid(),
  lotCode: z.string().min(1),
  mfgDate: zIsoDate.nullable(),
  expDate: zIsoDate.nullable(),
  locationId: z.string().uuid(),
  locationName: z.string().optional(),
  onHand: zQuantity,
  inTransit: zQuantity,
  unitCost: zUnitCost.optional(),
  currency: z.string().length(3),
  updatedAt: z.string(),
});

export interface StockMovement {
  id: string;
  type: StockMovementType;
  skuId: string;
  skuCode?: string | undefined;
  skuName?: string | undefined;
  locationId: string;
  locationName?: string | undefined;
  lotId?: string | null | undefined;
  lotCode?: string | null | undefined;
  sliceIndex?: number | undefined;
  movementGroupId?: string | null | undefined;
  quantityDelta: Quantity;
  unitCost?: UnitCost | null | undefined;
  wacUnitCost?: UnitCost | null | undefined;
  currency: string;
  reasonCategory: string | null;
  note: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string;
  idempotencyKey: string;
  eodReconciliationRequired?: boolean | undefined;
  expiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
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
  lotId: z.string().uuid().nullable().optional(),
  lotCode: z.string().nullable().optional(),
  sliceIndex: z.number().int().min(0).optional(),
  movementGroupId: z.string().uuid().nullable().optional(),
  quantityDelta: zQuantity,
  unitCost: zUnitCost.nullable().optional(),
  wacUnitCost: zUnitCost.nullable().optional(),
  currency: z.string().length(3),
  reasonCategory: z.string().nullable(),
  note: z.string().nullable(),
  referenceType: z.string().nullable(),
  referenceId: z.string().uuid().nullable(),
  actorId: z.string(),
  idempotencyKey: z.string().uuid(),
  eodReconciliationRequired: z.boolean().optional(),
  expiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().nullable().optional(),
  createdAt: z.string(),
});

export interface LotAllocationInput {
  lotId: string;
  quantity: Quantity;
}

export interface LotAllocationRawInput {
  lotId: string;
  quantity: string;
}

export const LotAllocationInputSchema: z.ZodType<
  LotAllocationInput,
  z.ZodTypeDef,
  LotAllocationRawInput
> = z.object({
  lotId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Lot allocation quantity must be greater than zero',
  }),
});

export interface CreateStockIssueInput {
  skuId: string;
  locationId: string;
  quantity: Quantity;
  currency: string;
  note?: string | null | undefined;
  lotAllocations?: LotAllocationInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export interface CreateStockIssueRawInput {
  skuId: string;
  locationId: string;
  quantity: string;
  currency?: string | undefined;
  note?: string | null | undefined;
  lotAllocations?: LotAllocationRawInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export const CreateStockIssueInputSchema: z.ZodType<
  CreateStockIssueInput,
  z.ZodTypeDef,
  CreateStockIssueRawInput
> = z.object({
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Issue quantity must be greater than zero',
  }),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  note: z.string().trim().max(1000).nullable().optional(),
  lotAllocations: z.array(LotAllocationInputSchema).max(200).optional(),
  confirmExpiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
});

export interface CreateStockAdjustmentInput {
  skuId: string;
  locationId: string;
  lotId?: string | undefined;
  quantityDelta: Quantity;
  reasonCategory: AdjustmentReasonCategory;
  unitCost?: UnitCost | undefined;
  currency: string;
  note?: string | null | undefined;
}

export interface CreateStockAdjustmentRawInput {
  skuId: string;
  locationId: string;
  lotId?: string | undefined;
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
  lotId: z.string().uuid().optional(),
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

export const ListStockLotBalancesQuerySchema = z.object({
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
});
export type ListStockLotBalancesQuery = z.infer<typeof ListStockLotBalancesQuerySchema>;

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

export interface FefoPreviewQuery {
  skuId: string;
  locationId: string;
  quantity: Quantity;
  today?: string | undefined;
}

export interface FefoPreviewRawQuery {
  skuId: string;
  locationId: string;
  quantity: string;
  today?: string | undefined;
}

export const FefoPreviewQuerySchema: z.ZodType<
  FefoPreviewQuery,
  z.ZodTypeDef,
  FefoPreviewRawQuery
> = z.object({
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  quantity: zQuantity.refine((val) => !isZero(val) && !isNegative(val), {
    message: 'Preview quantity must be greater than zero',
  }),
  today: zIsoDate.optional(),
});

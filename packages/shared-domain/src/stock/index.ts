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
import {
  DEFAULT_EXPIRING_SOON_DAYS,
  type ExpiryStatus,
  ExpiryStatusFilterSchema,
  ExpiryStatusSchema,
} from './expiry.js';

export * from './expiry.js';
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

export const ValuationStatusSchema = z.enum(['NORMAL', 'ESTIMATED_NEGATIVE_STOCK']);
export type ValuationStatus = z.infer<typeof ValuationStatusSchema>;

export const StockBalanceViewSchema = z.enum(['per-location', 'company-wide']);
export type StockBalanceView = z.infer<typeof StockBalanceViewSchema>;

export const ValuationCostBasisSchema = z.enum(['FIFO', 'WAC']);
export type ValuationCostBasis = z.infer<typeof ValuationCostBasisSchema>;

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
  unlottedOnHand?: Quantity | undefined;
  costBasis?: ValuationCostBasis | undefined;
  unitCost?: UnitCost | undefined;
  weightedAverageCost?: UnitCost | undefined;
  totalValue?: Money | undefined;
  fifoValue?: Money | undefined;
  wacValue?: Money | undefined;
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
  unlottedOnHand: zQuantity.optional(),
  costBasis: ValuationCostBasisSchema.optional(),
  unitCost: zUnitCost.optional(),
  weightedAverageCost: zUnitCost.optional(),
  totalValue: zMoney.optional(),
  fifoValue: zMoney.optional(),
  wacValue: zMoney.optional(),
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
  costBasis: ValuationCostBasisSchema.default('FIFO'),
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

export const RecentReceiptCostsQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type RecentReceiptCostsQuery = z.infer<typeof RecentReceiptCostsQuerySchema>;

export interface RecentReceiptCostItem {
  movementId: string;
  referenceId: string | null;
  locationId: string;
  quantity: Quantity;
  recentUnitCost?: UnitCost | undefined;
  currency: string;
  createdAt: string;
}

export interface RecentReceiptCostsResult {
  skuId: string;
  locationId: string | null;
  suggestedUnitCost?: UnitCost | null | undefined;
  currency: string;
  recentReceipts: RecentReceiptCostItem[];
}

export interface AssignOpeningLotLineInput {
  lotCode: string;
  mfgDate?: string | null | undefined;
  expDate?: string | null | undefined;
  quantity: Quantity;
  unitCost?: UnitCost | undefined;
}

export interface AssignOpeningLotLineRawInput {
  lotCode: string;
  mfgDate?: string | null | undefined;
  expDate?: string | null | undefined;
  quantity: string;
  unitCost?: string | undefined;
}

export const AssignOpeningLotLineInputSchema: z.ZodType<
  AssignOpeningLotLineInput,
  z.ZodTypeDef,
  AssignOpeningLotLineRawInput
> = z.object({
  lotCode: z.string().trim().min(1).max(100),
  mfgDate: zIsoDate.nullable().optional(),
  expDate: zIsoDate.nullable().optional(),
  quantity: zQuantity.refine((val) => !isZero(val) && !isNegative(val), {
    message: 'Opening lot quantity must be greater than zero',
  }),
  unitCost: zUnitCost
    .refine((val) => !isNegative(val), {
      message: 'Unit cost cannot be negative',
    })
    .optional(),
});

export interface AssignOpeningLotsInput {
  skuId: string;
  locationId: string;
  currency?: string | undefined;
  note?: string | null | undefined;
  lots: AssignOpeningLotLineInput[];
}

export interface AssignOpeningLotsRawInput {
  skuId: string;
  locationId: string;
  currency?: string | undefined;
  note?: string | null | undefined;
  lots: AssignOpeningLotLineRawInput[];
}

export const AssignOpeningLotsInputSchema: z.ZodType<
  AssignOpeningLotsInput,
  z.ZodTypeDef,
  AssignOpeningLotsRawInput
> = z.object({
  skuId: z.string().uuid(),
  locationId: z.string().uuid(),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  note: z.string().trim().max(1000).nullable().optional(),
  lots: z.array(AssignOpeningLotLineInputSchema).min(1).max(100),
});

export const ListStockLotsQuerySchema = CursorPaginationQuerySchema.extend({
  locationId: z.string().uuid().optional(),
  skuId: z.string().uuid().optional(),
  expiryStatus: ExpiryStatusFilterSchema.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).default(DEFAULT_EXPIRING_SOON_DAYS),
  today: zIsoDate.optional(),
});
export type ListStockLotsQuery = z.infer<typeof ListStockLotsQuerySchema>;

export interface StockLotView {
  id: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  lotCode: string;
  mfgDate: string | null;
  expDate: string | null;
  expiryStatus: ExpiryStatus;
  totalOnHand: Quantity;
  totalInTransit: Quantity;
  createdAt: string;
}

export const StockLotViewSchema: z.ZodType<StockLotView, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  skuId: z.string().uuid(),
  skuCode: z.string(),
  skuName: z.string(),
  lotCode: z.string().min(1),
  mfgDate: zIsoDate.nullable(),
  expDate: zIsoDate.nullable(),
  expiryStatus: ExpiryStatusSchema,
  totalOnHand: zQuantity,
  totalInTransit: zQuantity,
  createdAt: z.string(),
});

export const ListLotBalancesQuerySchema = CursorPaginationQuerySchema.extend({
  locationId: z.string().uuid().optional(),
  skuId: z.string().uuid().optional(),
  expiryStatus: ExpiryStatusFilterSchema.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).default(DEFAULT_EXPIRING_SOON_DAYS),
  today: zIsoDate.optional(),
});
export type ListLotBalancesQuery = z.infer<typeof ListLotBalancesQuerySchema>;

export interface LotBalanceItem {
  lotId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  lotCode: string;
  mfgDate: string | null;
  expDate: string | null;
  expiryStatus: ExpiryStatus;
  locationId: string;
  locationName: string;
  onHand: Quantity;
  inTransit: Quantity;
  unitCost?: UnitCost | undefined;
  wacUnitCost?: UnitCost | undefined;
  totalValue?: Money | undefined;
  fifoValue?: Money | undefined;
  wacValue?: Money | undefined;
  currency: string;
  updatedAt: string;
}

export const LotBalanceItemSchema: z.ZodType<LotBalanceItem, z.ZodTypeDef, unknown> = z.object({
  lotId: z.string().uuid(),
  skuId: z.string().uuid(),
  skuCode: z.string(),
  skuName: z.string(),
  lotCode: z.string().min(1),
  mfgDate: zIsoDate.nullable(),
  expDate: zIsoDate.nullable(),
  expiryStatus: ExpiryStatusSchema,
  locationId: z.string().uuid(),
  locationName: z.string(),
  onHand: zQuantity,
  inTransit: zQuantity,
  unitCost: zUnitCost.optional(),
  wacUnitCost: zUnitCost.optional(),
  totalValue: zMoney.optional(),
  fifoValue: zMoney.optional(),
  wacValue: zMoney.optional(),
  currency: z.string().length(3),
  updatedAt: z.string(),
});

export const ValuationSummaryQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
  skuId: z.string().uuid().optional(),
  costBasis: ValuationCostBasisSchema.default('FIFO'),
});
export type ValuationSummaryQuery = z.infer<typeof ValuationSummaryQuerySchema>;

export interface ValuationSummary {
  costBasis: ValuationCostBasis;
  currency: string;
  skuCount: number;
  locationCount: number;
  rowCount: number;
  totalOnHand: Quantity;
  totalValue?: Money | undefined;
  totalFifoValue?: Money | undefined;
  totalWacValue?: Money | undefined;
  estimatedNegativeCount: number;
}

export const ValuationSummarySchema: z.ZodType<ValuationSummary, z.ZodTypeDef, unknown> = z.object({
  costBasis: ValuationCostBasisSchema,
  currency: z.string().length(3),
  skuCount: z.number().int().min(0),
  locationCount: z.number().int().min(0),
  rowCount: z.number().int().min(0),
  totalOnHand: zQuantity,
  totalValue: zMoney.optional(),
  totalFifoValue: zMoney.optional(),
  totalWacValue: zMoney.optional(),
  estimatedNegativeCount: z.number().int().min(0),
});

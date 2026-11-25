import { z } from 'zod';
import {
  type Money,
  type Quantity,
  type UnitCost,
  isNegative,
  isPositive,
  zMoney,
  zQuantity,
  zUnitCost,
} from '../decimal/index.js';
import { CursorPaginationQuerySchema } from '../http/index.js';
import {
  type LotAllocationInput,
  LotAllocationInputSchema,
  type LotAllocationRawInput,
  StockMovementSchema,
  zIsoDate,
} from '../stock/index.js';

export const SupplierStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type SupplierStatus = z.infer<typeof SupplierStatusSchema>;

export const SupplierSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  status: SupplierStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

export const CreateSupplierInputSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(200),
  email: z.string().trim().email('Invalid email address').max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
});
export type CreateSupplierInput = z.infer<typeof CreateSupplierInputSchema>;

export const UpdateSupplierInputSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(200).optional(),
  email: z.string().trim().email('Invalid email address').max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
});
export type UpdateSupplierInput = z.infer<typeof UpdateSupplierInputSchema>;

export const ListSuppliersQuerySchema = CursorPaginationQuerySchema.extend({
  status: SupplierStatusSchema.optional(),
});
export type ListSuppliersQuery = z.infer<typeof ListSuppliersQuerySchema>;

export const PurchaseOrderStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

export interface PurchaseOrderLine {
  id: string;
  purchaseOrderId: string;
  skuId: string;
  skuCode?: string | undefined;
  skuName?: string | undefined;
  orderedQty: Quantity;
  fulfilledQty: Quantity;
  unitCost?: UnitCost | undefined;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export const PurchaseOrderLineSchema: z.ZodType<PurchaseOrderLine, z.ZodTypeDef, unknown> =
  z.object({
    id: z.string().uuid(),
    purchaseOrderId: z.string().uuid(),
    skuId: z.string().uuid(),
    skuCode: z.string().optional(),
    skuName: z.string().optional(),
    orderedQty: zQuantity,
    fulfilledQty: zQuantity,
    unitCost: zUnitCost.optional(),
    currency: z.string().length(3),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export interface PurchaseOrder {
  id: string;
  orderNumber: string;
  supplierId: string;
  supplierName?: string | undefined;
  locationId: string;
  locationName?: string | undefined;
  status: PurchaseOrderStatus;
  version: number;
  note: string | null;
  lines: PurchaseOrderLine[];
  createdAt: string;
  updatedAt: string;
}

export const PurchaseOrderSchema: z.ZodType<PurchaseOrder, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  orderNumber: z.string().min(1),
  supplierId: z.string().uuid(),
  supplierName: z.string().optional(),
  locationId: z.string().uuid(),
  locationName: z.string().optional(),
  status: PurchaseOrderStatusSchema,
  version: z.number().int().min(1),
  note: z.string().nullable(),
  lines: z.array(PurchaseOrderLineSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface PurchaseOrderLineInput {
  skuId: string;
  orderedQty: Quantity;
  unitCost: UnitCost;
  currency: string;
}

export interface PurchaseOrderLineRawInput {
  skuId: string;
  orderedQty: string;
  unitCost: string;
  currency?: string | undefined;
}

export const PurchaseOrderLineInputSchema: z.ZodType<
  PurchaseOrderLineInput,
  z.ZodTypeDef,
  PurchaseOrderLineRawInput
> = z.object({
  skuId: z.string().uuid(),
  orderedQty: zQuantity.refine((val) => isPositive(val), {
    message: 'Ordered quantity must be greater than zero',
  }),
  unitCost: zUnitCost.refine((val) => !isNegative(val), {
    message: 'Unit cost cannot be negative',
  }),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
});

export interface CreatePurchaseOrderInput {
  orderNumber?: string | undefined;
  supplierId: string;
  locationId: string;
  note?: string | null | undefined;
  lines: PurchaseOrderLineInput[];
}

export interface CreatePurchaseOrderRawInput {
  orderNumber?: string | undefined;
  supplierId: string;
  locationId: string;
  note?: string | null | undefined;
  lines: PurchaseOrderLineRawInput[];
}

export const CreatePurchaseOrderInputSchema: z.ZodType<
  CreatePurchaseOrderInput,
  z.ZodTypeDef,
  CreatePurchaseOrderRawInput
> = z.object({
  orderNumber: z.string().trim().min(1).max(64).optional(),
  supplierId: z.string().uuid(),
  locationId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(PurchaseOrderLineInputSchema).min(1).max(500),
});

export interface UpdatePurchaseOrderInput {
  expectedVersion: number;
  supplierId?: string | undefined;
  locationId?: string | undefined;
  note?: string | null | undefined;
  lines?: PurchaseOrderLineInput[] | undefined;
}

export interface UpdatePurchaseOrderRawInput {
  expectedVersion: number;
  supplierId?: string | undefined;
  locationId?: string | undefined;
  note?: string | null | undefined;
  lines?: PurchaseOrderLineRawInput[] | undefined;
}

export const UpdatePurchaseOrderInputSchema: z.ZodType<
  UpdatePurchaseOrderInput,
  z.ZodTypeDef,
  UpdatePurchaseOrderRawInput
> = z.object({
  expectedVersion: z.number().int().min(1),
  supplierId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(PurchaseOrderLineInputSchema).min(1).max(500).optional(),
});

export const ListPurchaseOrdersQuerySchema = CursorPaginationQuerySchema.extend({
  status: PurchaseOrderStatusSchema.optional(),
  locationId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
});
export type ListPurchaseOrdersQuery = z.infer<typeof ListPurchaseOrdersQuerySchema>;

export interface ReceivePurchaseOrderLineInput {
  orderLineId: string;
  quantity: Quantity;
  unitCost?: UnitCost | undefined;
  currency?: string | undefined;
  lotCode?: string | undefined;
  mfgDate?: string | null | undefined;
  expDate?: string | null | undefined;
}

export interface ReceivePurchaseOrderLineRawInput {
  orderLineId: string;
  quantity: string;
  unitCost?: string | undefined;
  currency?: string | undefined;
  lotCode?: string | undefined;
  mfgDate?: string | null | undefined;
  expDate?: string | null | undefined;
}

export const ReceivePurchaseOrderLineInputSchema: z.ZodType<
  ReceivePurchaseOrderLineInput,
  z.ZodTypeDef,
  ReceivePurchaseOrderLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Receive quantity must be greater than zero',
  }),
  unitCost: zUnitCost
    .refine((val) => !isNegative(val), {
      message: 'Unit cost cannot be negative',
    })
    .optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  lotCode: z.string().trim().min(1, 'Lot code cannot be empty').max(100).optional(),
  mfgDate: zIsoDate.nullable().optional(),
  expDate: zIsoDate.nullable().optional(),
});

export interface ReceivePurchaseOrderInput {
  allowOverReceive: boolean;
  note?: string | null | undefined;
  lines: ReceivePurchaseOrderLineInput[];
}

export interface ReceivePurchaseOrderRawInput {
  allowOverReceive?: boolean | undefined;
  note?: string | null | undefined;
  lines: ReceivePurchaseOrderLineRawInput[];
}

export const ReceivePurchaseOrderInputSchema: z.ZodType<
  ReceivePurchaseOrderInput,
  z.ZodTypeDef,
  ReceivePurchaseOrderRawInput
> = z.object({
  allowOverReceive: z.boolean().default(false),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(ReceivePurchaseOrderLineInputSchema).min(1).max(500),
});

export const ReceivePurchaseOrderResultSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  status: PurchaseOrderStatusSchema,
  movements: z.array(StockMovementSchema),
});
export type ReceivePurchaseOrderResult = z.infer<typeof ReceivePurchaseOrderResultSchema>;

export const CustomerStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type CustomerStatus = z.infer<typeof CustomerStatusSchema>;

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  status: CustomerStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CreateCustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(200),
  email: z.string().trim().email('Invalid email address').max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>;

export const UpdateCustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'Customer name is required').max(200).optional(),
  email: z.string().trim().email('Invalid email address').max(200).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
});
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInputSchema>;

export const ListCustomersQuerySchema = CursorPaginationQuerySchema.extend({
  status: CustomerStatusSchema.optional(),
});
export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;

export const SalesOrderStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
]);
export type SalesOrderStatus = z.infer<typeof SalesOrderStatusSchema>;

export interface SalesOrderLine {
  id: string;
  salesOrderId: string;
  skuId: string;
  skuCode?: string | undefined;
  skuName?: string | undefined;
  orderedQty: Quantity;
  fulfilledQty: Quantity;
  returnedQty: Quantity;
  unitPrice: Money;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export const SalesOrderLineSchema: z.ZodType<SalesOrderLine, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  salesOrderId: z.string().uuid(),
  skuId: z.string().uuid(),
  skuCode: z.string().optional(),
  skuName: z.string().optional(),
  orderedQty: zQuantity,
  fulfilledQty: zQuantity,
  returnedQty: zQuantity,
  unitPrice: zMoney,
  currency: z.string().length(3),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface SalesOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName?: string | undefined;
  locationId: string;
  locationName?: string | undefined;
  status: SalesOrderStatus;
  version: number;
  note: string | null;
  lines: SalesOrderLine[];
  createdAt: string;
  updatedAt: string;
}

export const SalesOrderSchema: z.ZodType<SalesOrder, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  orderNumber: z.string().min(1),
  customerId: z.string().uuid(),
  customerName: z.string().optional(),
  locationId: z.string().uuid(),
  locationName: z.string().optional(),
  status: SalesOrderStatusSchema,
  version: z.number().int().min(1),
  note: z.string().nullable(),
  lines: z.array(SalesOrderLineSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface SalesOrderLineInput {
  skuId: string;
  orderedQty: Quantity;
  unitPrice: Money;
  currency: string;
}

export interface SalesOrderLineRawInput {
  skuId: string;
  orderedQty: string;
  unitPrice: string;
  currency?: string | undefined;
}

export const SalesOrderLineInputSchema: z.ZodType<
  SalesOrderLineInput,
  z.ZodTypeDef,
  SalesOrderLineRawInput
> = z.object({
  skuId: z.string().uuid(),
  orderedQty: zQuantity.refine((val) => isPositive(val), {
    message: 'Ordered quantity must be greater than zero',
  }),
  unitPrice: zMoney.refine((val) => !isNegative(val), {
    message: 'Unit price cannot be negative',
  }),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
});

export interface CreateSalesOrderInput {
  orderNumber?: string | undefined;
  customerId: string;
  locationId: string;
  note?: string | null | undefined;
  lines: SalesOrderLineInput[];
}

export interface CreateSalesOrderRawInput {
  orderNumber?: string | undefined;
  customerId: string;
  locationId: string;
  note?: string | null | undefined;
  lines: SalesOrderLineRawInput[];
}

export const CreateSalesOrderInputSchema: z.ZodType<
  CreateSalesOrderInput,
  z.ZodTypeDef,
  CreateSalesOrderRawInput
> = z.object({
  orderNumber: z.string().trim().min(1).max(64).optional(),
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(SalesOrderLineInputSchema).min(1).max(500),
});

export interface UpdateSalesOrderInput {
  expectedVersion: number;
  customerId?: string | undefined;
  locationId?: string | undefined;
  note?: string | null | undefined;
  lines?: SalesOrderLineInput[] | undefined;
}

export interface UpdateSalesOrderRawInput {
  expectedVersion: number;
  customerId?: string | undefined;
  locationId?: string | undefined;
  note?: string | null | undefined;
  lines?: SalesOrderLineRawInput[] | undefined;
}

export const UpdateSalesOrderInputSchema: z.ZodType<
  UpdateSalesOrderInput,
  z.ZodTypeDef,
  UpdateSalesOrderRawInput
> = z.object({
  expectedVersion: z.number().int().min(1),
  customerId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(SalesOrderLineInputSchema).min(1).max(500).optional(),
});

export const ListSalesOrdersQuerySchema = CursorPaginationQuerySchema.extend({
  status: SalesOrderStatusSchema.optional(),
  locationId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
});
export type ListSalesOrdersQuery = z.infer<typeof ListSalesOrdersQuerySchema>;

export interface ShipSalesOrderLineInput {
  orderLineId: string;
  quantity: Quantity;
  lotAllocations?: LotAllocationInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export interface ShipSalesOrderLineRawInput {
  orderLineId: string;
  quantity: string;
  lotAllocations?: LotAllocationRawInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export const ShipSalesOrderLineInputSchema: z.ZodType<
  ShipSalesOrderLineInput,
  z.ZodTypeDef,
  ShipSalesOrderLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Ship quantity must be greater than zero',
  }),
  lotAllocations: z.array(LotAllocationInputSchema).max(200).optional(),
  confirmExpiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
});

export interface ShipSalesOrderInput {
  note?: string | null | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
  lines: ShipSalesOrderLineInput[];
}

export interface ShipSalesOrderRawInput {
  note?: string | null | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
  lines: ShipSalesOrderLineRawInput[];
}

export const ShipSalesOrderInputSchema: z.ZodType<
  ShipSalesOrderInput,
  z.ZodTypeDef,
  ShipSalesOrderRawInput
> = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
  confirmExpiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
  lines: z.array(ShipSalesOrderLineInputSchema).min(1).max(500),
});

export const ShipSalesOrderResultSchema = z.object({
  salesOrderId: z.string().uuid(),
  status: SalesOrderStatusSchema,
  movements: z.array(StockMovementSchema),
});
export type ShipSalesOrderResult = z.infer<typeof ShipSalesOrderResultSchema>;

export interface ReturnSalesOrderLineInput {
  orderLineId: string;
  quantity: Quantity;
}

export interface ReturnSalesOrderLineRawInput {
  orderLineId: string;
  quantity: string;
}

export const ReturnSalesOrderLineInputSchema: z.ZodType<
  ReturnSalesOrderLineInput,
  z.ZodTypeDef,
  ReturnSalesOrderLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Return quantity must be greater than zero',
  }),
});

export interface ReturnSalesOrderInput {
  note?: string | null | undefined;
  lines: ReturnSalesOrderLineInput[];
}

export interface ReturnSalesOrderRawInput {
  note?: string | null | undefined;
  lines: ReturnSalesOrderLineRawInput[];
}

export const ReturnSalesOrderInputSchema: z.ZodType<
  ReturnSalesOrderInput,
  z.ZodTypeDef,
  ReturnSalesOrderRawInput
> = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(ReturnSalesOrderLineInputSchema).min(1).max(500),
});

export const ReturnSalesOrderResultSchema = z.object({
  salesOrderId: z.string().uuid(),
  status: SalesOrderStatusSchema,
  movements: z.array(StockMovementSchema),
});
export type ReturnSalesOrderResult = z.infer<typeof ReturnSalesOrderResultSchema>;

export const TransferOrderStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'IN_TRANSIT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED_WITH_DISCREPANCY',
  'CANCELLED',
]);
export type TransferOrderStatus = z.infer<typeof TransferOrderStatusSchema>;

export const DiscrepancyReasonSchema = z.enum(['LOST', 'DAMAGED', 'OTHER']);
export type DiscrepancyReason = z.infer<typeof DiscrepancyReasonSchema>;

export interface TransferOrderLineLot {
  id: string;
  transferOrderLineId: string;
  lotId: string | null;
  lotCode?: string | null | undefined;
  dispatchedQty: Quantity;
  receivedQty: Quantity;
  discrepancyQty: Quantity;
  dispatchUnitCost?: UnitCost | undefined;
  dispatchWacUnitCost?: UnitCost | undefined;
  currency: string;
  expDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TransferOrderLineLotSchema: z.ZodType<TransferOrderLineLot, z.ZodTypeDef, unknown> =
  z.object({
    id: z.string().uuid(),
    transferOrderLineId: z.string().uuid(),
    lotId: z.string().uuid().nullable(),
    lotCode: z.string().nullable().optional(),
    dispatchedQty: zQuantity,
    receivedQty: zQuantity,
    discrepancyQty: zQuantity,
    dispatchUnitCost: zUnitCost.optional(),
    dispatchWacUnitCost: zUnitCost.optional(),
    currency: z.string().length(3),
    expDate: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export interface TransferOrderLine {
  id: string;
  transferOrderId: string;
  skuId: string;
  skuCode?: string | undefined;
  skuName?: string | undefined;
  orderedQty: Quantity;
  dispatchedQty: Quantity;
  receivedQty: Quantity;
  dispatchUnitCost?: UnitCost | null | undefined;
  currency: string;
  lots?: TransferOrderLineLot[] | undefined;
  createdAt: string;
  updatedAt: string;
}

export const TransferOrderLineSchema: z.ZodType<TransferOrderLine, z.ZodTypeDef, unknown> =
  z.object({
    id: z.string().uuid(),
    transferOrderId: z.string().uuid(),
    skuId: z.string().uuid(),
    skuCode: z.string().optional(),
    skuName: z.string().optional(),
    orderedQty: zQuantity,
    dispatchedQty: zQuantity,
    receivedQty: zQuantity,
    dispatchUnitCost: zUnitCost.nullable().optional(),
    currency: z.string().length(3),
    lots: z.array(TransferOrderLineLotSchema).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

export interface TransferOrder {
  id: string;
  orderNumber: string;
  sourceLocationId: string;
  sourceLocationName?: string | undefined;
  destinationLocationId: string;
  destinationLocationName?: string | undefined;
  status: TransferOrderStatus;
  version: number;
  note: string | null;
  discrepancyReason: DiscrepancyReason | null;
  discrepancyNote: string | null;
  lines: TransferOrderLine[];
  createdAt: string;
  updatedAt: string;
}

export const TransferOrderSchema: z.ZodType<TransferOrder, z.ZodTypeDef, unknown> = z.object({
  id: z.string().uuid(),
  orderNumber: z.string().min(1),
  sourceLocationId: z.string().uuid(),
  sourceLocationName: z.string().optional(),
  destinationLocationId: z.string().uuid(),
  destinationLocationName: z.string().optional(),
  status: TransferOrderStatusSchema,
  version: z.number().int().min(1),
  note: z.string().nullable(),
  discrepancyReason: DiscrepancyReasonSchema.nullable(),
  discrepancyNote: z.string().nullable(),
  lines: z.array(TransferOrderLineSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface TransferOrderLineInput {
  skuId: string;
  orderedQty: Quantity;
}

export interface TransferOrderLineRawInput {
  skuId: string;
  orderedQty: string;
}

export const TransferOrderLineInputSchema: z.ZodType<
  TransferOrderLineInput,
  z.ZodTypeDef,
  TransferOrderLineRawInput
> = z.object({
  skuId: z.string().uuid(),
  orderedQty: zQuantity.refine((val) => isPositive(val), {
    message: 'Ordered quantity must be greater than zero',
  }),
});

export interface CreateTransferOrderInput {
  orderNumber?: string | undefined;
  sourceLocationId: string;
  destinationLocationId: string;
  note?: string | null | undefined;
  lines: TransferOrderLineInput[];
}

export interface CreateTransferOrderRawInput {
  orderNumber?: string | undefined;
  sourceLocationId: string;
  destinationLocationId: string;
  note?: string | null | undefined;
  lines: TransferOrderLineRawInput[];
}

export const CreateTransferOrderInputSchema: z.ZodType<
  CreateTransferOrderInput,
  z.ZodTypeDef,
  CreateTransferOrderRawInput
> = z.object({
  orderNumber: z.string().trim().min(1).max(64).optional(),
  sourceLocationId: z.string().uuid(),
  destinationLocationId: z.string().uuid(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(TransferOrderLineInputSchema).min(1).max(500),
});

export interface UpdateTransferOrderInput {
  expectedVersion: number;
  sourceLocationId?: string | undefined;
  destinationLocationId?: string | undefined;
  note?: string | null | undefined;
  lines?: TransferOrderLineInput[] | undefined;
}

export interface UpdateTransferOrderRawInput {
  expectedVersion: number;
  sourceLocationId?: string | undefined;
  destinationLocationId?: string | undefined;
  note?: string | null | undefined;
  lines?: TransferOrderLineRawInput[] | undefined;
}

export const UpdateTransferOrderInputSchema: z.ZodType<
  UpdateTransferOrderInput,
  z.ZodTypeDef,
  UpdateTransferOrderRawInput
> = z.object({
  expectedVersion: z.number().int().min(1),
  sourceLocationId: z.string().uuid().optional(),
  destinationLocationId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(TransferOrderLineInputSchema).min(1).max(500).optional(),
});

export const ListTransferOrdersQuerySchema = CursorPaginationQuerySchema.extend({
  status: TransferOrderStatusSchema.optional(),
  sourceLocationId: z.string().uuid().optional(),
  destinationLocationId: z.string().uuid().optional(),
});
export type ListTransferOrdersQuery = z.infer<typeof ListTransferOrdersQuerySchema>;

export interface NullableLotAllocationInput {
  lotId: string | null;
  quantity: Quantity;
}

export interface NullableLotAllocationRawInput {
  lotId: string | null;
  quantity: string;
}

export const NullableLotAllocationInputSchema: z.ZodType<
  NullableLotAllocationInput,
  z.ZodTypeDef,
  NullableLotAllocationRawInput
> = z.object({
  lotId: z.string().uuid().nullable(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Lot allocation quantity must be greater than zero',
  }),
});

export interface DispatchTransferOrderLineInput {
  orderLineId: string;
  lotAllocations?: LotAllocationInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export interface DispatchTransferOrderLineRawInput {
  orderLineId: string;
  lotAllocations?: LotAllocationRawInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export const DispatchTransferOrderLineInputSchema: z.ZodType<
  DispatchTransferOrderLineInput,
  z.ZodTypeDef,
  DispatchTransferOrderLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  lotAllocations: z.array(LotAllocationInputSchema).max(200).optional(),
  confirmExpiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
});

export interface DispatchTransferOrderInput {
  note?: string | null | undefined;
  lines?: DispatchTransferOrderLineInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export interface DispatchTransferOrderRawInput {
  note?: string | null | undefined;
  lines?: DispatchTransferOrderLineRawInput[] | undefined;
  confirmExpiredLotOverride?: boolean | undefined;
  overrideReason?: string | null | undefined;
}

export const DispatchTransferOrderInputSchema: z.ZodType<
  DispatchTransferOrderInput,
  z.ZodTypeDef,
  DispatchTransferOrderRawInput
> = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(DispatchTransferOrderLineInputSchema).max(500).optional(),
  confirmExpiredLotOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).nullable().optional(),
});

export interface ReceiveTransferOrderLineInput {
  orderLineId: string;
  quantity: Quantity;
  lotAllocations?: NullableLotAllocationInput[] | undefined;
}

export interface ReceiveTransferOrderLineRawInput {
  orderLineId: string;
  quantity: string;
  lotAllocations?: NullableLotAllocationRawInput[] | undefined;
}

export const ReceiveTransferOrderLineInputSchema: z.ZodType<
  ReceiveTransferOrderLineInput,
  z.ZodTypeDef,
  ReceiveTransferOrderLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  quantity: zQuantity.refine((val) => isPositive(val), {
    message: 'Receive quantity must be greater than zero',
  }),
  lotAllocations: z.array(NullableLotAllocationInputSchema).max(200).optional(),
});

export interface ReceiveTransferOrderInput {
  note?: string | null | undefined;
  lines: ReceiveTransferOrderLineInput[];
}

export interface ReceiveTransferOrderRawInput {
  note?: string | null | undefined;
  lines: ReceiveTransferOrderLineRawInput[];
}

export const ReceiveTransferOrderInputSchema: z.ZodType<
  ReceiveTransferOrderInput,
  z.ZodTypeDef,
  ReceiveTransferOrderRawInput
> = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
  lines: z.array(ReceiveTransferOrderLineInputSchema).min(1).max(500),
});

export const ReceiveTransferOrderResultSchema = z.object({
  transferOrderId: z.string().uuid(),
  status: TransferOrderStatusSchema,
  movements: z.array(StockMovementSchema),
});
export type ReceiveTransferOrderResult = z.infer<typeof ReceiveTransferOrderResultSchema>;

export interface CloseTransferDiscrepancyLineInput {
  orderLineId: string;
  lotAllocations?: NullableLotAllocationInput[] | undefined;
}

export interface CloseTransferDiscrepancyLineRawInput {
  orderLineId: string;
  lotAllocations?: NullableLotAllocationRawInput[] | undefined;
}

export const CloseTransferDiscrepancyLineInputSchema: z.ZodType<
  CloseTransferDiscrepancyLineInput,
  z.ZodTypeDef,
  CloseTransferDiscrepancyLineRawInput
> = z.object({
  orderLineId: z.string().uuid(),
  lotAllocations: z.array(NullableLotAllocationInputSchema).max(200).optional(),
});

export interface CloseTransferDiscrepancyInput {
  reason: DiscrepancyReason;
  note: string;
  lines?: CloseTransferDiscrepancyLineInput[] | undefined;
}

export interface CloseTransferDiscrepancyRawInput {
  reason: DiscrepancyReason;
  note: string;
  lines?: CloseTransferDiscrepancyLineRawInput[] | undefined;
}

export const CloseTransferDiscrepancyInputSchema: z.ZodType<
  CloseTransferDiscrepancyInput,
  z.ZodTypeDef,
  CloseTransferDiscrepancyRawInput
> = z.object({
  reason: DiscrepancyReasonSchema,
  note: z.string().trim().min(1, 'Discrepancy note is required').max(1000),
  lines: z.array(CloseTransferDiscrepancyLineInputSchema).max(500).optional(),
});

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
import { StockMovementSchema } from '../stock/index.js';

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
}

export interface ReceivePurchaseOrderLineRawInput {
  orderLineId: string;
  quantity: string;
  unitCost?: string | undefined;
  currency?: string | undefined;
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
}

export interface ShipSalesOrderLineRawInput {
  orderLineId: string;
  quantity: string;
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
});

export interface ShipSalesOrderInput {
  note?: string | null | undefined;
  lines: ShipSalesOrderLineInput[];
}

export interface ShipSalesOrderRawInput {
  note?: string | null | undefined;
  lines: ShipSalesOrderLineRawInput[];
}

export const ShipSalesOrderInputSchema: z.ZodType<
  ShipSalesOrderInput,
  z.ZodTypeDef,
  ShipSalesOrderRawInput
> = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
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

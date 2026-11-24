import { ordersSchema } from '@iv2/db';
import type {
  CustomerStatus,
  DiscrepancyReason,
  PurchaseOrderStatus,
  SalesOrderStatus,
  SupplierStatus,
  TransferOrderStatus,
} from '@iv2/shared-domain';
import { char, date, index, integer, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const suppliers = ordersSchema.table(
  'suppliers',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    status: text('status').$type<SupplierStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('orders_suppliers_created_id_idx').on(table.createdAt, table.id)],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplierRow = typeof suppliers.$inferInsert;

export const purchaseOrders = ordersSchema.table(
  'purchase_orders',
  {
    id: uuid('id').primaryKey(),
    orderNumber: text('order_number').notNull().unique(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    status: text('status').$type<PurchaseOrderStatus>().notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_purchase_orders_status_created_idx').on(table.status, table.createdAt),
    index('orders_purchase_orders_location_status_idx').on(table.locationId, table.status),
    index('orders_purchase_orders_created_id_idx').on(table.createdAt, table.id),
  ],
);

export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrderRow = typeof purchaseOrders.$inferInsert;

export const purchaseOrderLines = ordersSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id').notNull(),
    orderedQty: numeric('ordered_qty', { precision: 18, scale: 4 }).notNull(),
    fulfilledQty: numeric('fulfilled_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_purchase_order_lines_po_idx').on(table.purchaseOrderId),
    index('orders_purchase_order_lines_sku_idx').on(table.skuId),
  ],
);

export type PurchaseOrderLineRow = typeof purchaseOrderLines.$inferSelect;
export type NewPurchaseOrderLineRow = typeof purchaseOrderLines.$inferInsert;

export const customers = ordersSchema.table(
  'customers',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    status: text('status').$type<CustomerStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('orders_customers_created_id_idx').on(table.createdAt, table.id)],
);

export type CustomerRow = typeof customers.$inferSelect;
export type NewCustomerRow = typeof customers.$inferInsert;

export const salesOrders = ordersSchema.table(
  'sales_orders',
  {
    id: uuid('id').primaryKey(),
    orderNumber: text('order_number').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull(),
    status: text('status').$type<SalesOrderStatus>().notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_sales_orders_status_created_idx').on(table.status, table.createdAt),
    index('orders_sales_orders_location_status_idx').on(table.locationId, table.status),
    index('orders_sales_orders_created_id_idx').on(table.createdAt, table.id),
  ],
);

export type SalesOrderRow = typeof salesOrders.$inferSelect;
export type NewSalesOrderRow = typeof salesOrders.$inferInsert;

export const salesOrderLines = ordersSchema.table(
  'sales_order_lines',
  {
    id: uuid('id').primaryKey(),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id').notNull(),
    orderedQty: numeric('ordered_qty', { precision: 18, scale: 4 }).notNull(),
    fulfilledQty: numeric('fulfilled_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    returnedQty: numeric('returned_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_sales_order_lines_so_idx').on(table.salesOrderId),
    index('orders_sales_order_lines_sku_idx').on(table.skuId),
  ],
);

export type SalesOrderLineRow = typeof salesOrderLines.$inferSelect;
export type NewSalesOrderLineRow = typeof salesOrderLines.$inferInsert;

export const transferOrders = ordersSchema.table(
  'transfer_orders',
  {
    id: uuid('id').primaryKey(),
    orderNumber: text('order_number').notNull().unique(),
    sourceLocationId: uuid('source_location_id').notNull(),
    destinationLocationId: uuid('destination_location_id').notNull(),
    status: text('status').$type<TransferOrderStatus>().notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    note: text('note'),
    discrepancyReason: text('discrepancy_reason').$type<DiscrepancyReason>(),
    discrepancyNote: text('discrepancy_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_transfer_orders_status_created_idx').on(table.status, table.createdAt),
    index('orders_transfer_orders_source_status_idx').on(table.sourceLocationId, table.status),
    index('orders_transfer_orders_dest_status_idx').on(table.destinationLocationId, table.status),
    index('orders_transfer_orders_created_id_idx').on(table.createdAt, table.id),
  ],
);

export type TransferOrderRow = typeof transferOrders.$inferSelect;
export type NewTransferOrderRow = typeof transferOrders.$inferInsert;

export const transferOrderLines = ordersSchema.table(
  'transfer_order_lines',
  {
    id: uuid('id').primaryKey(),
    transferOrderId: uuid('transfer_order_id')
      .notNull()
      .references(() => transferOrders.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id').notNull(),
    orderedQty: numeric('ordered_qty', { precision: 18, scale: 4 }).notNull(),
    dispatchedQty: numeric('dispatched_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    receivedQty: numeric('received_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    dispatchUnitCost: numeric('dispatch_unit_cost', { precision: 18, scale: 4 }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_transfer_order_lines_to_idx').on(table.transferOrderId),
    index('orders_transfer_order_lines_sku_idx').on(table.skuId),
  ],
);

export type TransferOrderLineRow = typeof transferOrderLines.$inferSelect;
export type NewTransferOrderLineRow = typeof transferOrderLines.$inferInsert;

export const transferOrderLineLots = ordersSchema.table(
  'transfer_order_line_lots',
  {
    id: uuid('id').primaryKey(),
    transferOrderLineId: uuid('transfer_order_line_id')
      .notNull()
      .references(() => transferOrderLines.id, { onDelete: 'cascade' }),
    lotId: uuid('lot_id'),
    dispatchedQty: numeric('dispatched_qty', { precision: 18, scale: 4 }).notNull(),
    receivedQty: numeric('received_qty', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    discrepancyQty: numeric('discrepancy_qty', { precision: 18, scale: 4 })
      .notNull()
      .default('0.0000'),
    dispatchUnitCost: numeric('dispatch_unit_cost', { precision: 18, scale: 4 }).notNull(),
    dispatchWacUnitCost: numeric('dispatch_wac_unit_cost', { precision: 18, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    expDate: date('exp_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('orders_transfer_order_line_lots_line_idx').on(table.transferOrderLineId),
    index('orders_transfer_order_line_lots_lot_idx').on(table.lotId),
  ],
);

export type TransferOrderLineLotRow = typeof transferOrderLineLots.$inferSelect;
export type NewTransferOrderLineLotRow = typeof transferOrderLineLots.$inferInsert;

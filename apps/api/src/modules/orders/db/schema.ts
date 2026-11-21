import { ordersSchema } from '@iv2/db';
import type { PurchaseOrderStatus, SupplierStatus } from '@iv2/shared-domain';
import { char, index, integer, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

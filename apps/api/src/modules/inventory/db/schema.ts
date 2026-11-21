import { inventorySchema } from '@iv2/db';
import type { LocationStatus, StockMovementType } from '@iv2/shared-domain';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  index,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const locations = inventorySchema.table(
  'locations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    address: text('address'),
    description: text('description'),
    status: text('status').$type<LocationStatus>().notNull().default('ACTIVE'),
    parentLocationId: uuid('parent_location_id').references((): AnyPgColumn => locations.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_locations_name_lower_uidx').on(sql`LOWER(${table.name})`),
    index('inventory_locations_created_id_idx').on(table.createdAt, table.id),
  ],
);

export type LocationRow = typeof locations.$inferSelect;
export type NewLocationRow = typeof locations.$inferInsert;

export const stockMovements = inventorySchema.table(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    type: text('type').$type<StockMovementType>().notNull(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    quantityDelta: numeric('quantity_delta', { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    reasonCategory: text('reason_category'),
    note: text('note'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    actorId: text('actor_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('inventory_stock_movements_sku_loc_created_idx').on(
      table.skuId,
      table.locationId,
      table.createdAt,
    ),
    index('inventory_stock_movements_ref_idx').on(table.referenceType, table.referenceId),
    index('inventory_stock_movements_created_id_idx').on(table.createdAt, table.id),
  ],
);

export type StockMovementRow = typeof stockMovements.$inferSelect;
export type NewStockMovementRow = typeof stockMovements.$inferInsert;

export const stockBalances = inventorySchema.table(
  'stock_balances',
  {
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    onHand: numeric('on_hand', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    reserved: numeric('reserved', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    available: numeric('available', { precision: 18, scale: 4 })
      .generatedAlwaysAs((): SQL => sql`on_hand - reserved`)
      .notNull(),
    inTransit: numeric('in_transit', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    weightedAverageCost: numeric('weighted_average_cost', { precision: 18, scale: 4 })
      .notNull()
      .default('0.0000'),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.skuId, table.locationId] })],
);

export type StockBalanceRow = typeof stockBalances.$inferSelect;
export type NewStockBalanceRow = typeof stockBalances.$inferInsert;

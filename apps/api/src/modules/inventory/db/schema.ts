import { inventorySchema } from '@iv2/db';
import type { LocationStatus, StockMovementType } from '@iv2/shared-domain';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  date,
  index,
  integer,
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

export const stockLots = inventorySchema.table(
  'stock_lots',
  {
    id: uuid('id').primaryKey(),
    skuId: uuid('sku_id').notNull(),
    lotCode: text('lot_code').notNull(),
    mfgDate: date('mfg_date', { mode: 'string' }),
    expDate: date('exp_date', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inventory_stock_lots_sku_lot_code_lower_uidx').on(
      table.skuId,
      sql`LOWER(${table.lotCode})`,
    ),
    index('inventory_stock_lots_sku_exp_created_idx').on(
      table.skuId,
      table.expDate,
      table.createdAt,
    ),
  ],
);

export type StockLotRow = typeof stockLots.$inferSelect;
export type NewStockLotRow = typeof stockLots.$inferInsert;

export const stockLotBalances = inventorySchema.table(
  'stock_lot_balances',
  {
    lotId: uuid('lot_id')
      .notNull()
      .references(() => stockLots.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    onHand: numeric('on_hand', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    inTransit: numeric('in_transit', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0.0000'),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.lotId, table.locationId] }),
    index('inventory_stock_lot_balances_loc_lot_idx').on(table.locationId, table.lotId),
  ],
);

export type StockLotBalanceRow = typeof stockLotBalances.$inferSelect;
export type NewStockLotBalanceRow = typeof stockLotBalances.$inferInsert;

export const stockMovements = inventorySchema.table(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    type: text('type').$type<StockMovementType>().notNull(),
    skuId: uuid('sku_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => stockLots.id, { onDelete: 'restrict' }),
    sliceIndex: integer('slice_index').notNull().default(0),
    movementGroupId: uuid('movement_group_id'),
    quantityDelta: numeric('quantity_delta', { precision: 18, scale: 4 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    wacUnitCost: numeric('wac_unit_cost', { precision: 18, scale: 4 }),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    reasonCategory: text('reason_category'),
    note: text('note'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    actorId: text('actor_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('stock_movements_idempotency_key_slice_uidx').on(
      table.idempotencyKey,
      table.sliceIndex,
    ),
    index('inventory_stock_movements_sku_loc_created_idx').on(
      table.skuId,
      table.locationId,
      table.createdAt,
    ),
    index('inventory_stock_movements_lot_loc_created_idx').on(
      table.lotId,
      table.locationId,
      table.createdAt,
    ),
    index('inventory_stock_movements_group_id_idx').on(table.movementGroupId),
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

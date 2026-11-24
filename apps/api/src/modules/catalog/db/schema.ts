import { catalogSchema } from '@iv2/db';
import type { CatalogStatus } from '@iv2/shared-domain';
import { sql } from 'drizzle-orm';
import { check, index, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const catalogUnitsOfMeasure = catalogSchema.table(
  'units_of_measure',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status').$type<CatalogStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('catalog_units_of_measure_status_check', sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`),
    uniqueIndex('catalog_units_of_measure_code_lower_uidx').on(sql`LOWER(${table.code})`),
    uniqueIndex('catalog_units_of_measure_name_lower_uidx').on(sql`LOWER(${table.name})`),
    index('catalog_units_of_measure_created_id_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

export const catalogProducts = catalogSchema.table(
  'products',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<CatalogStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('catalog_products_status_check', sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`),
    index('catalog_products_status_created_id_idx').on(
      table.status,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('catalog_products_created_id_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

export const catalogSkus = catalogSchema.table(
  'skus',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    unitOfMeasureId: uuid('unit_of_measure_id')
      .notNull()
      .references(() => catalogUnitsOfMeasure.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    defaultSellingPrice: numeric('default_selling_price', { precision: 18, scale: 4 }),
    status: text('status').$type<CatalogStatus>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('catalog_skus_status_check', sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`),
    uniqueIndex('catalog_skus_code_lower_uidx').on(sql`LOWER(${table.code})`),
    index('catalog_skus_product_id_idx').on(table.productId),
    index('catalog_skus_unit_of_measure_id_idx').on(table.unitOfMeasureId),
    index('catalog_skus_created_id_idx').on(table.createdAt.desc(), table.id.desc()),
  ],
);

export type UnitOfMeasureRow = typeof catalogUnitsOfMeasure.$inferSelect;
export type ProductRow = typeof catalogProducts.$inferSelect;
export type SkuRow = typeof catalogSkus.$inferSelect;

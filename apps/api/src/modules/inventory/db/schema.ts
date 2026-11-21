import { inventorySchema } from '@iv2/db';
import type { LocationStatus } from '@iv2/shared-domain';
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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

import { pgSchema } from 'drizzle-orm/pg-core';

export const catalogSchema = pgSchema('catalog');
export const inventorySchema = pgSchema('inventory');
export const ordersSchema = pgSchema('orders');
export const iamSchema = pgSchema('iam');
export const sharedSchema = pgSchema('shared');

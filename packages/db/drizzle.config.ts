import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schemas.ts', '../../apps/api/src/modules/*/db/schema.ts'],
  out: './migrations',
  schemaFilter: ['catalog', 'inventory', 'orders', 'iam', 'shared'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/inventory_v2',
  },
});

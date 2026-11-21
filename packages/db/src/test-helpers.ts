import type { Pool } from 'pg';
import { migrateDatabase } from './migrate.js';

export const DOMAIN_SCHEMAS = ['catalog', 'inventory', 'orders', 'iam', 'shared'] as const;

export async function resetTestDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${DOMAIN_SCHEMAS.join(', ')} CASCADE;`);
  } finally {
    client.release();
  }
  await migrateDatabase(pool);
}

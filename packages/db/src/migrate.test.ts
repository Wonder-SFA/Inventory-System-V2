import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DOMAIN_SCHEMAS, createPool, migrateDatabase, resetTestDatabase } from './index.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('database schema migrations', () => {
  let pool: Pool;

  beforeAll(() => {
    if (!testDbUrl) {
      throw new Error('TEST_DATABASE_URL is required to run database integration tests');
    }
    pool = createPool(testDbUrl);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates all 5 isolated PostgreSQL schemas and tracks applied migrations idempotently', async () => {
    await resetTestDatabase(pool);

    const { rows } = await pool.query<{ schema_name: string }>(
      `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = ANY($1::text[])
      ORDER BY schema_name ASC;
      `,
      [DOMAIN_SCHEMAS],
    );

    expect(rows.map((r) => r.schema_name)).toEqual([...DOMAIN_SCHEMAS].sort());

    const secondRun = await migrateDatabase(pool);
    expect(secondRun).toEqual([]);

    const migrations = await pool.query<{ id: string }>(
      'SELECT id FROM shared._migrations ORDER BY id ASC;',
    );
    expect(migrations.rows.map((r) => r.id)).toEqual([
      '0001_init_schemas.sql',
      '0002_shared_outbox_idempotency.sql',
      '0003_iam_auth_and_access_switch.sql',
      '0004_catalog_schema.sql',
      '0005_inventory_locations.sql',
      '0006_inventory_ledger_and_balances.sql',
      '0007_orders_suppliers_purchase_orders.sql',
      '0008_orders_customers_sales_orders.sql',
      '0009_orders_transfer_orders.sql',
      '0010_catalog_uom_status.sql',
      '0011_catalog_sku_lot_flags_and_stock_lots.sql',
    ]);

    const tables = await pool.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'shared'
        AND table_name = ANY($1::text[])
      ORDER BY table_name ASC;
      `,
      [['idempotency_keys', 'outbox_events', 'event_checkpoints', 'processed_events']],
    );

    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'event_checkpoints',
      'idempotency_keys',
      'outbox_events',
      'processed_events',
    ]);
  });
});

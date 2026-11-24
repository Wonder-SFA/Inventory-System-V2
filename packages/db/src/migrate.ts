import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export async function migrateDatabase(
  pool: Pool,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS shared;');
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared._migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const existingResult = await client.query<{ id: string }>(
      'SELECT id FROM shared._migrations ORDER BY id ASC;',
    );
    const appliedSet = new Set(existingResult.rows.map((row) => row.id));

    const entries = await fs.readdir(migrationsDir);
    const sqlFiles = entries.filter((file) => file.endsWith('.sql')).sort();

    for (const file of sqlFiles) {
      if (appliedSet.has(file)) {
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO shared._migrations (id) VALUES ($1);', [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return appliedNow;
  } finally {
    client.release();
  }
}

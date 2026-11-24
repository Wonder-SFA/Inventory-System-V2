import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

export type Database = NodePgDatabase<Record<string, never>>;

export function createPool(connectionStringOrConfig?: string | PoolConfig): Pool {
  if (typeof connectionStringOrConfig === 'string') {
    return new Pool({ connectionString: connectionStringOrConfig });
  }
  if (connectionStringOrConfig) {
    return new Pool(connectionStringOrConfig);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required to create a database pool');
  }
  return new Pool({ connectionString });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool);
}

import { createDb, createPool } from '@iv2/db';
import { buildApp } from './app.js';
import { OutboxDispatcher } from './shared/outbox/index.js';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

const pool = process.env.DATABASE_URL ? createPool() : undefined;
const db = pool ? createDb(pool) : undefined;
const outboxDispatcher = db ? new OutboxDispatcher(db) : undefined;

const app = buildApp({ pool, db, outboxDispatcher });

const shutdown = async () => {
  await outboxDispatcher?.stop();
  await app.close();
  await pool?.end();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await outboxDispatcher?.start();
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  await outboxDispatcher?.stop();
  await pool?.end();
  process.exit(1);
}

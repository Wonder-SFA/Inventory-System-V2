import { sharedSchema } from '@iv2/db';
import {
  bigint,
  bigserial,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const idempotencyKeys = sharedSchema.table('idempotency_keys', {
  key: uuid('key').primaryKey(),
  actorId: text('actor_id').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code').notNull(),
  responseBody: jsonb('response_body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvents = sharedSchema.table('outbox_events', {
  seqId: bigserial('seq_id', { mode: 'number' }).primaryKey(),
  eventId: uuid('event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventCheckpoints = sharedSchema.table('event_checkpoints', {
  consumerName: text('consumer_name').primaryKey(),
  lastEventId: bigint('last_event_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const processedEvents = sharedSchema.table(
  'processed_events',
  {
    consumerName: text('consumer_name').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumerName, table.eventId] })],
);

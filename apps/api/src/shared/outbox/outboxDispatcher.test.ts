import { createDb, createPool, resetTestDatabase } from '@iv2/db';
import { uuidv7 } from '@iv2/shared-domain';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboxEvents, processedEvents } from '../db/schema.js';
import { OutboxDispatcher } from './outboxDispatcher.js';

const testDbUrl = process.env.TEST_DATABASE_URL;

describe('OutboxDispatcher', () => {
  let pool: Pool;

  beforeAll(() => {
    if (!testDbUrl) {
      throw new Error('TEST_DATABASE_URL is required');
    }
    pool = createPool(testDbUrl);
  });

  beforeEach(async () => {
    await resetTestDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('processes events in monotonic seq_id order, tracks per-consumer checkpoints, and deduplicates by event_id', async () => {
    const db = createDb(pool);
    const dispatcher = new OutboxDispatcher(db);

    const seenA: Array<{ seqId: number; eventId: string; eventType: string }> = [];
    const seenB: Array<{ seqId: number; eventId: string; eventType: string }> = [];

    dispatcher.registerConsumer('consumer-a', async (event) => {
      seenA.push({ seqId: event.seqId, eventId: event.eventId, eventType: event.eventType });
    });
    dispatcher.registerConsumer('consumer-b', async (event) => {
      seenB.push({ seqId: event.seqId, eventId: event.eventId, eventType: event.eventType });
    });

    const eventId1 = uuidv7();
    const eventId2 = uuidv7();

    await db.insert(outboxEvents).values([
      {
        eventId: eventId1,
        eventType: 'StockReceived',
        aggregateType: 'StockMovement',
        aggregateId: uuidv7(),
        payload: { qty: '10.0000' },
      },
      {
        eventId: eventId2,
        eventType: 'StockIssued',
        aggregateType: 'StockMovement',
        aggregateId: uuidv7(),
        payload: { qty: '2.0000' },
      },
    ]);

    const processedCount = await dispatcher.drainOutbox();
    expect(processedCount).toBe(4); // 2 events * 2 consumers
    expect(seenA.map((e) => e.eventType)).toEqual(['StockReceived', 'StockIssued']);
    expect(seenA[0]!.seqId).toBeLessThan(seenA[1]!.seqId);
    expect(seenB.map((e) => e.eventId)).toEqual([eventId1, eventId2]);

    // Draining again processes 0 events because checkpoints advanced
    const secondDrain = await dispatcher.drainOutbox();
    expect(secondDrain).toBe(0);

    // Simulate a new event whose eventId was already marked in processed_events for consumer-a
    const eventId3 = uuidv7();
    await db.insert(processedEvents).values({
      consumerName: 'consumer-a',
      eventId: eventId3,
    });
    await db.insert(outboxEvents).values({
      eventId: eventId3,
      eventType: 'StockAdjusted',
      aggregateType: 'StockMovement',
      aggregateId: uuidv7(),
      payload: { qty: '1.0000' },
    });

    await dispatcher.drainOutbox();
    // consumer-a skipped eventId3 due to processed_events deduplication; consumer-b received it
    expect(seenA).toHaveLength(2);
    expect(seenB).toHaveLength(3);
    expect(seenB[2]!.eventId).toBe(eventId3);
  });
});

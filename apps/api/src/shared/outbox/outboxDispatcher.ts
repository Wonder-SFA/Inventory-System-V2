import type { Database } from '@iv2/db';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { eventCheckpoints, outboxEvents, processedEvents } from '../db/schema.js';

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface OutboxEventRecord {
  seqId: number;
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}

export type OutboxEventHandler = (
  event: OutboxEventRecord,
  tx: DbTransaction,
) => Promise<void>;

export interface OutboxWakeupAdapter {
  start(onWakeup: () => void): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface OutboxDispatcherOptions {
  batchSize?: number | undefined;
  initialBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
  maxRetries?: number | undefined;
  wakeupAdapter?: OutboxWakeupAdapter | undefined;
  onError?: ((error: unknown, consumerName: string) => void) | undefined;
}

export class OutboxDispatcher {
  private readonly db: Database;
  private readonly consumers = new Map<string, OutboxEventHandler>();
  private readonly batchSize: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly wakeupAdapter?: OutboxWakeupAdapter | undefined;
  private readonly onError?: ((error: unknown, consumerName: string) => void) | undefined;

  private activeDrain: Promise<number> | null = null;
  private nudgeQueued = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private stopped = false;

  constructor(db: Database, options: OutboxDispatcherOptions = {}) {
    this.db = db;
    this.batchSize = options.batchSize ?? 100;
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 10;
    this.wakeupAdapter = options.wakeupAdapter;
    this.onError = options.onError;
  }

  registerConsumer(name: string, handler: OutboxEventHandler): void {
    if (this.consumers.has(name)) {
      throw new Error(`Outbox consumer "${name}" is already registered`);
    }
    this.consumers.set(name, handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.wakeupAdapter) {
      await this.wakeupAdapter.start(() => {
        this.nudge();
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.wakeupAdapter) {
      await this.wakeupAdapter.stop();
    }
    if (this.activeDrain) {
      await this.activeDrain.catch(() => undefined);
    }
  }

  /**
   * Immediate in-memory wakeup nudge called after transaction commit.
   * Coalesces concurrent nudges and schedules exponential backoff on failure.
   */
  nudge(): void {
    if (this.stopped) {
      return;
    }
    if (this.activeDrain) {
      this.nudgeQueued = true;
      return;
    }
    queueMicrotask(() => {
      if (this.stopped) {
        return;
      }
      void this.runBackgroundDrain();
    });
  }

  private async runBackgroundDrain(): Promise<void> {
    try {
      await this.drainOutbox();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.onError) {
        this.onError(error, 'dispatcher');
      }
      if (!this.stopped && this.consecutiveFailures <= this.maxRetries) {
        const delayMs = Math.min(
          this.initialBackoffMs * 2 ** (this.consecutiveFailures - 1),
          this.maxBackoffMs,
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.nudge();
        }, delayMs);
        this.retryTimer.unref?.();
      }
    }
  }

  /**
   * Synchronously drains all pending outbox events across all registered consumers
   * without timers. Intended for deterministic integration tests and internal draining.
   */
  async drainOutbox(): Promise<number> {
    if (this.activeDrain) {
      await this.activeDrain;
    }

    const drainPromise = this.executeDrainLoop();
    this.activeDrain = drainPromise;
    try {
      return await drainPromise;
    } finally {
      this.activeDrain = null;
      if (this.nudgeQueued && !this.stopped) {
        this.nudgeQueued = false;
        this.nudge();
      }
    }
  }

  private async executeDrainLoop(): Promise<number> {
    let totalProcessed = 0;

    for (const [consumerName, handler] of this.consumers.entries()) {
      totalProcessed += await this.drainConsumer(consumerName, handler);
    }

    return totalProcessed;
  }

  private async drainConsumer(
    consumerName: string,
    handler: OutboxEventHandler,
  ): Promise<number> {
    await this.db
      .insert(eventCheckpoints)
      .values({ consumerName, lastEventId: 0 })
      .onConflictDoNothing({ target: eventCheckpoints.consumerName });

    let processedCount = 0;

    while (true) {
      const [checkpoint] = await this.db
        .select({ lastEventId: eventCheckpoints.lastEventId })
        .from(eventCheckpoints)
        .where(eq(eventCheckpoints.consumerName, consumerName))
        .limit(1);

      const lastEventId = checkpoint?.lastEventId ?? 0;

      const batch = await this.db
        .select({
          seqId: outboxEvents.seqId,
          eventId: outboxEvents.eventId,
          eventType: outboxEvents.eventType,
          aggregateType: outboxEvents.aggregateType,
          aggregateId: outboxEvents.aggregateId,
          payload: outboxEvents.payload,
          createdAt: outboxEvents.createdAt,
        })
        .from(outboxEvents)
        .where(gt(outboxEvents.seqId, lastEventId))
        .orderBy(asc(outboxEvents.seqId))
        .limit(this.batchSize);

      if (batch.length === 0) {
        break;
      }

      for (const event of batch) {
        const didProcess = await this.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(processedEvents)
            .values({
              consumerName,
              eventId: event.eventId,
            })
            .onConflictDoNothing({
              target: [processedEvents.consumerName, processedEvents.eventId],
            })
            .returning({ eventId: processedEvents.eventId });

          if (inserted.length > 0) {
            await handler(event, tx);
          }

          await tx
            .update(eventCheckpoints)
            .set({
              lastEventId: event.seqId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(eventCheckpoints.consumerName, consumerName),
                lt(eventCheckpoints.lastEventId, event.seqId),
              ),
            );

          return inserted.length > 0;
        });

        if (didProcess) {
          processedCount += 1;
        }
      }
    }

    return processedCount;
  }
}

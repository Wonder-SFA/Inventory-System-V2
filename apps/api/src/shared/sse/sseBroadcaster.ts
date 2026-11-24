import {
  ERROR_CODES,
  RateLimitedError,
  SSE_TOPICS,
  type SseInvalidateEvent,
} from '@iv2/shared-domain';
import type { LocationScope } from '../../modules/iam/public/index.js';
import type { OutboxDispatcher, OutboxEventRecord } from '../outbox/outboxDispatcher.js';

export const SSE_BROADCASTER_CONSUMER_NAME = 'sse_broadcaster';
export const DEFAULT_MAX_SSE_CONNECTIONS_PER_USER = 5;
export const DEFAULT_SSE_KEEPALIVE_INTERVAL_MS = 25_000;

export interface SseBroadcasterOptions {
  maxConnectionsPerUser?: number | undefined;
  keepaliveIntervalMs?: number | undefined;
}

export interface SseConnectionRequest {
  userId: string;
  locationScope: LocationScope;
  write: (chunk: string) => void;
  onClose?: (() => void) | undefined;
}

interface ActiveConnection {
  id: number;
  userId: string;
  locationScope: LocationScope;
  write: (chunk: string) => void;
  onClose?: (() => void) | undefined;
  keepaliveTimer: ReturnType<typeof setInterval>;
  closed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function addStringId(target: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    target.add(value);
  }
}

function addStringArray(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    addStringId(target, item);
  }
}

function extractTopics(eventType: string): string[] {
  if (
    eventType.startsWith('Product') ||
    eventType.startsWith('Sku') ||
    eventType.startsWith('UnitOfMeasure')
  ) {
    return [SSE_TOPICS.CATALOG];
  }
  if (eventType.startsWith('Location')) {
    return [SSE_TOPICS.LOCATIONS];
  }
  if (
    eventType === 'StockReceived' ||
    eventType === 'StockIssued' ||
    eventType === 'StockAdjusted' ||
    eventType === 'TransferDispatched' ||
    eventType === 'TransferReceived'
  ) {
    return [SSE_TOPICS.STOCK_BALANCES, SSE_TOPICS.STOCK_MOVEMENTS];
  }
  if (
    eventType === 'StockReserved' ||
    eventType === 'StockReservationReleased' ||
    eventType === 'TransferDiscrepancyClosed' ||
    eventType.startsWith('Stock')
  ) {
    return [SSE_TOPICS.STOCK_BALANCES];
  }
  if (eventType.startsWith('PurchaseOrder')) {
    return [SSE_TOPICS.PURCHASE_ORDERS];
  }
  if (eventType.startsWith('SalesOrder')) {
    return [SSE_TOPICS.SALES_ORDERS];
  }
  if (eventType.startsWith('TransferOrder')) {
    return [SSE_TOPICS.TRANSFER_ORDERS];
  }
  if (eventType.startsWith('Supplier')) {
    return [SSE_TOPICS.SUPPLIERS];
  }
  if (eventType.startsWith('Customer')) {
    return [SSE_TOPICS.CUSTOMERS];
  }
  if (eventType.startsWith('Order')) {
    return ['orders'];
  }
  return [];
}

/**
 * Translates a committed outbox event into a minimal invalidation-only SSE payload.
 * Never copies quantities, unit costs, Weighted Average Cost, or PII.
 */
export function translateOutboxEventToInvalidate(
  event: OutboxEventRecord,
): SseInvalidateEvent | null {
  const topics = extractTopics(event.eventType);
  if (topics.length === 0) {
    return null;
  }

  const payload = asRecord(event.payload);
  const locationIds = new Set<string>();
  const skuIds = new Set<string>();

  if (event.eventType.startsWith('Location')) {
    addStringId(locationIds, payload.id ?? event.aggregateId);
  } else {
    addStringId(locationIds, payload.locationId);
    addStringId(locationIds, payload.sourceLocationId);
    addStringId(locationIds, payload.destinationLocationId);
    addStringArray(locationIds, payload.locationIds);
  }

  if (event.eventType.startsWith('Sku')) {
    addStringId(skuIds, payload.id ?? event.aggregateId);
  } else {
    addStringId(skuIds, payload.skuId);
    addStringArray(skuIds, payload.skuIds);
  }

  return {
    seqId: event.seqId,
    topics,
    locationIds: [...locationIds],
    skuIds: [...skuIds],
  };
}

function filterEventForScope(
  event: SseInvalidateEvent,
  scope: LocationScope,
): SseInvalidateEvent | null {
  if (!('locationIds' in scope)) {
    return event;
  }

  // Non-location-scoped events (e.g. catalog, suppliers, customers) pass through.
  if (event.locationIds.length === 0) {
    return event;
  }

  const allowed = new Set(scope.locationIds);
  const matchingLocationIds = event.locationIds.filter((id) => allowed.has(id));
  if (matchingLocationIds.length === 0) {
    return null;
  }

  return {
    seqId: event.seqId,
    topics: event.topics,
    locationIds: matchingLocationIds,
    skuIds: event.skuIds,
  };
}

export function formatSseInvalidateFrame(event: SseInvalidateEvent): string {
  return `event: invalidate\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseBroadcaster {
  private readonly maxConnectionsPerUser: number;
  private readonly keepaliveIntervalMs: number;
  private readonly connectionsByUser = new Map<string, Set<ActiveConnection>>();
  private nextConnectionId = 1;

  constructor(options: SseBroadcasterOptions = {}) {
    this.maxConnectionsPerUser =
      options.maxConnectionsPerUser ?? DEFAULT_MAX_SSE_CONNECTIONS_PER_USER;
    this.keepaliveIntervalMs =
      options.keepaliveIntervalMs ?? DEFAULT_SSE_KEEPALIVE_INTERVAL_MS;
  }

  registerWithDispatcher(dispatcher: OutboxDispatcher): void {
    dispatcher.registerConsumer(SSE_BROADCASTER_CONSUMER_NAME, async (event) => {
      await this.handleOutboxEvent(event);
    });
  }

  async handleOutboxEvent(event: OutboxEventRecord): Promise<void> {
    const invalidateEvent = translateOutboxEventToInvalidate(event);
    if (!invalidateEvent) {
      return;
    }
    this.broadcast(invalidateEvent);
  }

  broadcast(event: SseInvalidateEvent): void {
    for (const userConnections of this.connectionsByUser.values()) {
      for (const connection of [...userConnections]) {
        if (connection.closed) {
          continue;
        }
        const scopedEvent = filterEventForScope(event, connection.locationScope);
        if (!scopedEvent) {
          continue;
        }
        try {
          connection.write(formatSseInvalidateFrame(scopedEvent));
        } catch {
          this.disconnectConnection(connection);
        }
      }
    }
  }

  activeConnectionCount(userId?: string): number {
    if (userId !== undefined) {
      return this.connectionsByUser.get(userId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.connectionsByUser.values()) {
      total += set.size;
    }
    return total;
  }

  connect(request: SseConnectionRequest): () => void {
    const existing = this.connectionsByUser.get(request.userId);
    if (existing && existing.size >= this.maxConnectionsPerUser) {
      throw new RateLimitedError(
        `Maximum of ${this.maxConnectionsPerUser} concurrent SSE streams per user exceeded`,
        ERROR_CODES.TOO_MANY_SSE_CONNECTIONS,
      );
    }

    const userConnections = existing ?? new Set<ActiveConnection>();
    if (!existing) {
      this.connectionsByUser.set(request.userId, userConnections);
    }

    const connection: ActiveConnection = {
      id: this.nextConnectionId++,
      userId: request.userId,
      locationScope: request.locationScope,
      write: request.write,
      onClose: request.onClose,
      closed: false,
      keepaliveTimer: setInterval(() => {
        if (connection.closed) {
          return;
        }
        try {
          connection.write(': keepalive\n\n');
        } catch {
          this.disconnectConnection(connection);
        }
      }, this.keepaliveIntervalMs),
    };
    connection.keepaliveTimer.unref?.();

    userConnections.add(connection);

    return () => {
      this.disconnectConnection(connection);
    };
  }

  closeAll(): void {
    for (const userConnections of [...this.connectionsByUser.values()]) {
      for (const connection of [...userConnections]) {
        this.disconnectConnection(connection);
      }
    }
  }

  private disconnectConnection(connection: ActiveConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    clearInterval(connection.keepaliveTimer);

    const userConnections = this.connectionsByUser.get(connection.userId);
    if (userConnections) {
      userConnections.delete(connection);
      if (userConnections.size === 0) {
        this.connectionsByUser.delete(connection.userId);
      }
    }

    connection.onClose?.();
  }
}

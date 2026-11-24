import { ERROR_CODES, RateLimitedError } from '@iv2/shared-domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEventRecord } from '../outbox/outboxDispatcher.js';
import { SseBroadcaster, translateOutboxEventToInvalidate } from './sseBroadcaster.js';

function makeOutboxEvent(
  overrides: Partial<OutboxEventRecord> & Pick<OutboxEventRecord, 'eventType'>,
): OutboxEventRecord {
  return {
    seqId: 1,
    eventId: '01900000-0000-7000-8000-000000000001',
    aggregateType: 'test',
    aggregateId: '01900000-0000-7000-8000-000000000002',
    payload: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('translateOutboxEventToInvalidate', () => {
  it('translates catalog, location, stock, and order events without leaking quantities, costs, or PII', () => {
    const stockEvent = makeOutboxEvent({
      seqId: 17,
      eventType: 'StockReceived',
      aggregateType: 'stock_movement',
      aggregateId: 'mov-1',
      payload: {
        id: 'mov-1',
        skuId: 'sku-1',
        locationId: 'loc-1',
        quantityDelta: '10.0000',
        unitCost: '25.5000',
        weightedAverageCost: '24.0000',
        actorEmail: 'secret@example.com',
        note: 'private note',
      },
    });

    const translated = translateOutboxEventToInvalidate(stockEvent);
    expect(translated).toEqual({
      seqId: 17,
      topics: ['stock-balances', 'stock-movements'],
      locationIds: ['loc-1'],
      skuIds: ['sku-1'],
    });
    expect(Object.keys(translated!).sort()).toEqual([
      'locationIds',
      'seqId',
      'skuIds',
      'topics',
    ]);

    const transferEvent = makeOutboxEvent({
      seqId: 18,
      eventType: 'TransferDispatched',
      payload: {
        skuId: 'sku-2',
        locationId: 'loc-src',
        destinationLocationId: 'loc-dst',
        dispatchUnitCost: '12.0000',
      },
    });
    expect(translateOutboxEventToInvalidate(transferEvent)).toEqual({
      seqId: 18,
      topics: ['stock-balances', 'stock-movements'],
      locationIds: ['loc-src', 'loc-dst'],
      skuIds: ['sku-2'],
    });

    const skuEvent = makeOutboxEvent({
      seqId: 19,
      eventType: 'SkuCreated',
      aggregateId: 'sku-3',
      payload: { id: 'sku-3', code: 'TSHIRT-RED-M', name: 'Cotton T-Shirt' },
    });
    expect(translateOutboxEventToInvalidate(skuEvent)).toEqual({
      seqId: 19,
      topics: ['catalog'],
      locationIds: [],
      skuIds: ['sku-3'],
    });

    const locEvent = makeOutboxEvent({
      seqId: 20,
      eventType: 'LocationUpdated',
      aggregateId: 'loc-9',
      payload: { id: 'loc-9', name: 'Main Warehouse' },
    });
    expect(translateOutboxEventToInvalidate(locEvent)).toEqual({
      seqId: 20,
      topics: ['locations'],
      locationIds: ['loc-9'],
      skuIds: [],
    });

    const poEvent = makeOutboxEvent({
      seqId: 21,
      eventType: 'PurchaseOrderReceived',
      payload: { locationId: 'loc-1', skuIds: ['sku-1', 'sku-2'], totalAmount: '999.0000' },
    });
    expect(translateOutboxEventToInvalidate(poEvent)).toEqual({
      seqId: 21,
      topics: ['purchase-orders'],
      locationIds: ['loc-1'],
      skuIds: ['sku-1', 'sku-2'],
    });
  });
});

describe('SseBroadcaster', () => {
  const broadcasters: SseBroadcaster[] = [];

  afterEach(() => {
    while (broadcasters.length > 0) {
      broadcasters.pop()?.closeAll();
    }
    vi.useRealTimers();
  });

  it('filters emitted events by LocationScope and allows non-location-scoped catalog events', async () => {
    const broadcaster = new SseBroadcaster({ keepaliveIntervalMs: 60_000 });
    broadcasters.push(broadcaster);

    const allChunks: string[] = [];
    const scopedChunks: string[] = [];

    broadcaster.connect({
      userId: 'user-all',
      locationScope: { allLocations: true },
      write: (chunk) => allChunks.push(chunk),
    });

    broadcaster.connect({
      userId: 'user-scoped',
      locationScope: { locationIds: ['loc-a'] },
      write: (chunk) => scopedChunks.push(chunk),
    });

    await broadcaster.handleOutboxEvent(
      makeOutboxEvent({
        seqId: 1,
        eventType: 'StockReceived',
        payload: { skuId: 'sku-1', locationId: 'loc-b', quantityDelta: '5.0000' },
      }),
    );

    await broadcaster.handleOutboxEvent(
      makeOutboxEvent({
        seqId: 2,
        eventType: 'TransferDispatched',
        payload: {
          skuId: 'sku-1',
          locationId: 'loc-a',
          destinationLocationId: 'loc-b',
        },
      }),
    );

    await broadcaster.handleOutboxEvent(
      makeOutboxEvent({
        seqId: 3,
        eventType: 'ProductUpdated',
        aggregateId: 'prod-1',
        payload: { id: 'prod-1' },
      }),
    );

    expect(allChunks).toHaveLength(3);
    expect(scopedChunks).toHaveLength(2);
    expect(scopedChunks[0]).toContain('"seqId":2');
    expect(scopedChunks[0]).toContain('"locationIds":["loc-a"]');
    expect(scopedChunks[0]).not.toContain('loc-b');
    expect(scopedChunks[1]).toContain('"seqId":3');
    expect(scopedChunks[1]).toContain('"topics":["catalog"]');
  });

  it('enforces max 5 concurrent connections per user and frees slots on close', () => {
    const broadcaster = new SseBroadcaster({ keepaliveIntervalMs: 60_000 });
    broadcasters.push(broadcaster);

    const disconnects: Array<() => void> = [];
    for (let i = 0; i < 5; i += 1) {
      disconnects.push(
        broadcaster.connect({
          userId: 'user-1',
          locationScope: { allLocations: true },
          write: () => {},
        }),
      );
    }

    expect(() =>
      broadcaster.connect({
        userId: 'user-1',
        locationScope: { allLocations: true },
        write: () => {},
      }),
    ).toThrowError(RateLimitedError);

    try {
      broadcaster.connect({
        userId: 'user-1',
        locationScope: { allLocations: true },
        write: () => {},
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).code).toBe(ERROR_CODES.TOO_MANY_SSE_CONNECTIONS);
      expect((err as RateLimitedError).statusCode).toBe(429);
    }

    // Other users are unaffected
    const user2Disconnect = broadcaster.connect({
      userId: 'user-2',
      locationScope: { allLocations: true },
      write: () => {},
    });

    // Closing one slot for user-1 allows a new connection
    disconnects[0]!();
    const replacement = broadcaster.connect({
      userId: 'user-1',
      locationScope: { allLocations: true },
      write: () => {},
    });

    replacement();
    user2Disconnect();
  });

  it('emits keepalive comments on interval and stops immediately after disconnect', () => {
    vi.useFakeTimers();
    const broadcaster = new SseBroadcaster({ keepaliveIntervalMs: 25_000 });
    broadcasters.push(broadcaster);

    const chunks: string[] = [];
    const disconnect = broadcaster.connect({
      userId: 'user-1',
      locationScope: { allLocations: true },
      write: (chunk) => chunks.push(chunk),
    });

    vi.advanceTimersByTime(25_000);
    expect(chunks).toEqual([': keepalive\n\n']);

    vi.advanceTimersByTime(25_000);
    expect(chunks).toEqual([': keepalive\n\n', ': keepalive\n\n']);

    disconnect();
    vi.advanceTimersByTime(50_000);
    expect(chunks).toHaveLength(2);
  });
});

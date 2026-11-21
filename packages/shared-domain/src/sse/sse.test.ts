import { describe, expect, it } from 'vitest';
import { ERROR_CODES, SseInvalidateEventSchema, SSE_TOPICS } from '../index.js';

describe('SseInvalidateEventSchema', () => {
  it('accepts valid minimal invalidation payload with seqId, topics, locationIds, skuIds', () => {
    const parsed = SseInvalidateEventSchema.parse({
      seqId: 42,
      topics: [SSE_TOPICS.STOCK_BALANCES, SSE_TOPICS.STOCK_MOVEMENTS],
      locationIds: ['01900000-0000-7000-8000-000000000001'],
      skuIds: ['01900000-0000-7000-8000-000000000002'],
    });

    expect(parsed).toEqual({
      seqId: 42,
      topics: ['stock-balances', 'stock-movements'],
      locationIds: ['01900000-0000-7000-8000-000000000001'],
      skuIds: ['01900000-0000-7000-8000-000000000002'],
    });
  });

  it('rejects negative seqId or missing required arrays', () => {
    expect(() =>
      SseInvalidateEventSchema.parse({
        seqId: -1,
        topics: ['catalog'],
        locationIds: [],
        skuIds: [],
      }),
    ).toThrow();

    expect(() =>
      SseInvalidateEventSchema.parse({
        seqId: 1,
        topics: ['catalog'],
      }),
    ).toThrow();
  });

  it('exposes TOO_MANY_SSE_CONNECTIONS error code', () => {
    expect(ERROR_CODES.TOO_MANY_SSE_CONNECTIONS).toBe('TOO_MANY_SSE_CONNECTIONS');
  });
});

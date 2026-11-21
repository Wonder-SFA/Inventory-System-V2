import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiErrorSchema,
  ConflictError,
  CursorPaginationQuerySchema,
  DomainError,
  ERROR_CODES,
  createApiPaginatedSchema,
  createApiSuccessSchema,
} from './index.js';

describe('shared-domain HTTP contract & errors', () => {
  it('validates ApiSuccess envelope with optional warnings and extra warning fields', () => {
    const schema = createApiSuccessSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      data: { id: 'abc' },
      warnings: [
        {
          code: 'PURCHASE_ORDER_OVER_RECEIVED',
          message: 'Received more than ordered',
          orderLineId: 'line-1',
        },
      ],
      meta: { requestId: 'req_1' },
    });

    expect(parsed.data.id).toBe('abc');
    expect(parsed.warnings?.[0]?.orderLineId).toBe('line-1');
    expect(parsed.meta.requestId).toBe('req_1');
  });

  it('validates ApiPaginated envelope', () => {
    const schema = createApiPaginatedSchema(z.object({ id: z.string() }));
    const parsed = schema.parse({
      data: [{ id: '1' }],
      page: { limit: 50, nextCursor: null, hasMore: false },
      meta: { requestId: 'req_2' },
    });

    expect(parsed.data).toHaveLength(1);
    expect(parsed.page.hasMore).toBe(false);
  });

  it('validates ApiError envelope', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: ERROR_CODES.DECIMAL_PRECISION_EXCEEDED,
        message: 'Too many decimals',
        details: [{ field: 'quantity', code: ERROR_CODES.DECIMAL_PRECISION_EXCEEDED, message: 'Max 4 decimals' }],
        requestId: 'req_3',
      },
    });

    expect(parsed.error.code).toBe('DECIMAL_PRECISION_EXCEEDED');
    expect(parsed.error.details?.[0]?.field).toBe('quantity');
  });

  it('defaults CursorPaginationQuerySchema limit to 50 and rejects limit > 100', () => {
    const defaults = CursorPaginationQuerySchema.parse({});
    expect(defaults.limit).toBe(50);
    expect(defaults.cursor).toBeUndefined();

    const maxValid = CursorPaginationQuerySchema.parse({ limit: '100', cursor: 'abc' });
    expect(maxValid.limit).toBe(100);
    expect(maxValid.cursor).toBe('abc');

    const overMax = CursorPaginationQuerySchema.safeParse({ limit: '101' });
    expect(overMax.success).toBe(false);

    const zeroLimit = CursorPaginationQuerySchema.safeParse({ limit: '0' });
    expect(zeroLimit.success).toBe(false);
  });

  it('constructs DomainError and ConflictError with statusCode and code', () => {
    const err = new ConflictError(ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, 'Payload mismatch');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(err.message).toBe('Payload mismatch');
  });
});

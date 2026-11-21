import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiFetch } from './api-client.js';

describe('apiFetch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('auto-generates Idempotency-Key UUID on mutating POST and omits it on GET', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ data: { ok: true }, meta: { requestId: 'req_1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await apiFetch('/api/v1/products', { method: 'GET' });
    const getHeaders = new Headers(calls[0]?.init.headers);
    expect(getHeaders.has('idempotency-key')).toBe(false);

    await apiFetch('/api/v1/products', {
      method: 'POST',
      body: JSON.stringify({ name: 'T-Shirt' }),
    });
    const postHeaders = new Headers(calls[1]?.init.headers);
    const idempKey = postHeaders.get('idempotency-key');
    expect(idempKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(postHeaders.get('content-type')).toBe('application/json');
  });

  it('triggers onUnauthorized callback and throws ApiClientError on 401', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId: 'req_1' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const onUnauthorized = vi.fn();
    await expect(apiFetch('/api/v1/session', { onUnauthorized })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('API health & readiness', () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it('responds with 200 on GET /health and GET /ready', async () => {
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({
      status: 'ok',
      modules: ['catalog', 'inventory', 'orders', 'iam'],
    });

    const readyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toEqual({ status: 'ready' });
  });
});

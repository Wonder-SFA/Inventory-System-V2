import { ERROR_CODES } from '@iv2/shared-domain';
import { describe, expect, it } from 'vitest';
import { type LocationScope, resolvePolicy } from '../public/index.js';

describe('AccessPolicy (in-process)', () => {
  const actor = {
    id: 'user-0195',
    email: 'office@inventory.local',
    name: 'Office User',
  };

  it('defaults in Phase 1 to allLocations: true and canViewCosts: true', () => {
    const policy = resolvePolicy(actor);

    expect(policy.actor).toEqual(actor);
    expect(policy.locationScope).toEqual({ allLocations: true });
    expect(policy.canViewCosts).toBe(true);
    expect(() =>
      policy.assertCan('create', 'purchase_order', { locationId: 'loc-1' }),
    ).not.toThrow();
  });

  it('enforces restricted LocationScope on assertCan', () => {
    const restrictedScope: LocationScope = { locationIds: ['loc-1', 'loc-2'] };
    const policy = resolvePolicy(actor, { locationScope: restrictedScope });

    expect(policy.locationScope).toEqual({ locationIds: ['loc-1', 'loc-2'] });
    expect(() => policy.assertCan('read', 'stock_balance', { locationId: 'loc-1' })).not.toThrow();
    expect(() =>
      policy.assertCan('create', 'purchase_order', { locationId: 'loc-999' }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: ERROR_CODES.FORBIDDEN,
      }),
    );
  });

  it('enforces deniedActions and allowNegativeStock when overridden', () => {
    const policy = resolvePolicy(actor, {
      deniedActions: ['approve:purchase_order'],
      allowNegativeStock: false,
    });

    expect(() => policy.assertCan('approve', 'purchase_order')).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: ERROR_CODES.FORBIDDEN,
      }),
    );

    expect(() =>
      policy.assertCan('adjust', 'stock_movement', { pushesStockNegative: true }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 403,
        code: ERROR_CODES.FORBIDDEN,
      }),
    );

    expect(() =>
      policy.assertCan('adjust', 'stock_movement', { pushesStockNegative: false }),
    ).not.toThrow();
  });

  it('redactCosts returns dto unchanged when canViewCosts is true', () => {
    const policy = resolvePolicy(actor, { canViewCosts: true });
    const dto = {
      id: 'sku-1',
      unitCost: '4.2500',
      weightedAverageCost: '4.1000',
      totalValue: '41.0000',
      lines: [{ skuId: 'sku-1', unitCost: '4.2500' }],
    };

    expect(policy.redactCosts(dto)).toEqual(dto);
  });

  it('redactCosts omits unitCost, weightedAverageCost, and totalValue keys recursively without substituting "0.0000"', () => {
    const policy = resolvePolicy(actor, { canViewCosts: false });
    const now = new Date('2026-11-21T12:00:00.000Z');
    const dto = {
      id: 'po-1',
      status: 'RECEIVED',
      createdAt: now,
      unitCost: '12.5000',
      weightedAverageCost: '10.0000',
      totalValue: '125.0000',
      summary: {
        quantity: '10.0000',
        totalValue: '125.0000',
      },
      lines: [
        {
          id: 'line-1',
          quantity: '5.0000',
          unitCost: '10.0000',
          nested: {
            weightedAverageCost: '10.0000',
            note: 'keep me',
          },
        },
        {
          id: 'line-2',
          quantity: '5.0000',
          unitCost: '15.0000',
        },
      ],
    };

    const redacted = policy.redactCosts(dto) as Record<string, unknown>;

    expect(redacted).toEqual({
      id: 'po-1',
      status: 'RECEIVED',
      createdAt: now,
      summary: {
        quantity: '10.0000',
      },
      lines: [
        {
          id: 'line-1',
          quantity: '5.0000',
          nested: {
            note: 'keep me',
          },
        },
        {
          id: 'line-2',
          quantity: '5.0000',
        },
      ],
    });

    expect('unitCost' in redacted).toBe(false);
    expect('weightedAverageCost' in redacted).toBe(false);
    expect('totalValue' in redacted).toBe(false);
    expect(JSON.stringify(redacted)).not.toContain('"0.0000"');
  });
});

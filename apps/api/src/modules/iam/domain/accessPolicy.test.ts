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

  it('redactCosts omits dual-costing FIFO and WAC fields recursively when canViewCosts is false', () => {
    const policy = resolvePolicy(actor, { canViewCosts: false });
    const dto = {
      id: 'lot-1',
      unitCost: '4.2500',
      wacUnitCost: '4.1000',
      fifoValue: '42.5000',
      wacValue: '41.0000',
      totalFifoValue: '42.5000',
      totalWacValue: '41.0000',
      dispatchUnitCost: '4.2500',
      dispatchWacUnitCost: '4.1000',
      suggestedUnitCost: '4.0000',
      recentUnitCost: '4.2000',
      nested: {
        wacUnitCost: '4.1000',
        keep: 'visible',
      },
      slices: [
        {
          lotId: 'lot-1',
          quantityDelta: '-2.0000',
          unitCost: '4.2500',
          wacUnitCost: '4.1000',
        },
      ],
    };

    const redacted = policy.redactCosts(dto) as Record<string, unknown>;
    expect(redacted).toEqual({
      id: 'lot-1',
      nested: {
        keep: 'visible',
      },
      slices: [
        {
          lotId: 'lot-1',
          quantityDelta: '-2.0000',
        },
      ],
    });
  });

  describe('resolveLotPolicy cascade', () => {
    it('defaults to AUTO_FEFO, allowExpiredLotOverride: false, negativeStockPolicy: FLEXIBLE_UNASSIGNED', () => {
      const policy = resolvePolicy(actor);
      expect(policy.resolveLotPolicy()).toEqual({
        pickingMode: 'AUTO_FEFO',
        allowExpiredLotOverride: false,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });
    });

    it('resolves full USER -> ROLE -> LOCATION -> COMPANY precedence with field-level fallback', () => {
      const staffActor = { ...actor, id: 'user-staff-1', role: 'STAFF' as const };
      const policy = resolvePolicy(staffActor, {
        lotPolicies: [
          {
            scopeType: 'COMPANY',
            scopeId: '',
            pickingMode: 'MANUAL_OPTIONAL',
            allowExpiredLotOverride: false,
            negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
          },
          {
            scopeType: 'LOCATION',
            scopeId: 'loc-strict',
            pickingMode: 'MANUAL_REQUIRED',
            allowExpiredLotOverride: null,
            negativeStockPolicy: 'STRICT_BLOCK',
          },
          {
            scopeType: 'ROLE',
            scopeId: 'STAFF',
            pickingMode: null,
            allowExpiredLotOverride: true,
            negativeStockPolicy: null,
          },
          {
            scopeType: 'USER',
            scopeId: 'user-staff-1',
            pickingMode: 'AUTO_FEFO',
            allowExpiredLotOverride: null,
            negativeStockPolicy: null,
          },
        ],
      });

      // At loc-strict:
      // pickingMode: USER (AUTO_FEFO)
      // allowExpiredLotOverride: USER is null -> ROLE (true)
      // negativeStockPolicy: USER is null -> ROLE is null -> LOCATION (STRICT_BLOCK)
      expect(policy.resolveLotPolicy({ locationId: 'loc-strict' })).toEqual({
        pickingMode: 'AUTO_FEFO',
        allowExpiredLotOverride: true,
        negativeStockPolicy: 'STRICT_BLOCK',
      });

      // At loc-other (no LOCATION override):
      // negativeStockPolicy falls back to COMPANY (FLEXIBLE_UNASSIGNED)
      expect(policy.resolveLotPolicy({ locationId: 'loc-other' })).toEqual({
        pickingMode: 'AUTO_FEFO',
        allowExpiredLotOverride: true,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });
    });

    it('lets ROLE override LOCATION when USER has no override', () => {
      const managerActor = { ...actor, id: 'user-mgr-1', role: 'MANAGER' as const };
      const policy = resolvePolicy(managerActor, {
        lotPolicies: [
          {
            scopeType: 'COMPANY',
            scopeId: '',
            pickingMode: 'AUTO_FEFO',
            allowExpiredLotOverride: false,
            negativeStockPolicy: 'STRICT_BLOCK',
          },
          {
            scopeType: 'LOCATION',
            scopeId: 'loc-1',
            pickingMode: 'MANUAL_REQUIRED',
            allowExpiredLotOverride: false,
            negativeStockPolicy: 'STRICT_BLOCK',
          },
          {
            scopeType: 'ROLE',
            scopeId: 'MANAGER',
            pickingMode: 'MANUAL_OPTIONAL',
            allowExpiredLotOverride: true,
            negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
          },
        ],
      });

      expect(policy.resolveLotPolicy({ locationId: 'loc-1' })).toEqual({
        pickingMode: 'MANUAL_OPTIONAL',
        allowExpiredLotOverride: true,
        negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
      });
    });
  });
});

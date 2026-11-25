import {
  type ActorRole,
  ERROR_CODES,
  type EffectiveLotPolicy,
  ForbiddenError,
  type LotNegativeStockPolicy,
  type LotPickingMode,
  type LotPolicyScopeType,
} from '@iv2/shared-domain';

export type LocationScope =
  | { readonly allLocations: true }
  | { readonly locationIds: readonly string[] };

export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role?: ActorRole | undefined;
}

export interface LotPolicyRule {
  readonly scopeType: LotPolicyScopeType;
  readonly scopeId: string;
  readonly pickingMode: LotPickingMode | null;
  readonly allowExpiredLotOverride: boolean | null;
  readonly negativeStockPolicy: LotNegativeStockPolicy | null;
}

export interface AccessContext {
  readonly locationId?: string | undefined;
  readonly amount?: string | undefined;
  readonly quantity?: string | undefined;
  readonly pushesStockNegative?: boolean | undefined;
}

export interface AccessPolicy {
  readonly actor: Actor;
  readonly locationScope: LocationScope;
  readonly canViewCosts: boolean;
  assertCan(action: string, resource: string, context?: AccessContext): void;
  redactCosts<T>(dto: T): T;
  resolveLotPolicy(context?: { readonly locationId?: string | undefined }): EffectiveLotPolicy;
  canManualFefoOverride(context?: { readonly locationId?: string | undefined }): boolean;
}

export interface ResolvePolicyOverrides {
  readonly locationScope?: LocationScope | undefined;
  readonly canViewCosts?: boolean | undefined;
  readonly allowNegativeStock?: boolean | undefined;
  readonly deniedActions?: readonly string[] | undefined;
  readonly lotPolicies?: readonly LotPolicyRule[] | undefined;
}

const REDACTED_COST_KEYS = new Set([
  'unitCost',
  'weightedAverageCost',
  'totalValue',
  'wacUnitCost',
  'fifoValue',
  'wacValue',
  'totalFifoValue',
  'totalWacValue',
  'dispatchUnitCost',
  'dispatchWacUnitCost',
  'suggestedUnitCost',
  'recentUnitCost',
]);

const MANUAL_FEFO_OVERRIDE_ROLES = new Set<ActorRole>(['OWNER', 'SUPER_ADMIN', 'ADMIN', 'MANAGER']);

const DEFAULT_EFFECTIVE_LOT_POLICY: EffectiveLotPolicy = {
  pickingMode: 'AUTO_FEFO',
  allowExpiredLotOverride: false,
  negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
};

function stripCostKeys(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stripCostKeys);
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (REDACTED_COST_KEYS.has(key)) {
      continue;
    }
    result[key] = stripCostKeys(val);
  }
  return result;
}

function isLocationAllowed(scope: LocationScope, locationId: string): boolean {
  if ('allLocations' in scope && scope.allLocations) {
    return true;
  }
  if ('locationIds' in scope) {
    return scope.locationIds.includes(locationId);
  }
  return false;
}

export function resolvePolicy(actor: Actor, overrides?: ResolvePolicyOverrides): AccessPolicy {
  const locationScope: LocationScope = overrides?.locationScope ?? { allLocations: true };
  const canViewCosts = overrides?.canViewCosts ?? true;
  const allowNegativeStock = overrides?.allowNegativeStock ?? true;
  const deniedActions = new Set(overrides?.deniedActions ?? []);
  const lotPolicies = overrides?.lotPolicies ?? [];
  const actorRole: ActorRole = actor.role ?? 'OWNER';

  const policyIndex = new Map<string, LotPolicyRule>();
  for (const rule of lotPolicies) {
    policyIndex.set(`${rule.scopeType}:${rule.scopeId}`, rule);
  }

  return {
    actor,
    locationScope,
    canViewCosts,
    assertCan(action: string, resource: string, context?: AccessContext): void {
      if (deniedActions.has(`${action}:${resource}`) || deniedActions.has(action)) {
        throw new ForbiddenError(
          ERROR_CODES.FORBIDDEN,
          `Actor is not permitted to ${action} ${resource}`,
        );
      }

      if (context?.locationId !== undefined && !isLocationAllowed(locationScope, context.locationId)) {
        throw new ForbiddenError(
          ERROR_CODES.FORBIDDEN,
          'Actor does not have access to the requested location',
        );
      }

      if (context?.pushesStockNegative === true && !allowNegativeStock) {
        throw new ForbiddenError(
          ERROR_CODES.FORBIDDEN,
          'Actor is not permitted to push stock negative',
        );
      }
    },
    redactCosts<T>(dto: T): T {
      if (canViewCosts) {
        return dto;
      }
      return stripCostKeys(dto) as T;
    },
    resolveLotPolicy(context?: { readonly locationId?: string | undefined }): EffectiveLotPolicy {
      const candidates: Array<LotPolicyRule | undefined> = [
        policyIndex.get(`USER:${actor.id}`),
        policyIndex.get(`ROLE:${actorRole}`),
        context?.locationId ? policyIndex.get(`LOCATION:${context.locationId}`) : undefined,
        policyIndex.get('COMPANY:'),
      ];

      let pickingMode: LotPickingMode | undefined;
      let allowExpiredLotOverride: boolean | undefined;
      let negativeStockPolicy: LotNegativeStockPolicy | undefined;

      for (const rule of candidates) {
        if (!rule) continue;
        if (pickingMode === undefined && rule.pickingMode !== null) {
          pickingMode = rule.pickingMode;
        }
        if (allowExpiredLotOverride === undefined && rule.allowExpiredLotOverride !== null) {
          allowExpiredLotOverride = rule.allowExpiredLotOverride;
        }
        if (negativeStockPolicy === undefined && rule.negativeStockPolicy !== null) {
          negativeStockPolicy = rule.negativeStockPolicy;
        }
      }

      return {
        pickingMode: pickingMode ?? DEFAULT_EFFECTIVE_LOT_POLICY.pickingMode,
        allowExpiredLotOverride:
          allowExpiredLotOverride ?? DEFAULT_EFFECTIVE_LOT_POLICY.allowExpiredLotOverride,
        negativeStockPolicy:
          negativeStockPolicy ?? DEFAULT_EFFECTIVE_LOT_POLICY.negativeStockPolicy,
      };
    },
    canManualFefoOverride(context?: { readonly locationId?: string | undefined }): boolean {
      if (deniedActions.has('manual_override:stock_lot') || deniedActions.has('manual_override')) {
        return false;
      }
      if (context?.locationId !== undefined && !isLocationAllowed(locationScope, context.locationId)) {
        return false;
      }
      return MANUAL_FEFO_OVERRIDE_ROLES.has(actorRole);
    },
  };
}

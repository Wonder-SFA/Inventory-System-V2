import { ERROR_CODES, ForbiddenError } from '@iv2/shared-domain';

export type LocationScope =
  | { readonly allLocations: true }
  | { readonly locationIds: readonly string[] };

export interface Actor {
  readonly id: string;
  readonly email: string;
  readonly name: string;
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
}

export interface ResolvePolicyOverrides {
  readonly locationScope?: LocationScope | undefined;
  readonly canViewCosts?: boolean | undefined;
  readonly allowNegativeStock?: boolean | undefined;
  readonly deniedActions?: readonly string[] | undefined;
}

const REDACTED_COST_KEYS = new Set(['unitCost', 'weightedAverageCost', 'totalValue']);

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
  };
}

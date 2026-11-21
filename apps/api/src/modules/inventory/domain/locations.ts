import type { Database } from '@iv2/db';
import {
  ConflictError,
  type CreateLocationInput,
  ERROR_CODES,
  type ListLocationsQuery,
  type Location,
  NotFoundError,
  type UpdateLocationInput,
  ValidationError,
  uuidv7,
} from '@iv2/shared-domain';
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';
import {
  type DbTransaction,
  applyKeysetOrder,
  paginateKeysetResult,
} from '../../../shared/index.js';
import type { LocationScope } from '../../iam/public/index.js';
import { type LocationRow, locations } from '../db/index.js';

export type LocationReferenceChecker = (
  db: Database | DbTransaction,
  locationId: string,
) => Promise<boolean>;

const externalReferenceCheckers = new Set<LocationReferenceChecker>();

export function registerLocationReferenceChecker(checker: LocationReferenceChecker): () => void {
  externalReferenceCheckers.add(checker);
  return () => {
    externalReferenceCheckers.delete(checker);
  };
}

function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof err.code === 'string') {
    return err.code;
  }
  if (typeof err.cause?.code === 'string') {
    return err.cause.code;
  }
  return undefined;
}

export function toLocationDto(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? null,
    description: row.description ?? null,
    status: row.status,
    parentLocationId: row.parentLocationId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildScopeFilter(scope: LocationScope): { empty: boolean; condition?: SQL } {
  if ('allLocations' in scope && scope.allLocations) {
    return { empty: false };
  }
  if ('locationIds' in scope) {
    if (scope.locationIds.length === 0) {
      return { empty: true };
    }
    return { empty: false, condition: inArray(locations.id, [...scope.locationIds]) };
  }
  return { empty: true };
}

export async function listLocations(
  db: Database,
  scope: LocationScope,
  query: ListLocationsQuery,
): Promise<{ items: Location[]; nextCursor: string | null; hasMore: boolean }> {
  const scopeFilter = buildScopeFilter(scope);
  if (scopeFilter.empty) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const limit = query.limit ?? 50;
  const { orderBy, where: cursorWhere } = applyKeysetOrder(
    locations.createdAt,
    locations.id,
    query.cursor,
  );

  const conditions: SQL[] = [];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }
  if (query.status) {
    conditions.push(eq(locations.status, query.status));
  }
  if (cursorWhere) {
    conditions.push(cursorWhere);
  }

  const rows = await db
    .select()
    .from(locations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  return {
    items: page.items.map(toLocationDto),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function getLocationById(
  db: Database | DbTransaction,
  scope: LocationScope,
  id: string,
): Promise<Location | null> {
  const scopeFilter = buildScopeFilter(scope);
  if (scopeFilter.empty) {
    return null;
  }

  const conditions: SQL[] = [eq(locations.id, id)];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }

  const [row] = await db
    .select()
    .from(locations)
    .where(and(...conditions))
    .limit(1);

  return row ? toLocationDto(row) : null;
}

export async function getLocationsByIds(
  db: Database | DbTransaction,
  scope: LocationScope,
  ids: readonly string[],
): Promise<Location[]> {
  if (ids.length === 0) {
    return [];
  }
  const scopeFilter = buildScopeFilter(scope);
  if (scopeFilter.empty) {
    return [];
  }

  const conditions: SQL[] = [inArray(locations.id, [...ids])];
  if (scopeFilter.condition) {
    conditions.push(scopeFilter.condition);
  }

  const rows = await db
    .select()
    .from(locations)
    .where(and(...conditions));

  return rows.map(toLocationDto);
}

export async function hasLocationReferences(
  db: Database | DbTransaction,
  locationId: string,
): Promise<boolean> {
  const [child] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.parentLocationId, locationId))
    .limit(1);

  if (child) {
    return true;
  }

  for (const checker of externalReferenceCheckers) {
    if (await checker(db, locationId)) {
      return true;
    }
  }

  return false;
}

async function assertParentLocationValid(
  tx: DbTransaction,
  currentLocationId: string | null,
  parentLocationId: string,
): Promise<void> {
  if (currentLocationId && parentLocationId === currentLocationId) {
    throw new ValidationError(
      ERROR_CODES.LOCATION_CYCLE_DETECTED,
      'A location cannot be its own parent',
    );
  }

  const [parent] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.id, parentLocationId))
    .limit(1);

  if (!parent) {
    throw new ValidationError(
      ERROR_CODES.PARENT_LOCATION_NOT_FOUND,
      'Parent location does not exist',
    );
  }

  if (!currentLocationId) {
    return;
  }

  const cycleResult = await tx.execute<{ found: number }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_location_id, 1 AS depth
      FROM inventory.locations
      WHERE id = ${parentLocationId}
      UNION ALL
      SELECT l.id, l.parent_location_id, a.depth + 1
      FROM inventory.locations l
      INNER JOIN ancestors a ON l.id = a.parent_location_id
      WHERE a.depth < 100
    )
    SELECT 1 AS found
    FROM ancestors
    WHERE id = ${currentLocationId}
    LIMIT 1;
  `);

  if (cycleResult.rows.length > 0) {
    throw new ValidationError(
      ERROR_CODES.LOCATION_CYCLE_DETECTED,
      'Circular parent location hierarchy is not allowed',
    );
  }
}

export async function createLocation(
  tx: DbTransaction,
  input: CreateLocationInput,
): Promise<Location> {
  if (input.parentLocationId) {
    await assertParentLocationValid(tx, null, input.parentLocationId);
  }

  const now = new Date();
  const id = uuidv7();

  try {
    const [inserted] = await tx
      .insert(locations)
      .values({
        id,
        name: input.name,
        address: input.address ?? null,
        description: input.description ?? null,
        status: 'ACTIVE',
        parentLocationId: input.parentLocationId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return toLocationDto(inserted!);
  } catch (error) {
    if (getPgErrorCode(error) === '23505') {
      throw new ConflictError(
        ERROR_CODES.LOCATION_NAME_CONFLICT,
        `Location with name "${input.name}" already exists`,
      );
    }
    throw error;
  }
}

export async function updateLocation(
  tx: DbTransaction,
  id: string,
  input: UpdateLocationInput,
): Promise<Location> {
  const [existing] = await tx
    .select()
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.LOCATION_NOT_FOUND, `Location ${id} not found`);
  }

  if (input.parentLocationId !== undefined && input.parentLocationId !== null) {
    await assertParentLocationValid(tx, id, input.parentLocationId);
  }

  const now = new Date();
  try {
    const [updated] = await tx
      .update(locations)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.parentLocationId !== undefined
          ? { parentLocationId: input.parentLocationId }
          : {}),
        updatedAt: now,
      })
      .where(eq(locations.id, id))
      .returning();

    return toLocationDto(updated!);
  } catch (error) {
    if (getPgErrorCode(error) === '23505') {
      throw new ConflictError(
        ERROR_CODES.LOCATION_NAME_CONFLICT,
        `Location with name "${input.name}" already exists`,
      );
    }
    throw error;
  }
}

export async function setLocationStatus(
  tx: DbTransaction,
  id: string,
  status: 'ACTIVE' | 'ARCHIVED',
): Promise<Location> {
  const [updated] = await tx
    .update(locations)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(eq(locations.id, id))
    .returning();

  if (!updated) {
    throw new NotFoundError(ERROR_CODES.LOCATION_NOT_FOUND, `Location ${id} not found`);
  }

  return toLocationDto(updated);
}

export async function deleteLocation(
  tx: DbTransaction,
  id: string,
): Promise<{ id: string; deleted: true }> {
  const [existing] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.id, id))
    .limit(1);

  if (!existing) {
    throw new NotFoundError(ERROR_CODES.LOCATION_NOT_FOUND, `Location ${id} not found`);
  }

  if (await hasLocationReferences(tx, id)) {
    throw new ConflictError(
      ERROR_CODES.RESOURCE_IN_USE,
      'Location cannot be deleted because it has child locations or references; archive it instead',
    );
  }

  try {
    await tx.delete(locations).where(eq(locations.id, id));
  } catch (error) {
    if (getPgErrorCode(error) === '23503') {
      throw new ConflictError(
        ERROR_CODES.RESOURCE_IN_USE,
        'Location cannot be deleted because it is referenced by existing records; archive it instead',
      );
    }
    throw error;
  }

  return { id, deleted: true };
}

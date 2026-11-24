import type { Database } from '@iv2/db';
import {
  type ActorRole,
  type CursorPaginationQuery,
  ERROR_CODES,
  ForbiddenError,
  type IamAuditLog,
  type LotPolicy,
  type UpsertLotPolicyInput,
  uuidv7,
} from '@iv2/shared-domain';
import { and, asc, eq } from 'drizzle-orm';
import { applyKeysetOrder, paginateKeysetResult } from '../../../shared/http/pagination.js';
import type { DbTransaction } from '../../../shared/outbox/index.js';
import { iamAuditLogs, iamLotPolicies, iamUsers } from '../db/index.js';
import type { AccessPolicy } from './accessPolicy.js';

const LOT_POLICY_ADMIN_ROLES = new Set<ActorRole>(['OWNER', 'SUPER_ADMIN']);

export function assertCanManageLotPolicies(policy: AccessPolicy): void {
  const role: ActorRole = policy.actor.role ?? 'OWNER';
  if (!LOT_POLICY_ADMIN_ROLES.has(role)) {
    throw new ForbiddenError(
      ERROR_CODES.FORBIDDEN,
      'Only OWNER or SUPER_ADMIN can manage lot policies',
    );
  }
}

export async function getUserRole(db: Database, userId: string): Promise<ActorRole> {
  const [row] = await db
    .select({ role: iamUsers.role })
    .from(iamUsers)
    .where(eq(iamUsers.id, userId))
    .limit(1);

  return row?.role ?? 'OWNER';
}

function toLotPolicyDto(row: typeof iamLotPolicies.$inferSelect): LotPolicy {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    pickingMode: row.pickingMode,
    allowExpiredLotOverride: row.allowExpiredLotOverride,
    negativeStockPolicy: row.negativeStockPolicy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listLotPolicies(db: Database): Promise<LotPolicy[]> {
  const rows = await db
    .select()
    .from(iamLotPolicies)
    .orderBy(asc(iamLotPolicies.scopeType), asc(iamLotPolicies.scopeId));

  return rows.map(toLotPolicyDto);
}

export async function upsertLotPolicy(
  tx: DbTransaction,
  actorId: string,
  input: UpsertLotPolicyInput,
): Promise<LotPolicy> {
  const scopeId = input.scopeType === 'COMPANY' ? '' : input.scopeId;
  const [existing] = await tx
    .select()
    .from(iamLotPolicies)
    .where(
      and(eq(iamLotPolicies.scopeType, input.scopeType), eq(iamLotPolicies.scopeId, scopeId)),
    )
    .limit(1);

  const beforeState = existing ? toLotPolicyDto(existing) : null;
  const now = new Date();
  const pickingMode = input.pickingMode ?? null;
  const allowExpiredLotOverride = input.allowExpiredLotOverride ?? null;
  const negativeStockPolicy = input.negativeStockPolicy ?? null;

  const [saved] = await tx
    .insert(iamLotPolicies)
    .values({
      id: existing?.id ?? uuidv7(),
      scopeType: input.scopeType,
      scopeId,
      pickingMode,
      allowExpiredLotOverride,
      negativeStockPolicy,
      updatedBy: actorId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [iamLotPolicies.scopeType, iamLotPolicies.scopeId],
      set: {
        pickingMode,
        allowExpiredLotOverride,
        negativeStockPolicy,
        updatedBy: actorId,
        updatedAt: now,
      },
    })
    .returning();

  const afterState = toLotPolicyDto(saved!);

  await tx.insert(iamAuditLogs).values({
    id: uuidv7(),
    actorId,
    action: 'UPSERT_LOT_POLICY',
    resourceType: 'lot_policy',
    resourceId: `${input.scopeType}:${scopeId}`,
    beforeState,
    afterState,
  });

  return afterState;
}

export async function listAuditLogs(
  db: Database,
  query: CursorPaginationQuery = { limit: 50 },
): Promise<{ items: IamAuditLog[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = query.limit ?? 50;
  const { orderBy, where } = applyKeysetOrder(
    iamAuditLogs.createdAt,
    iamAuditLogs.id,
    query.cursor,
  );
  const rows = await db
    .select()
    .from(iamAuditLogs)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const page = paginateKeysetResult(rows, limit);
  return {
    items: page.items.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      beforeState: row.beforeState,
      afterState: row.afterState,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

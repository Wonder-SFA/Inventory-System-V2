import { createHash } from 'node:crypto';
import type { Database } from '@iv2/db';
import {
  type ApiSuccess,
  type ApiWarning,
  BadRequestError,
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  type UUID,
  uuidv5,
  uuidv7,
} from '@iv2/shared-domain';
import { eq, sql } from 'drizzle-orm';
import { idempotencyKeys, outboxEvents } from '../db/schema.js';
import type { DbTransaction, OutboxDispatcher } from '../outbox/outboxDispatcher.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessSwitchState = 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED';

export interface DomainEventInput {
  eventId?: UUID | undefined;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}

export interface CommandContext {
  correlationId: string;
  tx: DbTransaction;
  idempotencyKey: string | undefined;
  emit: (event: DomainEventInput) => Promise<void>;
  deriveLineIdempotencyKey: (lineId: string) => UUID;
}

export interface CommandHandlerResult<T> {
  data: T;
  warnings?: ApiWarning[] | undefined;
  statusCode?: number | undefined;
}

export interface CommandPermissionCheck {
  action: string;
  resource: string;
  context?: {
    locationId?: string | undefined;
    amount?: string | undefined;
    quantity?: string | undefined;
    pushesStockNegative?: boolean | undefined;
  } | undefined;
}

export interface CommandAccessPolicy {
  assertCan(
    action: string,
    resource: string,
    context?: CommandPermissionCheck['context'],
  ): void;
}

export interface CommandIntent<T> {
  actorId: string;
  method: string;
  path: string;
  payload: unknown;
  idempotencyKey?: string | undefined;
  requireIdempotencyKey?: boolean | undefined;
  statusCode?: number | undefined;
  accessPolicy?: CommandAccessPolicy | undefined;
  permission?: CommandPermissionCheck | undefined;
  authorize?: (() => Promise<void> | void) | undefined;
  handler: (ctx: CommandContext) => Promise<CommandHandlerResult<T>>;
}

export interface ExecuteCommandOptions {
  db: Database;
  outboxDispatcher?: OutboxDispatcher | undefined;
  requestId?: string | undefined;
  getAccessSwitch?: (() => Promise<AccessSwitchState> | AccessSwitchState) | undefined;
}

export interface ExecuteCommandResult<T> {
  statusCode: number;
  body: ApiSuccess<T>;
  replayed: boolean;
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function deriveLineIdempotencyKey(requestKey: string, lineId: string): UUID {
  if (!isValidUuid(requestKey)) {
    throw new BadRequestError(
      ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
      'Valid UUID Idempotency-Key is required to derive line idempotency key',
    );
  }
  return uuidv5(lineId, requestKey);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== undefined) {
      sorted[key] = canonicalize(val);
    }
  }
  return sorted;
}

export function computeRequestHash(method: string, path: string, payload: unknown): string {
  const canonical = JSON.stringify(canonicalize({ method, path, payload }));
  return createHash('sha256').update(canonical).digest('hex');
}

export async function executeCommand<T>(
  intent: CommandIntent<T>,
  options: ExecuteCommandOptions,
): Promise<ExecuteCommandResult<T>> {
  const requestId = options.requestId ?? `req_${uuidv7()}`;
  const requireKey = intent.requireIdempotencyKey ?? true;
  const rawKey = intent.idempotencyKey;

  if (requireKey && (!rawKey || !isValidUuid(rawKey))) {
    throw new BadRequestError(
      ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
      'Valid UUID Idempotency-Key header is required',
    );
  }

  if (rawKey !== undefined && !isValidUuid(rawKey)) {
    throw new BadRequestError(
      ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
      'Idempotency-Key header must be a valid UUID',
    );
  }

  const accessSwitch = options.getAccessSwitch ? await options.getAccessSwitch() : 'ACTIVE';
  if (accessSwitch === 'SUSPENDED') {
    throw new ForbiddenError(ERROR_CODES.ACCESS_SUSPENDED, 'Account access is suspended');
  }
  if (accessSwitch === 'READ_ONLY') {
    throw new ForbiddenError(
      ERROR_CODES.ACCESS_READ_ONLY,
      'Mutations are blocked while system is in read-only mode',
    );
  }

  if (intent.accessPolicy && intent.permission) {
    intent.accessPolicy.assertCan(
      intent.permission.action,
      intent.permission.resource,
      intent.permission.context,
    );
  }

  if (intent.authorize) {
    await intent.authorize();
  }

  const requestHash = computeRequestHash(intent.method, intent.path, intent.payload);
  let emittedCount = 0;

  const result = await options.db.transaction(async (tx) => {
    if (rawKey) {
      // Serialize concurrent requests sharing the same Idempotency-Key within PostgreSQL.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${rawKey}))`);

      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, rawKey))
        .limit(1);

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictError(
            ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
            'Idempotency-Key was already used with a different request payload',
          );
        }

        return {
          statusCode: existing.statusCode,
          body: existing.responseBody as ApiSuccess<T>,
          replayed: true,
        };
      }
    }

    const ctx: CommandContext = {
      correlationId: requestId,
      tx,
      idempotencyKey: rawKey,
      emit: async (event: DomainEventInput) => {
        emittedCount += 1;
        await tx.insert(outboxEvents).values({
          eventId: event.eventId ?? uuidv7(),
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
        });
      },
      deriveLineIdempotencyKey: (lineId: string) => {
        if (!rawKey) {
          throw new BadRequestError(
            ERROR_CODES.MISSING_IDEMPOTENCY_KEY,
            'Idempotency-Key is required to derive line idempotency key',
          );
        }
        return deriveLineIdempotencyKey(rawKey, lineId);
      },
    };

    const handlerResult = await intent.handler(ctx);
    const statusCode = handlerResult.statusCode ?? intent.statusCode ?? 200;
    const responseBody: ApiSuccess<T> = {
      data: handlerResult.data,
      ...(handlerResult.warnings && handlerResult.warnings.length > 0
        ? { warnings: handlerResult.warnings }
        : {}),
      meta: { requestId },
    };

    if (rawKey) {
      await tx.insert(idempotencyKeys).values({
        key: rawKey,
        actorId: intent.actorId,
        method: intent.method,
        path: intent.path,
        requestHash,
        statusCode,
        responseBody,
      });
    }

    return {
      statusCode,
      body: responseBody,
      replayed: false,
    };
  });

  if (!result.replayed && emittedCount > 0) {
    options.outboxDispatcher?.nudge();
  }

  return result;
}

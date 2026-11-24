import { BadRequestError, ERROR_CODES } from '@iv2/shared-domain';
import { type SQL, and, desc, eq, lt, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(JSON.stringify({ c: iso, i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('c' in parsed) ||
      !('i' in parsed) ||
      typeof (parsed as { c: unknown }).c !== 'string' ||
      typeof (parsed as { i: unknown }).i !== 'string'
    ) {
      throw new Error('Malformed cursor payload');
    }

    const { c, i } = parsed as { c: string; i: string };
    const date = new Date(c);
    if (Number.isNaN(date.getTime()) || !UUID_REGEX.test(i)) {
      throw new Error('Invalid cursor timestamp or id');
    }

    return { createdAt: date, id: i };
  } catch {
    throw new BadRequestError(ERROR_CODES.INVALID_CURSOR, 'Invalid pagination cursor');
  }
}

export function applyKeysetOrder<TCreatedAt extends PgColumn, TId extends PgColumn>(
  createdAtCol: TCreatedAt,
  idCol: TId,
  cursor?: string | undefined,
): { orderBy: readonly [SQL, SQL]; where: SQL | undefined } {
  const orderBy = [desc(createdAtCol), desc(idCol)] as const;
  if (!cursor) {
    return { orderBy, where: undefined };
  }
  const decoded = decodeCursor(cursor);
  const where = or(
    lt(createdAtCol, decoded.createdAt),
    and(eq(createdAtCol, decoded.createdAt), lt(idCol, decoded.id)),
  );
  return { orderBy, where };
}

export function paginateKeysetResult<T extends { createdAt: Date | string; id: string }>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor, hasMore };
}

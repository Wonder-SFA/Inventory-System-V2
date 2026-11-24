import { iamSchema } from '@iv2/db';
import type {
  ActorRole,
  LotNegativeStockPolicy,
  LotPickingMode,
  LotPolicyScopeType,
} from '@iv2/shared-domain';
import { boolean, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export type AccessSwitchState = 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED';

export const iamUsers = iamSchema.table('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').$type<ActorRole>().notNull().default('OWNER'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const iamSessions = iamSchema.table('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => iamUsers.id, { onDelete: 'cascade' }),
});

export const iamAccounts = iamSchema.table('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => iamUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const iamVerifications = iamSchema.table('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const iamSystemSettings = iamSchema.table('system_settings', {
  id: integer('id').primaryKey(),
  accessSwitch: text('access_switch').$type<AccessSwitchState>().notNull().default('ACTIVE'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const iamLotPolicies = iamSchema.table(
  'lot_policies',
  {
    id: uuid('id').primaryKey(),
    scopeType: text('scope_type').$type<LotPolicyScopeType>().notNull(),
    scopeId: text('scope_id').notNull().default(''),
    pickingMode: text('picking_mode').$type<LotPickingMode>(),
    allowExpiredLotOverride: boolean('allow_expired_lot_override'),
    negativeStockPolicy: text('negative_stock_policy').$type<LotNegativeStockPolicy>(),
    updatedBy: text('updated_by').references(() => iamUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('iam_lot_policies_scope_uidx').on(table.scopeType, table.scopeId)],
);

export const iamAuditLogs = iamSchema.table('audit_logs', {
  id: uuid('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

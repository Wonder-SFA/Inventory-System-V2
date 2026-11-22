import type { Database } from '@iv2/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { iamAccounts, iamSessions, iamUsers, iamVerifications } from '../db/index.js';

const DEV_FALLBACK_SECRET = 'iv2-dev-only-better-auth-secret-change-in-production';

export interface CreateAuthOptions {
  secret?: string | undefined;
  baseURL?: string | undefined;
  trustedOrigins?: string[] | undefined;
  nodeEnv?: string | undefined;
}

export function createAuth(db: Database, options: CreateAuthOptions = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const secret =
    options.secret ??
    process.env.BETTER_AUTH_SECRET ??
    (nodeEnv === 'production' ? undefined : DEV_FALLBACK_SECRET);

  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET must be set in production');
  }

  const baseURL = options.baseURL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3001';
  const trustedOrigins = options.trustedOrigins ?? [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'https://fighters-junction-revolution-cow.trycloudflare.com',
  ];

  return betterAuth({
    secret,
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: iamUsers,
        session: iamSessions,
        account: iamAccounts,
        verification: iamVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [bearer()],
    advanced: {
      useSecureCookies: nodeEnv === 'production',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

-- Better Auth tables scoped to iam schema + instance Access Switch singleton (ADR-0001, ADR-0003)

CREATE TABLE IF NOT EXISTS iam.users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS iam.sessions (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS iam_sessions_user_id_idx
  ON iam.sessions (user_id);

CREATE TABLE IF NOT EXISTS iam.accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS iam_accounts_user_id_idx
  ON iam.accounts (user_id);

CREATE TABLE IF NOT EXISTS iam.verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS iam_verifications_identifier_idx
  ON iam.verifications (identifier);

CREATE TABLE IF NOT EXISTS iam.system_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_switch TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (access_switch IN ('ACTIVE', 'READ_ONLY', 'SUSPENDED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO iam.system_settings (id, access_switch)
VALUES (1, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

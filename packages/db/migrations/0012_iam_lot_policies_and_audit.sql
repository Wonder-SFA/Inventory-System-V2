-- Cascading Lot-Picking & Negative-Stock Policies + IAM Audit Log + Actor Role (#16)

ALTER TABLE iam.users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'OWNER'
  CHECK (role IN ('OWNER', 'SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER'));

CREATE TABLE IF NOT EXISTS iam.lot_policies (
  id UUID PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('COMPANY', 'LOCATION', 'ROLE', 'USER')),
  scope_id TEXT NOT NULL DEFAULT '',
  picking_mode TEXT CHECK (picking_mode IN ('AUTO_FEFO', 'MANUAL_REQUIRED', 'MANUAL_OPTIONAL')),
  allow_expired_lot_override BOOLEAN,
  negative_stock_policy TEXT CHECK (negative_stock_policy IN ('FLEXIBLE_UNASSIGNED', 'STRICT_BLOCK')),
  updated_by TEXT REFERENCES iam.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT iam_lot_policies_scope_uidx UNIQUE (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS iam.audit_logs (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS iam_audit_logs_resource_created_idx
  ON iam.audit_logs (resource_type, resource_id, created_at DESC);

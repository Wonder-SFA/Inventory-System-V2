-- Opt-In Lot & Expiry Flags on SKU + Stock Lots, Lot Balances, and Dual-Costing Ledger (ADR-0009, #15)

ALTER TABLE catalog.skus
  ADD COLUMN IF NOT EXISTS track_lots BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS track_expiry BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT catalog_skus_track_expiry_requires_lots_chk CHECK (NOT track_expiry OR track_lots);

CREATE TABLE IF NOT EXISTS inventory.stock_lots (
  id UUID PRIMARY KEY,
  sku_id UUID NOT NULL REFERENCES catalog.skus(id) ON DELETE RESTRICT,
  lot_code TEXT NOT NULL,
  mfg_date DATE,
  exp_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_stock_lots_sku_lot_code_lower_uidx
  ON inventory.stock_lots (sku_id, LOWER(lot_code));

CREATE INDEX IF NOT EXISTS inventory_stock_lots_sku_exp_created_idx
  ON inventory.stock_lots (sku_id, exp_date, created_at);

CREATE TABLE IF NOT EXISTS inventory.stock_lot_balances (
  lot_id UUID NOT NULL REFERENCES inventory.stock_lots(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  on_hand NUMERIC(18, 4) NOT NULL DEFAULT 0,
  in_transit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18, 4) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lot_id, location_id)
);

CREATE INDEX IF NOT EXISTS inventory_stock_lot_balances_loc_lot_idx
  ON inventory.stock_lot_balances (location_id, lot_id);

ALTER TABLE inventory.stock_movements
  ADD COLUMN IF NOT EXISTS lot_id UUID REFERENCES inventory.stock_lots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS slice_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS movement_group_id UUID,
  ADD COLUMN IF NOT EXISTS wac_unit_cost NUMERIC(18, 4);

ALTER TABLE inventory.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_idempotency_key_key;

ALTER TABLE inventory.stock_movements
  ADD CONSTRAINT stock_movements_idempotency_key_slice_uidx UNIQUE (idempotency_key, slice_index);

CREATE INDEX IF NOT EXISTS inventory_stock_movements_lot_loc_created_idx
  ON inventory.stock_movements (lot_id, location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_stock_movements_group_id_idx
  ON inventory.stock_movements (movement_group_id);

-- Append-only Stock Movement ledger & projected Stock Balances (ADR-0002, ADR-0004, ADR-0005)

CREATE TABLE IF NOT EXISTS inventory.stock_movements (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN')),
  sku_id UUID NOT NULL REFERENCES catalog.skus(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  quantity_delta NUMERIC(18, 4) NOT NULL CHECK (quantity_delta <> 0),
  unit_cost NUMERIC(18, 4),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  reason_category TEXT,
  note TEXT,
  reference_type TEXT,
  reference_id UUID,
  actor_id TEXT NOT NULL,
  idempotency_key UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_stock_movements_sku_loc_created_idx
  ON inventory.stock_movements (sku_id, location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_stock_movements_ref_idx
  ON inventory.stock_movements (reference_type, reference_id);

CREATE INDEX IF NOT EXISTS inventory_stock_movements_created_id_idx
  ON inventory.stock_movements (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION inventory.prevent_stock_movement_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'inventory.stock_movements is append-only; UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_stock_movement_mutation ON inventory.stock_movements;
CREATE TRIGGER prevent_stock_movement_mutation
  BEFORE UPDATE OR DELETE ON inventory.stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION inventory.prevent_stock_movement_mutation();

CREATE TABLE IF NOT EXISTS inventory.stock_balances (
  sku_id UUID NOT NULL REFERENCES catalog.skus(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  on_hand NUMERIC(18, 4) NOT NULL DEFAULT 0,
  reserved NUMERIC(18, 4) NOT NULL DEFAULT 0,
  available NUMERIC(18, 4) GENERATED ALWAYS AS (on_hand - reserved) STORED,
  in_transit NUMERIC(18, 4) NOT NULL DEFAULT 0,
  weighted_average_cost NUMERIC(18, 4) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sku_id, location_id)
);

CREATE INDEX IF NOT EXISTS inventory_stock_balances_zero_or_neg_idx
  ON inventory.stock_balances (location_id, sku_id)
  WHERE on_hand <= 0 OR available <= 0;

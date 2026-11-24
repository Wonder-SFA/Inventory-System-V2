-- Movement-level picking & override flags for Manual Optional EOD reconciliation and Expired-Lot Overrides (#18)

ALTER TABLE inventory.stock_movements
  ADD COLUMN IF NOT EXISTS eod_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS expired_lot_override BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS override_reason TEXT;

CREATE INDEX IF NOT EXISTS inventory_stock_movements_eod_reconciliation_idx
  ON inventory.stock_movements (location_id, created_at DESC)
  WHERE eod_reconciliation_required = TRUE;

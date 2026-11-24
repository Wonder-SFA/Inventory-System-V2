-- Multi-Lot Transfer Orders & Short-Receipt Discrepancy Attribution (#19, Spec #14)

CREATE TABLE IF NOT EXISTS orders.transfer_order_line_lots (
  id UUID PRIMARY KEY,
  transfer_order_line_id UUID NOT NULL REFERENCES orders.transfer_order_lines(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES inventory.stock_lots(id) ON DELETE RESTRICT,
  dispatched_qty NUMERIC(18, 4) NOT NULL CHECK (dispatched_qty > 0),
  received_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  discrepancy_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (discrepancy_qty >= 0),
  dispatch_unit_cost NUMERIC(18, 4) NOT NULL,
  dispatch_wac_unit_cost NUMERIC(18, 4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  exp_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_transfer_order_line_lots_line_idx
  ON orders.transfer_order_line_lots (transfer_order_line_id);

CREATE INDEX IF NOT EXISTS orders_transfer_order_line_lots_lot_idx
  ON orders.transfer_order_line_lots (lot_id);

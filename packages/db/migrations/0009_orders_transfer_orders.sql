-- Transfer Orders (orders schema)

CREATE TABLE IF NOT EXISTS orders.transfer_orders (
  id UUID PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  source_location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  destination_location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  CHECK (source_location_id <> destination_location_id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN (
      'DRAFT',
      'CONFIRMED',
      'IN_TRANSIT',
      'PARTIALLY_RECEIVED',
      'RECEIVED',
      'CLOSED_WITH_DISCREPANCY',
      'CANCELLED'
    )
  ),
  version INT NOT NULL DEFAULT 1,
  note TEXT,
  discrepancy_reason TEXT CHECK (discrepancy_reason IN ('LOST', 'DAMAGED', 'OTHER')),
  discrepancy_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_transfer_orders_status_created_idx
  ON orders.transfer_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_transfer_orders_source_status_idx
  ON orders.transfer_orders (source_location_id, status);

CREATE INDEX IF NOT EXISTS orders_transfer_orders_dest_status_idx
  ON orders.transfer_orders (destination_location_id, status);

CREATE INDEX IF NOT EXISTS orders_transfer_orders_created_id_idx
  ON orders.transfer_orders (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS orders.transfer_order_lines (
  id UUID PRIMARY KEY,
  transfer_order_id UUID NOT NULL REFERENCES orders.transfer_orders(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES catalog.skus(id) ON DELETE RESTRICT,
  ordered_qty NUMERIC(18, 4) NOT NULL CHECK (ordered_qty > 0),
  dispatched_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  received_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  dispatch_unit_cost NUMERIC(18, 4),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_transfer_order_lines_to_idx
  ON orders.transfer_order_lines (transfer_order_id);

CREATE INDEX IF NOT EXISTS orders_transfer_order_lines_sku_idx
  ON orders.transfer_order_lines (sku_id);

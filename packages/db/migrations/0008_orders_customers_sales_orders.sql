-- Customers & Sales Orders (orders schema)

CREATE TABLE IF NOT EXISTS orders.customers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_customers_created_id_idx
  ON orders.customers (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS orders.sales_orders (
  id UUID PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES orders.customers(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'CONFIRMED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED')
  ),
  version INT NOT NULL DEFAULT 1,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_sales_orders_status_created_idx
  ON orders.sales_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_sales_orders_location_status_idx
  ON orders.sales_orders (location_id, status);

CREATE INDEX IF NOT EXISTS orders_sales_orders_created_id_idx
  ON orders.sales_orders (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS orders.sales_order_lines (
  id UUID PRIMARY KEY,
  sales_order_id UUID NOT NULL REFERENCES orders.sales_orders(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES catalog.skus(id) ON DELETE RESTRICT,
  ordered_qty NUMERIC(18, 4) NOT NULL CHECK (ordered_qty > 0),
  fulfilled_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (fulfilled_qty >= 0),
  returned_qty NUMERIC(18, 4) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  unit_price NUMERIC(18, 4) NOT NULL CHECK (unit_price >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_sales_order_lines_so_idx
  ON orders.sales_order_lines (sales_order_id);

CREATE INDEX IF NOT EXISTS orders_sales_order_lines_sku_idx
  ON orders.sales_order_lines (sku_id);

-- Catalog schema: Units of Measure, Products, and SKUs (ADR-0001, ADR-0002, DATABASE_DESIGN_GAPS §1.1, §2.3)

CREATE TABLE IF NOT EXISTS catalog.units_of_measure (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_units_of_measure_code_lower_uidx
  ON catalog.units_of_measure (LOWER(code));

CREATE UNIQUE INDEX IF NOT EXISTS catalog_units_of_measure_name_lower_uidx
  ON catalog.units_of_measure (LOWER(name));

CREATE INDEX IF NOT EXISTS catalog_units_of_measure_created_id_idx
  ON catalog.units_of_measure (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS catalog.products (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS catalog_products_status_created_id_idx
  ON catalog.products (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS catalog_products_created_id_idx
  ON catalog.products (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS catalog.skus (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  unit_of_measure_id UUID NOT NULL REFERENCES catalog.units_of_measure(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  default_selling_price NUMERIC(18, 4),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_skus_code_lower_uidx
  ON catalog.skus (LOWER(code));

CREATE INDEX IF NOT EXISTS catalog_skus_product_id_idx
  ON catalog.skus (product_id);

CREATE INDEX IF NOT EXISTS catalog_skus_unit_of_measure_id_idx
  ON catalog.skus (unit_of_measure_id);

CREATE INDEX IF NOT EXISTS catalog_skus_created_id_idx
  ON catalog.skus (created_at DESC, id DESC);

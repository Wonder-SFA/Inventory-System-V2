-- Physical Locations & Sub-Location Hierarchy Plug (ADR-0001, DATABASE_DESIGN_GAPS §2.3 & §2.5)

CREATE TABLE IF NOT EXISTS inventory.locations (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  parent_location_id UUID REFERENCES inventory.locations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_name_lower_uidx
  ON inventory.locations (LOWER(name));

CREATE INDEX IF NOT EXISTS inventory_locations_created_id_idx
  ON inventory.locations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS inventory_locations_parent_location_id_idx
  ON inventory.locations (parent_location_id)
  WHERE parent_location_id IS NOT NULL;

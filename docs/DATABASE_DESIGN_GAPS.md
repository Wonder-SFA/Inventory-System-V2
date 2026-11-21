# Database Design Gaps — Inventory System V2

> **Status:** Settled (All Items Q1–Q17 Resolved)  
> **Source:** Pre-implementation `/database-design` review of [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [ADR-0001](./adr/0001-modular-monolith-and-schema-isolation.md), [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), and [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md).  
> **Note:** All items across this document and [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md) are settled and reflected in `docs/adr/`, [GLOSSARY.md](../GLOSSARY.md), and [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md).

---

## 1. High-Impact Database Gaps (Resolve Before Phase 1 Coding)

### 1.1 Cross-Schema Referential Integrity (Foreign Keys vs. Logical IDs) — ✅ Settled (Q6)
- **Affects:** [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./adr/0001-modular-monolith-and-schema-isolation.md), [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md)
- **Gap / Risk:** ADR-0001 isolates each box into its own PostgreSQL schema (`catalog.*`, `inventory.*`, `orders.*`, `iam.*`), and the Blueprint requires hard-delete protection for SKUs/Products/Locations that have existing `StockMovement` or order records (`Active` / `Archived` lifecycle). Cross-schema SQL foreign keys (`inventory.stock_movements.sku_id -> catalog.skus.id`) tightly couple schema migrations and prevent future service extraction, whereas omitting cross-schema FKs removes database-level orphan protection on deletes.
- **Settled Decision (Option B — App Code Check + PostgreSQL Backup Lock):**
  - Keep module boundaries clean in application code: modules interact only via public TypeScript interfaces and check usage (`hasReferences()`) before deleting so used SKUs/Locations are archived cleanly.
  - Because each company runs a single dedicated PostgreSQL database (Q5), enforce `FOREIGN KEY ... ON DELETE RESTRICT` both **within** and **across** schemas inside PostgreSQL as a bulletproof backup lock against accidental deletion.

### 1.2 Primary Key Strategy & Timestamp Standard — ✅ Settled (Q7)
- **Affects:** [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0006: Offline Mobile Sync](./adr/0006-offline-mobile-physical-reality-wins.md)
- **Gap / Risk:** Neither the Blueprint nor ADRs specify primary key types (`UUIDv4` vs. `UUIDv7`/`ULID` vs. `BIGSERIAL`) or timestamp column types. Random `UUIDv4` keys cause B-tree index page fragmentation on high-volume append-only tables (`inventory.stock_movements`, `shared.outbox_events`), while `BIGSERIAL` IDs cannot be generated offline by the Phase 4 mobile app. Plain `TIMESTAMP` (without timezone) risks subtle local-time drift across containers and clients.
- **Settled Decision:**
  - Standardize on **`UUIDv7`** (time-sortable, globally unique, Phase 4 offline-safe) for all domain entities and `inventory.stock_movements`.
  - Keep server-only **`BIGSERIAL`** for monotonic event ordering on `shared.outbox_events.seq_id` (Q2).
  - Mandate **`TIMESTAMPTZ`** (stored in UTC) for all `created_at` / `updated_at` / event timestamps.

### 1.3 Drizzle Multi-Schema Migrations & Better Auth Coexistence — ✅ Settled (Q9)
- **Affects:** [ADR-0001](./adr/0001-modular-monolith-and-schema-isolation.md), [ADR-0003: TypeScript Monorepo & Core Stack](./adr/0003-typescript-monorepo-and-core-stack.md)
- **Gap / Risk:** `packages/db` must manage per-module PostgreSQL schemas (`catalog`, `inventory`, `orders`, `iam`, `shared`) alongside Better Auth's PostgreSQL-backed sessions. Without explicit schema scoping in Drizzle and Better Auth's adapter config, `drizzle-kit` migrations can dump tables into `public` or collide with Better Auth's generated/migrated tables.
- **Settled Decision:**
  - Define every module's tables using Drizzle's `pgSchema('<module>')` in `apps/api/src/modules/<box>/db/schema.ts` and aggregate schema exports cleanly for `drizzle-kit` with an explicit `schemaFilter` in `drizzle.config.ts`.
  - Configure Better Auth's Drizzle adapter explicitly against the `iam.*` schema tables so `iam` owns auth/session tables within the single Drizzle migration pipeline.

### 1.4 `StockBalance` Upsert Locking & `available` Column Integrity — ✅ Settled (Q8a, Q8b & Q8c)
- **Affects:** [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [ARCHITECTURE_REVIEW_GAPS.md §2.1](./ARCHITECTURE_REVIEW_GAPS.md#2-medium-impact-considerations)
- **Gap / Risk:**
  1. Storing `available` as a manually updated column alongside `on_hand` and `reserved` risks silent drift if any code path updates one without recalculating the other.
  2. Running `SELECT ... FOR UPDATE` on `inventory.stock_balances` for a `(sku_id, location_id)` pair that does not yet exist locks zero rows in PostgreSQL, creating a race condition where two concurrent first-time movements collide on insert.
- **Settled Decisions:**
  - **Composite PK & `available` Column (Q8a — ✅ Settled, Option A):** Composite primary key `(sku_id, location_id)` on `inventory.stock_balances`, with `available` defined as `GENERATED ALWAYS AS (on_hand - reserved) STORED`.
  - **First-Time Row Creation (Q8b — ✅ Settled, Option A):** Create-if-missing via `INSERT INTO inventory.stock_balances (...) VALUES (...) ON CONFLICT (sku_id, location_id) DO NOTHING` immediately before acquiring `SELECT ... FOR UPDATE` locks.
  - **Multi-SKU Lock Ordering (Q8c — ✅ Settled):** Deterministically sort `(sku_id, location_id)` pairs before acquiring `SELECT ... FOR UPDATE` locks so concurrent multi-line orders cannot deadlock.

---

## 2. Medium-Impact Database Considerations

*(Complements [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md), which tracks Numeric Precision `NUMERIC(18, 4)` + 4-decimal guardrail [✅ Q4], Multi-Consumer Outbox Checkpoints [✅ Q2], Isolated DB per Company + Access Switch [✅ Q5], Deterministic Lock Ordering [✅ Q8c], `idempotency_key` [✅ Q10], "Tap on the Shoulder" Live Updates + Local Docker Phase 1 [✅ Q16], and ESLint Boundary Enforcement [✅ Q17].)*

| # | Status | Area | Affects | Risk / Tension | Settled Decision |
|---|--------|------|---------|----------------|------------------|
| 2.1 | ✅ Settled | **Composite & Partial Index Strategy** *(Q15)* | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0004](./adr/0004-flexible-negative-stock-policy.md) | Missing or poorly ordered indexes degrade ledger history lookups, order queues, and Zero/Negative stock exception screens as data grows. | **Settled:** Include Phase 1 composite & partial indexes: `stock_movements (sku_id, location_id, created_at DESC)`, `stock_movements (reference_type, reference_id)`, `UNIQUE (idempotency_key)`; partial index `stock_balances (location_id, sku_id) WHERE on_hand <= 0 OR available <= 0`; `orders (status, created_at DESC)` and `orders (location_id, status)`. |
| 2.2 | ✅ Settled | **DB-Level Append-Only Enforcement** *(Q11)* | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md) | Immutability of `inventory.stock_movements` (and later `iam.audit_logs`) relies solely on application discipline; an ad-hoc script or bug could `UPDATE`/`DELETE` ledger history. | **Settled:** Add a PostgreSQL `BEFORE UPDATE OR DELETE` trigger on append-only tables (`inventory.stock_movements` in Phase 1, and `iam.audit_logs` when added) that raises an exception. |
| 2.3 | ✅ Settled | **Case-Insensitive Uniqueness & Archive Reuse** *(Q12a / Q12b)* | [Blueprint §4](./ARCHITECTURE_BLUEPRINT.md#catalog--locations-catalog--inventory) | Standard `UNIQUE` on SKU `code` or `Location.name` allows `'SKU-01'` and `'sku-01'` duplicates, and it is undecided whether archiving a SKU frees its code for reuse. | **Settled:** Functional unique indexes `UNIQUE (LOWER(code))` on SKUs and `UNIQUE (LOWER(name))` on Locations; **never** reuse archived SKU codes (un-archive if the exact same product returns). |
| 2.4 | ✅ Settled | **Order Line `CHECK` Constraints & Over-Receiving** *(Q13)* | [Blueprint §4](./ARCHITECTURE_BLUEPRINT.md#order-workflows--edge-cases-orders--inventory) | Negative line quantities or fulfilled counts exceeding expectations can corrupt order status transitions unless constrained; PO over-receiving policy is unsettled. | **Settled:** Add `CHECK (ordered_qty > 0)` and `CHECK (fulfilled_qty >= 0)` on order lines; allow supplier Purchase Order over-receiving (`fulfilled_qty > ordered_qty`) with a UI confirmation warning; strictly cap customer Sales Orders at `ordered_qty`. |
| 2.5 | ✅ Settled | **Phase 1 Costing Promotion & Sub-Location Plug** *(Q14)* | [Blueprint §3–4](./ARCHITECTURE_BLUEPRINT.md#3-mandatory-phase-1-extension-points-plugs), [ADR-0005](./adr/0005-per-location-weighted-average-cost.md) | Adding sub-locations or cost tracking later requires backfills or schema churn if baseline columns are omitted in Phase 1. | **Settled:** **Promote full cost & profit tracking into Phase 1** (`unit_cost NUMERIC(18, 4)`, `currency CHAR(3)`, per-location WAC, valuation & profit tracking active from day one). Keep nullable `parent_location_id` (self-FK) on `inventory.locations` as a Phase 1 plug for Phase 2 sub-locations. |

---

## 3. Next Steps

1. **All architecture, database, and API design gaps (Q1–Q17 + API Q1–Q8) are settled** across [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md), [API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md), and this file, and patched into `docs/adr/`, [GLOSSARY.md](../GLOSSARY.md), and [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md).
2. **`/api-patterns` settled** in [API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md) and [ADR-0008](./adr/0008-rest-api-contract-idempotency-and-sse.md) (Fastify REST `/api/v1/*`, multi-line idempotency, uniform envelopes/cursor pagination, same-origin proxy, and invalidation-only SSE contract).
3. Proceed to `/to-spec` → `/to-tickets` to produce the buildable Phase 1 specification and implementation issues.

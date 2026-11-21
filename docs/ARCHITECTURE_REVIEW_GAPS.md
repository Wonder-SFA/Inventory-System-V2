# Architecture Review Gaps — Inventory System V2

> **Status:** Open / Unresolved  
> **Source:** Pre-implementation `/architect-review` of [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [GLOSSARY.md](../GLOSSARY.md), and [ADR-0001 through ADR-0007](./adr/README.md).  
> **Note:** The ADRs themselves (`docs/adr/`) and `ARCHITECTURE_BLUEPRINT.md` have **not** been patched yet. Use this document in a fresh chat to settle decisions and apply updates.

---

## 1. High-Impact Gaps (Resolve Before Phase 1 Coding)

### 1.1 Cross-Module Transaction Boundaries (`orders` ↔ `inventory`)
- **Affects:** [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./adr/0001-modular-monolith-and-schema-isolation.md)
- **Gap / Risk:** ADR-0001 requires modules to communicate only via public TypeScript interfaces *and* guarantees that database locks and stock consistency stay inside a single PostgreSQL transaction boundary. When `orders` confirms a Sales Order (updating `orders.*` and reserving stock in `inventory.*`) or receives a Purchase Order, separate module transactions risk partial commits if a crash occurs between them.
- **Candidate Fix:** Define a lightweight `TransactionContext` (passing Drizzle's `tx` handle explicitly or via `AsyncLocalStorage`) on mutating public module interfaces so `orders` + `inventory` + `outbox` commit atomically while preserving schema ownership.

### 1.2 Multi-Consumer Outbox Design & Idempotency
- **Affects:** [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./adr/0002-append-only-stock-ledger-and-outbox.md)
- **Gap / Risk:** A single `processed_at` flag on an outbox table breaks when multiple independent consumers (`reporting`, SSE broadcaster, and future Accounting/POS adapters) read at different speeds. In addition, at-least-once delivery without consumer deduplication will double-count inventory valuation in `reporting`.
- **Candidate Fix:**
  - Store events in an append-only `shared.outbox_events` table with monotonic `BIGSERIAL` sequence IDs in `packages/db`.
  - Track progress **per consumer** (e.g., `reporting.event_checkpoints` storing `last_event_id`) and enforce idempotent processing keyed by `eventId`.

### 1.3 Weighted Average Cost (WAC) Math Under Negative Stock
- **Affects:** [ADR-0004: Flexible Negative Stock Policy](./adr/0004-flexible-negative-stock-policy.md), [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md)
- **Gap / Risk:** ADR-0004 allows `On-Hand Stock` to go negative, while ADR-0005 recalculates WAC using `(oldQty * oldWac + receivedQty * unitCost) / (oldQty + receivedQty)`. Receiving `5` units when `oldQty = -5` causes **division by zero** (`newQty = 0`), and receiving into negative balances distorts average cost.
- **Candidate Fix:** Codify negative-stock WAC rules in ADR-0005:
  - When `oldQty <= 0` and `newQty > 0`: reset WAC to the incoming `unitCost`.
  - When `newQty <= 0`: preserve `lastKnownWac` (never divide by zero or a negative quantity).

### 1.4 Exact Numeric Precision for Quantities & Money
- **Affects:** [GLOSSARY.md](../GLOSSARY.md), [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md)
- **Gap / Risk:** Fractional Units of Measure (`kg`, `L`) combined with `unitCost`, `Weighted Average Cost`, and `Cash Balance` will suffer IEEE-754 floating-point rounding drift if stored or computed as JavaScript `number`.
- **Candidate Fix:** Standardize on PostgreSQL `NUMERIC(18, 4)` (or integer minor units for currency) in `packages/db` and represent quantities/money as decimal strings or a fixed-precision decimal library (e.g., `decimal.js` or `big.js`) in `packages/shared-domain`.

---

## 2. Medium-Impact Considerations

| # | Area | Affects | Risk / Tension | Candidate Fix |
|---|------|---------|----------------|---------------|
| 2.1 | **Multi-Line Order Deadlocks** | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md) | Concurrent orders locking overlapping `(skuId, locationId)` rows in `StockBalance` in different sequences can deadlock in PostgreSQL. | Sort `(skuId, locationId)` pairs deterministically before acquiring `SELECT ... FOR UPDATE` locks. |
| 2.2 | **Phase 1 Write Idempotency** | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0006](./adr/0006-offline-mobile-physical-reality-wins.md) | Client idempotency keys are planned for Phase 4 mobile sync, leaving Phase 1 web double-clicks/retries exposed to duplicate `StockMovement` writes. | Add a unique `idempotency_key` (`UUID`) column to `inventory.stock_movements` from Phase 1. |
| 2.3 | **SaaS / Multi-Tenancy Path** | [Blueprint](./ARCHITECTURE_BLUEPRINT.md) | Retrofitting `tenant_id` into every table and `UNIQUE` constraint (e.g., `sku_code`) later is invasive. | Decide now whether to include a default single-org `tenant_id` column in Phase 1 schemas or explicitly defer it as a known future migration cost. |
| 2.4 | **SSE on Cloud Run** | [ADR-0007](./adr/0007-portable-containerized-cloud-hosting.md) | Cloud Run caps request lifetimes (default 5 min, max 60 min), terminating long-lived SSE streams during recycles. | Design Phase 4 SSE around `Last-Event-ID` reconnection from day one so container recycles recover seamlessly. |
| 2.5 | **Module Boundary Enforcement** | [ADR-0001](./adr/0001-modular-monolith-and-schema-isolation.md) | Cross-module isolation currently relies on developer discipline rather than automated checks. | Enforce `modules/<other>/public`-only imports via ESLint (`no-restricted-imports` / `eslint-plugin-boundaries`) in Phase 1 CI. |

---

## 3. How to Use This Document in a Fresh Chat

1. Point the new session at `docs/ARCHITECTURE_REVIEW_GAPS.md` and run **`/grill-with-docs`** to decide each item and patch `docs/adr/` and `docs/ARCHITECTURE_BLUEPRINT.md`.
2. Once the gaps are settled and documented, proceed to **`/to-spec`** (and consider **`/database-design`** + **`/api-patterns`**) to produce the buildable Phase 1 specification.

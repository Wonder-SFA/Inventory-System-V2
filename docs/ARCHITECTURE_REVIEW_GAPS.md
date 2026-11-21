# Architecture Review Gaps — Inventory System V2

> **Status:** Settled (All Items Q1–Q17 Resolved)  
> **Source:** Pre-implementation `/architect-review` of [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [GLOSSARY.md](../GLOSSARY.md), and [ADR-0001 through ADR-0007](./adr/README.md).  
> **Note:** All architectural and database design gaps across this document and [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md) are settled and reflected in `docs/adr/`, `docs/ARCHITECTURE_BLUEPRINT.md`, and `GLOSSARY.md`.

---

## 1. High-Impact Gaps (Resolve Before Phase 1 Coding)

### 1.1 Cross-Module Transaction Boundaries (`orders` ↔ `inventory`) — ✅ Settled (Q1)
- **Affects:** [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./adr/0001-modular-monolith-and-schema-isolation.md)
- **Gap / Risk:** ADR-0001 requires modules to communicate only via public TypeScript interfaces *and* guarantees that database locks and stock consistency stay inside a single PostgreSQL transaction boundary. When `orders` confirms a Sales Order (updating `orders.*` and reserving stock in `inventory.*`) or receives a Purchase Order, separate module transactions risk partial commits if a crash occurs between them.
- **Settled Decision (Option A — Shared Envelope):** Define a lightweight `TransactionContext` (passing Drizzle's `tx` handle explicitly) on mutating public module interfaces so `orders.*`, `inventory.*`, and `shared.outbox_events` commit atomically in one PostgreSQL transaction while preserving schema ownership.

### 1.2 Multi-Consumer Outbox Design & Idempotency — ✅ Settled (Q2)
- **Affects:** [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./adr/0002-append-only-stock-ledger-and-outbox.md)
- **Gap / Risk:** A single `processed_at` flag on an outbox table breaks when multiple independent consumers (`reporting`, SSE broadcaster, and future Accounting/POS adapters) read at different speeds. In addition, at-least-once delivery without consumer deduplication will double-count inventory valuation in `reporting`.
- **Settled Decision:**
  - Store events in an append-only `shared.outbox_events` table with server-assigned monotonic `BIGSERIAL` `seq_id` (`1, 2, 3…`) in `packages/db`.
  - Track progress **per consumer** (e.g., `reporting.event_checkpoints` storing `last_event_id`) and enforce idempotent processing keyed by `event_id`.

### 1.3 Weighted Average Cost (WAC) Math Under Negative Stock — ✅ Settled (Q3)
- **Affects:** [ADR-0004: Flexible Negative Stock Policy](./adr/0004-flexible-negative-stock-policy.md), [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md)
- **Gap / Risk:** ADR-0004 allows `On-Hand Stock` to go negative, while ADR-0005 recalculates WAC using `(oldQty * oldWac + receivedQty * unitCost) / (oldQty + receivedQty)`. Receiving `5` units when `oldQty = -5` causes **division by zero** (`newQty = 0`), and receiving into negative balances distorts average cost.
- **Settled Decision (Option A — Flagged Provisional Cost):** Codify negative-stock WAC rules in ADR-0005:
  - When `oldQty <= 0` and `newQty > 0`: reset WAC to the incoming `unitCost`.
  - When `newQty <= 0`: preserve `lastKnownWac` (never divide by zero or a negative quantity) **and visibly flag any `<= 0` row on the Valuation Report as `"Estimated — Negative Stock"`** until reconciled.

### 1.4 Exact Numeric Precision for Quantities & Money — ✅ Settled (Q4)
- **Affects:** [GLOSSARY.md](../GLOSSARY.md), [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md)
- **Gap / Risk:** Fractional Units of Measure (`kg`, `L`) combined with `unitCost`, `Weighted Average Cost`, and `Cash Balance` will suffer IEEE-754 floating-point rounding drift if stored or computed as JavaScript `number`.
- **Settled Decision:** Standardize on PostgreSQL `NUMERIC(18, 4)` in `packages/db` and represent quantities/money as decimal strings computed via a fixed-precision decimal library in `packages/shared-domain`, **plus a strict UI & API validation guardrail rejecting any user input with more than 4 decimal places**.

---

## 2. Medium-Impact Considerations

| # | Status | Area | Affects | Risk / Tension | Decision / Candidate Fix |
|---|--------|------|---------|----------------|--------------------------|
| 2.1 | ✅ Settled | **Multi-Line Order Deadlocks** *(Q8c)* | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md) | Concurrent orders locking overlapping `(skuId, locationId)` rows in `StockBalance` in different sequences can deadlock in PostgreSQL. | **Settled:** Deterministically sort `(sku_id, location_id)` pairs before acquiring `SELECT ... FOR UPDATE` locks (never alters UI/invoice line order). |
| 2.2 | ✅ Settled | **Phase 1 Write Idempotency** *(Q10)* | [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0006](./adr/0006-offline-mobile-physical-reality-wins.md) | Client idempotency keys are planned for Phase 4 mobile sync, leaving Phase 1 web double-clicks/retries exposed to duplicate `StockMovement` writes. | **Settled:** Add a unique `idempotency_key` (`UUID`) column on `inventory.stock_movements` starting in **Phase 1** (protects web double-clicks/retries immediately and is ready for Phase 4 mobile sync). |
| 2.3 | ✅ Settled | **SaaS / Multi-Tenancy Path** *(Q5 / Q5b)* | [Blueprint](./ARCHITECTURE_BLUEPRINT.md) | Retrofitting `tenant_id` into every table and `UNIQUE` constraint (e.g., `sku_code`) later is invasive. | **Settled:** Isolated app instance + separate PostgreSQL database per company (single-tenant architecture, **no `tenant_id` column**), managed by a future **Developer Control Panel** for subscriptions/billing, plus an **`iam` Access Switch** hook (`Active` / `Read-Only` / `Suspended`, defaulting to `Active` in Phase 1). |
| 2.4 | ✅ Settled | **Live Screen Updates & Hosting** *(Q16)* | [ADR-0007](./adr/0007-portable-containerized-cloud-hosting.md) | Long-lived streams can drop during Wi-Fi blips, local server reboots, or future Cloud Run recycles. | **Settled:** Use **"Tap on the Shoulder"** live updates (lightweight SSE invalidation ping + quiet background refetch; one quiet refresh on reconnect — zero idle traffic). **Phase 1 hosts locally on an old PC via Docker Compose**; cloud hosting (Cloud Run) moves to a later phase. |
| 2.5 | ✅ Settled | **Module Boundary Enforcement** *(Q17)* | [ADR-0001](./adr/0001-modular-monolith-and-schema-isolation.md) | Cross-module isolation currently relies on developer discipline rather than automated checks. | **Settled:** Enforce `modules/<other>/public`-only imports via ESLint (`no-restricted-imports` / `eslint-plugin-boundaries`) in Phase 1 CI. |

---

## 3. Next Steps

1. **All architecture, database, and API design gaps (Q1–Q17 + API Q1–Q8) are settled** across this file, [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md), and [API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md), and patched into `docs/adr/`, [GLOSSARY.md](../GLOSSARY.md), and [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md).
2. **`/api-patterns` settled** in [API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md) and [ADR-0008](./adr/0008-rest-api-contract-idempotency-and-sse.md) (Fastify REST `/api/v1/*`, multi-line idempotency, uniform envelopes/cursor pagination, same-origin proxy, and invalidation-only SSE contract).
3. Proceed to **`/to-spec`** → **`/to-tickets`** to produce the buildable Phase 1 specification and implementation issues.

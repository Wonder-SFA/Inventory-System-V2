# Deep Module Seams — Inventory System V2

> **Status:** Settled (All Items D1–D5 Resolved)  
> **Source:** Pre-implementation `/improve-codebase-architecture` + `/grill-with-docs` review of [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md), [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md), [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md), and [docs/adr/README.md](./adr/README.md).  
> **Note:** Per [domain-modeling](../.agents/skills/domain-modeling/SKILL.md), D1–D5 refine the module seams inside our existing 8 ADRs without adding a ninth ADR. [GLOSSARY.md](../GLOSSARY.md) remains intentionally free of implementation details.

---

## 1. Settled Deep Module Seams (D1–D5)

### 1.1 Mutating Command Seam (`executeCommand`) — ✅ Settled (D1 · `local-substitutable`)
- **Location:** `apps/api/src/shared/command/`
- **Problem:** Across 15+ mutating routes (`catalog`, `inventory`, `orders`, and later `finance`), forcing each caller to manually check the `iam` Access Switch, invoke `authorize()`, open a raw Drizzle transaction (`tx`), coordinate `shared.idempotency_keys`, derive per-line UUIDv5 keys, and append `shared.outbox_events` leaks security and atomicity ceremony across every module seam.
- **Settled Seam & Depth:**
  - Introduce one deep `executeCommand` module in `shared` that wraps every mutating operation behind a small interface (`executeCommand(intent, idempotencyKey)`).
  - Internally enforces: `iam` Access Switch (`403 ACCESS_READ_ONLY` / `ACCESS_SUSPENDED`), `AccessPolicy.assertCan()`, a single PostgreSQL transaction boundary (hiding raw Drizzle `tx` handles behind a narrow unit-of-work context), `shared.idempotency_keys` replay/conflict lock (`409 IDEMPOTENCY_KEY_CONFLICT`), deterministic per-line UUIDv5 key derivation, and `ctx.emit(event)` atomic appends to `shared.outbox_events` (triggering an immediate in-memory wakeup to `OutboxDispatcher` on commit).
- **Test Surface:** Integration tests invoke `executeCommand` directly against a local PostgreSQL / PGLite stand-in to verify auth, rollback, idempotency replay, and atomic outbox emission together.

### 1.2 `inventory` Stock Ledger & Transfer Cost Seam — ✅ Settled (D2 · `local-substitutable`)
- **Location:** `apps/api/src/modules/inventory/public/` (backing `inventory/domain/`)
- **Problem:** Exposing fine-grained balance upserts, lock sorting, movement insertion, and WAC formulas across `inventory/public` leaks deadlock ordering and `Weighted Average Cost` edge cases into `orders`. Furthermore, if a `Transfer Order` is received at Location B after Location A's `Weighted Average Cost` changes while goods are `In-Transit Stock`, reading live WAC on receipt records the wrong unit cost at Location B.
- **Settled Seam & Depth:**
  - Deepen `inventory/public` around coarse, batch domain intents: `reserveStock`, `releaseReservation`, `postMovements`, `dispatchTransfer`, and `receiveTransfer`.
  - Hide missing-row balance upserts (`INSERT ... ON CONFLICT DO NOTHING`), deterministic `(sku_id, location_id)` sorting before `SELECT ... FOR UPDATE`, immutable `Stock Movement` appends, per-location `Weighted Average Cost` math (including negative-stock reset and `"Estimated — Negative Stock"` markers), Phase 2 `Allow Negative Stock` enforcement, and Zero/Negative Stock warnings inside `inventory`.
  - **`Transfer Order` Cost Snapshot:** `dispatchTransfer` snapshots the sending Location's `Weighted Average Cost` onto the `TRANSFER_OUT` `Stock Movement` / dispatch record so `receiveTransfer` always adds `On-Hand Stock` at the receiving Location at the exact dispatch cost, even if the sending Location receives new stock before arrival.
- **Test Surface:** Concurrency, deadlock-freedom, negative-stock WAC, and `Transfer Order` cost-carryover tests exercise `inventory/public` directly.

### 1.3 `iam` Request-Scoped `AccessPolicy` & Compile-Time `LocationScope` — ✅ Settled (D3 · `in-process`)
- **Location:** `apps/api/src/modules/iam/public/` (consumed by `inventory`, `orders`, `reporting`, SSE, and response serialization)
- **Problem:** A write-only boolean `authorize(actor, action, resource)` check leaves Phase 2 `Location` read filtering and `View Costs & Prices` field stripping scattered across query callers and serializers, where one missed filter leaks restricted Location stock or supplier costs.
- **Settled Seam & Depth:**
  - Deepen `iam/public` into a request-scoped `AccessPolicy` resolved once per request (`iam.resolvePolicy(actor)`).
  - The module encapsulates three responsibilities behind one seam:
    1. **Mutation Gate:** `assertCan(action, resource, { locationId?, amount?, quantity?, pushesStockNegative? })` enforcing permissions, optional limits, and `Allow Negative Stock`.
    2. **Compile-Time `LocationScope` Token:** `policy.locationScope` (`{ allLocations: true } | { locationIds: readonly UUID[] }`) is a mandatory parameter on every location-scoped query interface in `inventory/public`, `orders/public`, `reporting/public`, and SSE topic filtering—making an unscoped query a compile-time TypeScript error.
    3. **Centralized Cost Redaction:** `policy.redactCosts(dto)` omits `unitCost`, `weightedAverageCost`, and `totalValue` keys in one place when `View Costs & Prices` is false (never substituting `"0.0000"`).
  - Phase 1 resolves `allLocations: true` + `canViewCosts: true`; Phase 2 swaps in role/Location rules inside `iam` with zero read-endpoint rewrites.
- **Test Surface:** The full 5-role (`Owner`, `Admin`, `Manager`, `Staff`, `Viewer`) permission, limit, Location-scoping, and cost-redaction matrix runs purely in-process.

### 1.4 Fixed-Precision `Decimal4` & `Weighted Average Cost` Module — ✅ Settled (D4 · `in-process`)
- **Location:** `packages/shared-domain/src/decimal/` (shared by `apps/api`, `apps/web`, and Phase 4 `apps/mobile`)
- **Problem:** Passing raw decimal strings across modules invites lexicographical string comparison bugs (`"9.0000" > "10.0000"`), inconsistent 4-decimal rounding, and duplicated `Weighted Average Cost` negative-stock branches.
- **Settled Seam & Depth:**
  - Encapsulate branded `Quantity`, `UnitCost`, and `Money` value types, `zDecimal4` Zod schemas (rejecting inputs with `> 4` decimal places with `422 DECIMAL_PRECISION_EXCEEDED`), canonical 4-decimal string serialization, safe arithmetic and comparison helpers (hiding the underlying decimal library behind the module interface), and pure `calculateWeightedAverageCost(oldQty, oldWac, receivedQty, unitCost)` implementing the ADR-0005 negative-stock reset (`oldQty <= 0 && newQty > 0`) and provisional preservation (`newQty <= 0`) rules.
- **Test Surface:** Fast, dependency-free property and boundary tests cover rounding, comparisons, overflow bounds, and negative-stock WAC transitions in-process.

### 1.5 `OutboxDispatcher` & Wakeup Adapters — ✅ Settled (D5 · `ports & adapters`)
- **Location:** `apps/api/src/shared/outbox/` (serving SSE broadcaster, Phase 3 `reporting`, and Phase 5 external Accounting/POS adapters)
- **Problem:** Having each consumer independently poll `shared.outbox_events`, advance `event_checkpoints`, and deduplicate `event_id` duplicates checkpoint plumbing, creates idle DB polling on the Phase 1 local PC, and forces flaky `sleep()` timers in tests.
- **Settled Seam & Depth:**
  - Deepen a single `OutboxDispatcher` module in `shared` that owns `shared.outbox_events` cursor reads (`seq_id > last_event_id`), per-consumer `event_checkpoints` transactions, `event_id` idempotent deduplication, exponential backoff retries, and a synchronous `drainOutbox()` helper for tests.
  - Downstream consumers register a single `handle(event, tx)` handler without touching outbox SQL.
  - Two internal wakeup adapters sit behind an internal seam: (1) immediate in-memory nudge triggered on `executeCommand` commit (zero idle polling in Phase 1 single-container Docker), and (2) PostgreSQL `LISTEN/NOTIFY` + low-frequency fallback poll when running multiple API instances on Cloud Run.
- **Test Surface:** Integration tests commit commands and call `drainOutbox()` synchronously to assert consumer side effects without timers.

---

## 2. Next Steps

1. All pre-code **architecture** ([ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md)), **database** ([DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md)), **API** ([API_DESIGN_GAPS.md](./API_DESIGN_GAPS.md)), and **deep module seam** (this document) decisions are settled and aligned with [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md) and `docs/adr/` ([README](./adr/README.md)).
2. Proceed to **`/to-spec`** → **`/to-tickets`** to produce the buildable Phase 1 specification and implementation issues.

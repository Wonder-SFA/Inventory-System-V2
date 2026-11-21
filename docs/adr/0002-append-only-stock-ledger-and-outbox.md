# ADR-0002: Append-Only Stock Ledger & Transactional Outbox

**Status:** Accepted
**Date:** 2026-11-21

## Context

Inventory accuracy breaks down when stock counts are overwritten directly in place—there is no audit trail of *why* a shelf count changed, concurrent edits overwrite each other, and downstream features (Valuation Reports, live screen updates, offline mobile sync, and external Accounting/POS adapters) miss updates if notifications fail after a database save.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Overwrite a single `quantity` column in place** | Simple CRUD updates | No built-in movement history, hard to reconcile discrepancies, prone to silent overwrites |
| **Append-only ledger + in-memory event emitter** | Full stock history | Events are lost if the server crashes right after committing the database change |
| **Append-only `StockMovement` ledger + projected `StockBalance` + same-transaction Outbox** | Full bank-statement audit trail, fast reads, and guaranteed event delivery | Slightly more write-path structure upfront |

## Decision & Rationale

We will model stock using an **append-only `StockMovement` ledger** paired with a **projected `StockBalance` table** and a **durable transactional outbox (Saved Event Log)**:

1. **Append-only movements & DB immutability:** Stock quantities are never edited in place. Every change appends an immutable `StockMovement` (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`) with reason category, reference, actor, `UUIDv7` primary key, `TIMESTAMPTZ` (UTC) timestamp, and a unique `idempotency_key` (`UUID`) from Phase 1 (protecting web double-clicks/retries immediately and serving Phase 4 offline mobile sync; multi-line order actions pair request-level `shared.idempotency_keys` stored in the same transaction with deterministic per-line UUIDv5 movement keys per [ADR-0008](./0008-rest-api-contract-idempotency-and-sse.md)). A PostgreSQL `BEFORE UPDATE OR DELETE` trigger on `inventory.stock_movements` (and later `iam.audit_logs`) raises an exception to guarantee immutability at the database layer.
2. **Projected balances & concurrency safety:** `inventory.stock_balances` uses a composite primary key `(sku_id, location_id)` with `available` defined as `GENERATED ALWAYS AS (on_hand - reserved) STORED` (alongside `on_hand`, `reserved`, and `in_transit`). Before updating balances, the write path:
   - Ensures rows exist via `INSERT INTO inventory.stock_balances (...) VALUES (...) ON CONFLICT (sku_id, location_id) DO NOTHING`.
   - Deterministically sorts `(sku_id, location_id)` pairs before acquiring `SELECT ... FOR UPDATE` locks so concurrent multi-line orders cannot deadlock.
3. **Phase 1 performance indexes:** Explicitly maintain `stock_movements (sku_id, location_id, created_at DESC)`, `stock_movements (reference_type, reference_id)`, `UNIQUE (idempotency_key)`, and a partial index `stock_balances (location_id, sku_id) WHERE on_hand <= 0 OR available <= 0`.
4. **Multi-consumer Transactional Outbox:** Every stock movement and order status change writes its domain event (`StockReceived`, `StockIssued`, `StockAdjusted`, `OrderConfirmed`, etc.) into an append-only `shared.outbox_events` table with a server-assigned monotonic `BIGSERIAL` `seq_id` (`1, 2, 3…`) in the **same PostgreSQL transaction**. `shared`'s `OutboxDispatcher` (per [MODULE_SEAMS.md](../MODULE_SEAMS.md)) centralizes cursor reads, per-consumer checkpoint transactions (e.g., `reporting.event_checkpoints` storing `last_event_id`), idempotent `event_id` deduplication, internal wakeup adapters (in-memory commit nudge + PostgreSQL `LISTEN/NOTIFY`/fallback poll), and a synchronous `drainOutbox()` test helper so independent consumers (`reporting`, SSE broadcaster, future Accounting/POS adapters) register a single handler without duplicating checkpoint plumbing.

## Consequences

- **Positive:** Complete, tamper-resistant "bank-statement" history for every SKU at every Location.
- **Positive:** Zero lost events between database commits and downstream consumers (`reporting`, SSE, future integrations).
- **Negative:** Fixing a mistake requires posting a compensating movement (or adjustment), not editing past records.
- **Risks & Mitigations:** Over years of heavy volume, summing raw movements could slow down if queried directly; maintaining the projected `StockBalance` table keeps daily reads constant-time.

## Related Decisions

- [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./0001-modular-monolith-and-schema-isolation.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)
- [ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions](./0006-offline-mobile-physical-reality-wins.md)
- [ADR-0008: REST API Contract, Multi-Line Idempotency & Invalidation SSE](./0008-rest-api-contract-idempotency-and-sse.md)

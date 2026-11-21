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

1. **Append-only movements:** Stock quantities are never edited in place. Every change appends an immutable `StockMovement` (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`) with reason category, reference, actor, and timestamp.
2. **Projected balances:** A `StockBalance` record per `(skuId, locationId)` maintains `onHand`, `reserved`, `available` (`onHand - reserved`), and `inTransit` inside the same transaction for fast screen reads and safe row locking under concurrent updates.
3. **Transactional Outbox:** Every stock movement and order status change writes its domain event (`StockReceived`, `StockIssued`, `StockAdjusted`, `OrderConfirmed`, etc.) in the **same PostgreSQL transaction** so `reporting`, SSE live updates, and future Accounting/POS adapters consume every change reliably.

## Consequences

- **Positive:** Complete, tamper-resistant "bank-statement" history for every SKU at every Location.
- **Positive:** Zero lost events between database commits and downstream consumers (`reporting`, SSE, future integrations).
- **Negative:** Fixing a mistake requires posting a compensating movement (or adjustment), not editing past records.
- **Risks & Mitigations:** Over years of heavy volume, summing raw movements could slow down if queried directly; maintaining the projected `StockBalance` table keeps daily reads constant-time.

## Related Decisions

- [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./0001-modular-monolith-and-schema-isolation.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)
- [ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions](./0006-offline-mobile-physical-reality-wins.md)

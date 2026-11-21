# ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions

**Status:** Accepted
**Date:** 2026-11-21

## Context

Phase 4 introduces a native mobile app for warehouse scanning (receiving, shipping, transfers, and stock counts). Warehouse Wi-Fi and cellular coverage frequently drop between aisles or loading bays. If the mobile app blocks scanning when offline—or rejects queued scans when reconnecting because an office user edited or cancelled an order in the meantime—physical shelf counts drift away from the ledger.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Online-only scanning** | Zero offline sync conflicts | Warehouse staff freeze whenever Wi-Fi drops |
| **Offline queue that rejects conflicting scans on reconnect** | Keeps server state strictly clean automatically | Physical goods were already moved or loaded onto a truck; rejecting the record creates silent phantom stock |
| **Offline queue where Physical Reality Wins + Manager Exception flags** | Operations never pause and ledger always reflects real physical movement | Requires an office Manager Exception workflow to resolve paperwork clashes |

## Decision & Rationale

We will design Phase 4 mobile scanning around an **offline-first queue where Physical Reality Wins**:

1. **Never halt scanning:** Workers queue barcode/QR scan movements locally on the mobile device during connectivity drops.
2. **Replay into the ledger on reconnect:** When connectivity returns, queued movements replay into the append-only `StockMovement` ledger and are **never rejected** just because server state changed while offline.
3. **Flag a Manager Exception on clash:** If a replayed scan conflicts with current server state (for instance, the Sales Order was cancelled at the office or `On-Hand Stock` dips negative), the system accepts the physical movement and automatically flags a **Manager Exception** for office paperwork reconciliation.

## Consequences

- **Positive:** The ledger always matches what physically happened on the warehouse floor, even during network outages.
- **Positive:** Pairs naturally with our append-only ledger (ADR-0002) and flexible negative stock policy (ADR-0004).
- **Negative:** Managers must review and clear flagged exceptions when concurrent office edits collide with offline scans.
- **Risks & Mitigations:** Duplicate tap/retry submissions during flaky connections could double-count stock; reuse the unique `UUIDv7` primary keys and unique `idempotency_key` (`UUID`) column on `inventory.stock_movements` (present from Phase 1 per ADR-0002) on every queued mobile movement.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)

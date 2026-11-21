# ADR-0004: Flexible Negative Stock Policy

**Status:** Accepted
**Date:** 2026-11-21

## Context

In real warehouse and store operations, physical stock is sometimes sitting on the shelf even when paperwork has not caught up yet (for example, a supplier shipment arrived but was not yet recorded in the system). If the system strictly refuses every sale or issue when recorded stock hits zero, urgent customer orders stall at the counter or loading dock. At the same time, allowing silent negative stock without accountability hides inventory errors.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Strict hard block whenever stock reaches zero** | Prevents negative ledger counts | Halts real-world sales and shipments whenever paperwork lags behind physical shelves |
| **Allow negative stock silently for everyone** | Never blocks operations | Negative counts go unnoticed and staff can accidentally drive stock negative without oversight |
| **Flexible negative stock with warning + visible marker (permission-gated in Phase 2)** | Never halts urgent operations while surfacing every discrepancy for cleanup | Requires discipline to reconcile flagged Zero/Negative items |

## Decision & Rationale

We will use a **flexible negative stock policy** enforced in two layers:

1. **Phase 1 (Warning + Visible Marker):** Both `Available Stock` and `On-Hand Stock` are allowed to drop below zero. Whenever either hits `<= 0`, the system immediately warns the user and places a visible **Zero / Negative Stock** marker on that `(skuId, locationId)` record so it surfaces in follow-up reconciliation and the Low-Stock report.
2. **Phase 2 (Role-Gated Override):** The `Allow Negative Stock` permission checkbox in `iam` determines who can push stock below zero. Users without that permission are blocked; authorized users proceed with the warning and marker.

## Consequences

- **Positive:** Operations never grind to a halt over delayed receiving entries while still keeping every discrepancy visible.
- **Positive:** Phase 2 seamlessly adds accountability without changing `inventory` ledger rules.
- **Negative:** Negative balances can temporarily exist in reports and require careful cost/valuation math until reconciled.
- **Risks & Mitigations:** Unchecked negative balances could linger indefinitely; mitigate by surfacing Zero / Negative markers prominently on stock lists and in the Low-Stock & Reorder Report.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0005: Per-Location Weighted Average Cost](./0005-per-location-weighted-average-cost.md)
- [ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions](./0006-offline-mobile-physical-reality-wins.md)

# ADR-0005: Per-Location Weighted Average Cost

**Status:** Accepted
**Date:** 2026-11-21

## Context

Phase 3 Reporting & Analytics introduces Inventory Valuation. Different Locations may acquire stock at different landed/purchase costs or receive stock via internal Transfer Orders. Additionally, if Phase 1 does not capture purchase costs on receipts, Phase 3 would require painful historical cost backfilling.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **FIFO (First-In, First-Out) cost layers** | Tracks exact batch/layer cost | Complex lot/layer splitting on partial shipments, returns, adjustments, and negative stock |
| **Company-wide single average cost per SKU** | Simpler single number per SKU | Hides real cost differences between Locations and loses accuracy when transferring stock |
| **Weighted Average Cost stored per Location (with Company-wide UI toggle)** | Clean math, accurate per-site margins, and transfers carry sending Location's cost | Slightly more state per `(skuId, locationId)` than a single company-wide number |

## Decision & Rationale

We will value On-Hand Stock using **Weighted Average Cost stored per Location**, supported by two rules:

1. **Optional `unitCost` from Phase 1:** Purchase Order lines and `RECEIPT` stock movements accept an optional `unitCost` and currency starting in Phase 1 so Phase 3 has clean historical cost data without backfilling.
2. **Per-Location Storage + Company-Wide Toggle:** The `reporting` module stores and updates Weighted Average Cost per `(skuId, locationId)`—so internal Transfer Orders carry the sending Location's cost—while offering a UI toggle to view either **Per-Location** or **Company-wide** average cost, plus hover formula popovers showing the exact calculation. Access to dollar cost columns is gated by `iam`'s `View Costs & Prices` permission.

## Consequences

- **Positive:** Avoids complex FIFO layer tracking while remaining accurate across multi-location transfers and flexible negative stock.
- **Positive:** Formula popovers build trust in valuation numbers without overwhelming the screen.
- **Negative:** Early receipts entered without `unitCost` in Phase 1 will not contribute cost data unless updated/adjusted later.
- **Risks & Mitigations:** Staff without cost permissions should never see supplier costs; enforce `View Costs & Prices` centrally in both API responses and UI/export columns.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)

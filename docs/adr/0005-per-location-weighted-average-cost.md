# ADR-0005: Per-Location Weighted Average Cost

**Status:** Accepted
**Date:** 2026-11-21

## Context

Inventory System V2 includes **full cost and profit tracking from Phase 1** (moved forward from Phase 3 so unit costs, per-location valuation, and margins are accurate from day one without historical backfilling). Different Locations may acquire stock at different landed/purchase costs or receive stock via internal Transfer Orders.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **FIFO (First-In, First-Out) cost layers** | Tracks exact batch/layer cost | Complex lot/layer splitting on partial shipments, returns, adjustments, and negative stock |
| **Company-wide single average cost per SKU** | Simpler single number per SKU | Hides real cost differences between Locations and loses accuracy when transferring stock |
| **Weighted Average Cost stored per Location (with Company-wide UI toggle)** | Clean math, accurate per-site margins, and transfers carry sending Location's cost | Slightly more state per `(skuId, locationId)` than a single company-wide number |

## Decision & Rationale

We will value On-Hand Stock using **Weighted Average Cost stored per Location** starting in **Phase 1**, supported by three rules:

1. **Active Cost & Precision Tracking from Phase 1:** Purchase Order lines and `RECEIPT` stock movements capture `unit_cost` (`NUMERIC(18, 4)`) and `currency` (`CHAR(3)`) in Phase 1, with full cost, valuation, and profit tracking active from day one. All cost and quantity math is encapsulated inside the `Decimal4` value module (`Quantity`, `UnitCost`, `Money`, and pure `calculateWeightedAverageCost()`) in `packages/shared-domain` (never raw string comparisons or JS floats, per [MODULE_SEAMS.md](../MODULE_SEAMS.md)), backed by UI & API validation rejecting inputs exceeding 4 decimal places.
2. **Negative-Stock WAC Guardrail:**
   - When `oldQty <= 0` and `newQty > 0`: reset WAC to the incoming `unitCost`.
   - When `newQty <= 0`: preserve `lastKnownWac` (never divide by zero or a negative quantity) and visibly flag any `<= 0` row on the Valuation Report as `"Estimated — Negative Stock"` until reconciled.
3. **Per-Location Storage + Company-Wide Toggle:** Weighted Average Cost is stored and updated per `(skuId, locationId)`—and `Transfer Order` dispatch (`dispatchTransfer` in `inventory/public`) snapshots the sending Location's `Weighted Average Cost` onto the `TRANSFER_OUT` dispatch record so `In-Transit Stock` preserves the exact dispatch cost even if the sending Location's WAC later changes—while offering a UI toggle to view either **Per-Location** or **Company-wide** average cost, plus hover formula popovers showing the exact calculation. Access to dollar cost columns is enforced centrally by `AccessPolicy.redactCosts()` (`View Costs & Prices` when RBAC activates in Phase 2).

## Consequences

- **Positive:** Avoids complex FIFO layer tracking while remaining accurate across multi-location transfers and flexible negative stock.
- **Positive:** Formula popovers build trust in valuation numbers without overwhelming the screen.
- **Negative:** Early receipts entered without `unitCost` in Phase 1 will not contribute cost data unless updated/adjusted later.
- **Risks & Mitigations:** Staff without cost permissions should never see supplier costs; enforce `View Costs & Prices` centrally in both API responses and UI/export columns.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)

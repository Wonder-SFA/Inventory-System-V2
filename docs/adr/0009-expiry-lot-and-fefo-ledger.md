# ADR-0009: Expiry Lot & FEFO Ledger with Dual Costing

**Status:** Accepted
**Date:** 2026-11-24

## Context

Inventory System V2 previously tracked stock balances strictly at the `(skuId, locationId)` level, valuing On-Hand Stock with Per-Location Weighted Average Cost (WAC) per [ADR-0005](./0005-per-location-weighted-average-cost.md). However, perishable goods, pharmaceuticals, and regulated inventory require batch/lot identity, expiry date tracking, First-Expired, First-Out (FEFO) allocation, and lot-specific FIFO COGS valuation.

Simultaneously, we must avoid slowing down high-volume non-perishable operations, retain flexibility when physical deliveries outpace paperwork ([ADR-0004](./0004-flexible-negative-stock-policy.md)), and protect the append-only stock movement ledger ([ADR-0002](./0002-append-only-stock-ledger-and-outbox.md)).

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Replace WAC entirely with Lot FIFO globally** | Single unified valuation model | Imposes heavy lot maintenance overhead on non-perishables (hardware, dry goods) and breaks backward compatibility |
| **Keep WAC for all valuation, Lots purely for physical FEFO** | Preserves existing financial math | Hides real margin differences between high-cost and low-cost supplier batches |
| **Dual Costing (Lot FIFO + Per-Location WAC) with Opt-in SKU Tracking** | Accurate lot-level margins, zero friction for non-lot SKUs, full UI toggling | Requires recording both cost values on movement records |

## Decision & Rationale

We adopt **Dual Costing with Opt-In Lot & Expiry Tracking**, governed by the following architectural rules:

1. **Opt-In per SKU & Data Hierarchy:**
   - SKUs declare `track_lots` (boolean) and `track_expiry` (boolean). Non-lot SKUs continue using standard `stock_balances` without lot overhead.
   - Global Lot identity is stored in `inventory.stock_lots (id, sku_id, lot_code, mfg_date, exp_date, created_at)` with `UNIQUE(sku_id, LOWER(lot_code))`.
   - Balances are tracked per location in `inventory.stock_lot_balances (lot_id, location_id, on_hand, reserved, available, unit_cost)`.
   - Access visibility is location-scoped via `iam` location permissions.

2. **Flat Append-Only Movement Ledger (`inventory.stock_movements`):**
   - Each movement row represents a single lot slice (nullable `lot_id` directly on `stock_movements`). Multi-lot splits emit multiple rows.
   - To support multi-slice FEFO splits idempotently, the uniqueness constraint is updated to `UNIQUE(idempotency_key, slice_index)` where `slice_index` defaults to 0.
   - Rows share a common `reference_line_id` / `movement_group_id` for UI grouping and order-line traceability.
   - Both cost snapshots (`unit_cost` representing Lot/FIFO layer cost and `wac_unit_cost` representing Per-Location WAC at movement time) are persisted immutably on each row.

3. **Cascading Batch-Picking Policy:**
   - Batch selection follows a 3-level cascade configured by Super Admin/Owner: **Company Default → Location Override → Role/User Override**.
   - Modes:
     - `AUTO_FEFO`: Automatically allocates earliest-expiring lots first.
     - `MANUAL_REQUIRED`: Picker must explicitly designate batches (prevents unassigned drift).
     - `MANUAL_OPTIONAL`: Picker can allocate batches or leave unassigned (`lot_id = NULL`) for fast counter/walk-in checkouts.
   - Expired-lot overrides require explicit `iam` permission.

4. **FEFO Allocation & Tie-Breaking:**
   - Allocates earliest `exp_date` first.
   - Tie-breaker for identical expiry dates: Oldest received date first (FIFO by `created_at`).
   - If `track_expiry` is false, `exp_date` is nullable and allocation defaults to pure FIFO.

5. **Repeat Receipts of Same `(sku_id, lot_code)`:**
   - Conflicting `exp_date` on an existing lot code is strictly rejected as a data-entry guardrail.
   - If incoming `unit_cost` differs on a repeat delivery at a Location, the lot's active shelf `unit_cost` at that Location is blended via weighted average. (Future extension: hidden FIFO receipt sub-layers via Settings toggle, tracked in issue #13).

6. **Reservation Timing:**
   - When a Sales Order confirms, stock reservation is held at the `(sku_id, location_id)` level.
   - Exact batch/lot allocation occurs at fulfillment/dispatch time, keeping pre-dispatch line edits lock-free.

7. **Cutover & Existing Shelf Stock (Best-of-Both Hybrid):**
   - When turning `track_lots = true` on a SKU with existing `on_hand > 0`, the system presents a **Guided Opening Split modal** (with recent PO cost suggestions) to declare actual physical batches.
   - Users may 1-click **"Skip & Drain Old Stock First"** (Prospective Cutover), keeping existing stock in `lot_id = NULL`. Outgoing orders drain unlotted stock first before touching new tracked lots.

8. **Reporting & Defaults:**
   - Valuation and EOD Gross Margin reports default to **Lot/FIFO Cost** for lot-tracked SKUs and **Per-Location WAC** for non-lot SKUs.
   - A single-click UI toggle switches the entire report view to **Per-Location WAC**.

## Consequences

- **Positive:** Full audit compliance, accurate batch traceability, zero expired-stock blind spots, and flexible counter checkouts.
- **Positive:** Non-perishable SKUs experience zero overhead or schema pollution.
- **Negative:** Multi-lot issues generate multiple `stock_movements` rows, requiring composite index tuning and UI aggregation.
- **Negative:** Dual cost tracking requires persisting both WAC and lot unit costs on outbound transactions.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)
- [ADR-0005: Per-Location Weighted Average Cost](./0005-per-location-weighted-average-cost.md)

# 005: Phased Roadmap & Module Extension Points

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [003: Modular Architecture & Feature Box Boundaries](./003-modular-architecture-and-boundaries.md), [004: Phase 1 (MVP) Workflows & Data Model](./004-phase-1-mvp-workflows-and-data-model.md)

## Question

In what order should Features #2, #4, #5, #6, and #7 be added after Phase 1, and what exact extension points (events, hooks, or adapter interfaces) must exist in the Phase 1 blueprint so each future phase plugs in cleanly?

## Resolution

Locked in the **Phase 1 extension points ("plugs")** and a **flexible default post-MVP roadmap**:

1. **Flexible Default Roadmap (with natural dependency reminders):**
   Because every future feature sits in its own isolated box behind Phase 1's extension points, priorities can be reordered later without rewriting Phase 1. When planning future rollouts, document and remind the team of the recommended default sequence and its two natural dependencies:
   - **Phase 2:** **Role-Based Permissions (#7)** & **SKU & Barcode/QR Management (#2)** — lock down who can adjust stock/approve orders and add barcode scanning first.
   - **Phase 3:** **Reporting & Analytics (#4)** — inventory valuation, turnover metrics, and exports.
   - **Phase 4:** **Cloud Access & Mobile Apps (#6)** — live multi-user updates and mobile/tablet scanning *(naturally builds on Barcodes #2)*.
   - **Phase 5:** **Accounting & POS Integration (#5)** — external financial/POS sync *(safest after Permissions #7 and Reporting/Valuation #4 are settled)*.

2. **Mandatory Phase 1 Extension Points ("Plugs"):**
   - **Permission Gate (`iam`):** Every mutating action in `catalog`, `inventory`, and `orders` passes through a single `authorize(actor, action, resource)` check. In Phase 1, any authenticated user passes; in Phase 2+, role rules swap in without modifying order or stock code.
   - **Saved Event Log / Outbox (`inventory` & `orders`):** Every stock movement and order status change writes a durable domain event record inside the same database transaction (e.g., `StockReceived`, `StockIssued`, `StockAdjusted`, `OrderConfirmed`). Reporting (#4), live UI updates (#6), and Accounting/POS sync (#5) consume this feed reliably without missing updates.
   - **Flexible SKU Lookup (`catalog`):** `catalog` exposes a lookup interface by `skuId` or `code` so barcode/QR aliases (#2) plug in later without changing how `orders` or `inventory` reference a SKU.
   - **Optional Unit Cost on Receipts (`orders` & `inventory`):** Purchase Order lines and `RECEIPT` stock movements include an optional `unitCost` (and currency) field from day one so Phase 3 Reporting & Valuation (#4) has clean cost history without backfilling.

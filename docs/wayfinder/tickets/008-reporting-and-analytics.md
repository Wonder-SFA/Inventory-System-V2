# 008: Reporting & Analytics (Feature #4)

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [005: Phased Roadmap & Module Extension Points](./005-phased-roadmap-and-extension-points.md), [006: Role-Based Permissions (Feature #7)](./006-role-based-permissions.md)

## Question

Which inventory valuation method (e.g., FIFO vs. Weighted Average Cost), turnover/aging metrics, dashboard views, and export formats (CSV/PDF/Excel) should consume the saved event log and unit cost history? *(Note: Phase 3 in the flexible default roadmap; can be reprioritized if needed.)*

## Resolution

Locked the Phase 3 **Reporting & Analytics** design for the `reporting` feature box:

1. **Inventory Valuation — Weighted Average Cost (Per-Location Storage + Company-Wide Toggle):**
   - Uses **Weighted Average Cost** to value On-Hand Stock.
   - Tracks average cost **per Location** underneath (so transfers carry the sending Location's cost, and different Locations can reflect different purchase/shipping costs) while providing a **UI toggle/filter** to view either **Per-Location** or **Company-wide** average cost per SKU.
   - **Formula Transparency:** Calculated metrics (Weighted Average Cost, On-Hand/Reserved/Available Stock, Turnover, etc.) include an info icon with a **hover popover** showing the exact math/formula and current values used in the calculation.

2. **Core Phase 3 Reports:**
   - **Stock Valuation Report:** Current On-Hand Stock and total dollar value by SKU, Category, or Location (with Per-Location / Company-wide toggle).
   - **Low-Stock & Reorder Report:** SKUs below their minimum stock level or marked Zero/Negative.
   - **Stock Movement & Adjustment History:** Audit-ready log of all receipts, sales issues, transfers, and manual adjustments with reasons.
   - **Inventory Turnover & Aging Report:** How fast SKUs sell vs. slow-moving or dead stock sitting on the shelf.

3. **Exports & Cost Permissions:**
   - Supports on-demand exports in **CSV**, **Excel (`.xlsx`)**, and **print-ready PDF** (scheduled email reports deferred).
   - Respects `iam`'s `View Costs & Prices` permission: users without it can view quantity-based reports, while dollar valuation and cost columns are hidden.

4. **Performance & Architecture:**
   - The `reporting` module maintains **pre-calculated summary tables (read models)** in its own PostgreSQL schema, updated asynchronously from the saved event log (`StockReceived`, `StockIssued`, `StockAdjusted`, etc.), paired with **short-term caching** for repeated report views and exports.

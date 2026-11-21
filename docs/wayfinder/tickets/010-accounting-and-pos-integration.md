# 010: Accounting & POS Integration (Feature #5)

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [005: Phased Roadmap & Module Extension Points](./005-phased-roadmap-and-extension-points.md), [006: Role-Based Permissions (Feature #7)](./006-role-based-permissions.md), [008: Reporting & Analytics (Feature #4)](./008-reporting-and-analytics.md)

## Question

Which target accounting and POS platforms must be supported, what sync direction (push, pull, webhooks) and reconciliation rules apply, and how should sync failures and retries be handled? *(Note: Safest in Phase 5 after Permissions #7 and Reporting/Valuation #4 are settled, though the roadmap order remains flexible.)*

## Resolution

1. **Internal Cash & Expense Tracker (`finance` feature box, replacing live accounting sync):**
   - Owner-focused internal cash flow monitoring rather than live external accounting integration or accountant file handoff.
   - Supports **user-defined Income & Expense Categories** (e.g., Sales, Stock Purchases, Rent, Payroll, Utilities) and manual expense/income entries.
   - **Payment-Based Cash Timing:** Purchase Orders and Sales Orders update the Cash Balance when payment is recorded (**"Mark as Paid"** / partial payments), keeping real cash in hand accurate and unpaid orders visible.
   - **Permissions:** Gated via `iam` permissions (Owner/Admin by default) so regular staff cannot view business cash balance, rent, or payroll.
2. **Quick Counter Sale (replacing full retail POS):**
   - Lightweight 1-step **Quick Counter Sale** screen for manually recording over-the-counter walk-in sales (pick/scan SKUs, immediately deduct `On-Hand Stock` at the Location, and record payment straight into the Cash Balance—skipping Draft/Reservation/Shipping).
   - Full retail POS hardware/workflows (cash drawers, card terminals, shift closing, tax-receipt engines) are intentionally kept out of scope.
3. **Future Plug-In Readiness (Accounting & External POS):**
   - Leverage the Phase 1 **Saved Event Log (Outbox)** and flexible `catalog` SKU/barcode lookup so external Accounting software (e.g., QuickBooks Online, Xero) or external POS systems (e.g., Square, Shopify POS) can be plugged in later as isolated adapters—with automatic retries and a "Needs Attention" error queue—without modifying core `catalog`, `inventory`, or `orders` code.

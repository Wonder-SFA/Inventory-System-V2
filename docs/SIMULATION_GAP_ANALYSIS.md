# Codebase Gap Analysis: Day 1 Simulation Scenario

**Target Scenario:** Samar Island Agri-Feeds Trading (`Dev-personal-files/simulations/`)  
**Codebase Audited:** `packages/db/migrations/0001`–`0010`, `packages/shared-domain/src/`, `apps/api/src/modules/`, `apps/web/src/`

---

## 1. Executive Summary

### Overall Readiness
The current codebase is a **multi-location core inventory & order-fulfillment engine** (Catalog, Locations, Append-Only Stock Ledger, Purchase Orders, Sales Orders, Transfer Orders, IAM/RBAC, and Next.js CRUD UI). It **cannot** run the Day 1 Simulation end-to-end today: out of the 12 core operational domains required by the simulation, **0 are fully supported**, **6 are partially supported** (basic warehouse/order mechanics exist without simulation-specific attributes/rules), and **6 are completely missing** (all financial, tax, pricing, lot/expiry, and treasury capabilities).

### What Works Today
- **Multi-location stock ledger & balances:** Append-only `inventory.stock_movements` and projected `inventory.stock_balances` (`on_hand`, `reserved`, `available`, `in_transit`, `weighted_average_cost`) in [0006_inventory_ledger_and_balances.sql](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0006_inventory_ledger_and_balances.sql) and [stockLedger.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/inventory/domain/stockLedger.ts).
- **Basic PO / SO / Transfer lifecycles:** `DRAFT → CONFIRMED → PARTIALLY_* / RECEIVED / SHIPPED / DELIVERED / CANCELLED` with idempotency keys, outbox events, and optimistic locking (`version`) in [purchaseOrders.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/purchaseOrders.ts), [salesOrders.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/salesOrders.ts), and [transferOrders.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/transferOrders.ts).
- **Fixed-precision decimal math:** 4-decimal `Decimal4` (`NUMERIC(18, 4)`) arithmetic in [packages/shared-domain/src/decimal/index.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/shared-domain/src/decimal/index.ts), which supports fractional kg quantities (e.g., `10.0000`, `25.0000`).
- **Web UI & Auth:** Better Auth session + RBAC (`AccessPolicy` cost redaction, location scoping) and CRUD pages for Catalog, Locations, Stock Balances, Stock Movements, Suppliers, Purchase Orders, Customers, Sales Orders, and Transfer Orders ([AppShell.tsx](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/web/src/components/AppShell.tsx)).

### What Is Missing (High-Level)
1. **No Expiry Lots / FEFO / FIFO Costing:** Stock is tracked only by `(sku_id, location_id)` using **Weighted Average Cost (WAC)**, not by lot (`mfg_date`, `exp_date`) or FIFO/FEFO.
2. **No Accounting, AR/AP, Treasury, or PDCs:** Zero support for Charge Invoices (`CI`), Sales Invoices (`SI`), Collection Receipts (`CR`), Check Vouchers (`CV`), Post-Dated Checks (`PDC`), Cash Drawers, Bank/GCash wallets, or Driver Remittance.
3. **No Tax / VAT Engine:** No `VAT-Exempt` vs `12% VATable` classification, Output VAT, or Input VAT tracking.
4. **No Pricing Tiers, Volume Rebates, or Credit Controls:** No `Walk-In Retail` / `Farm` / `Dealer` price schedules, no `20+ sacks` rebate rules, and no credit-limit or overdue-invoice checks.
5. **No UOM Conversions / Sack-Breaking:** No atomic conversion from `1` sealed 50 kg sack to `50.0 kg` loose bin with cost-per-kg derivation.
6. **No Rolling Stock / Truck Route Manifests & Key Order-Workflow Gaps:** Cannot edit a `CONFIRMED` Sales Order (`updateSalesOrder` requires `DRAFT`), cannot short-close a `PARTIALLY_RECEIVED` PO without `CANCELLED` status, and no truck load/return manifest (`LOAD-2026-014` / `RET-LOAD-2026-014`).

---

## 2. Capability Matrix

| Domain / Feature | Status | Evidence in Codebase | Simulation Requirement |
| :--- | :--- | :--- | :--- |
| **Locations & Fleet (`LOC-CATB`, `LOC-CTMN`, `TRK-ELF1`)** | **Partial** | `inventory.locations` ([0005_inventory_locations.sql](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0005_inventory_locations.sql)) supports `name`, `address`, `description`, `parent_location_id`. No `code`, `location_type`, or vehicle capacity. | Distinct location codes, `Main Bodega` / `Satellite Depot` / `Delivery Truck` roles, 4,500 kg truck capacity tracking. |
| **Rolling Stock (`LOAD-2026-014`, `RET-LOAD-2026-014`)** | **Missing** | Can only be mimicked via manual `orders.transfer_orders` to/from a truck location; no route manifest or unallocated ex-truck pool. | Single truck dispatch combining `DR`s, `STF-2026-019`, and unallocated `LOAD-2026-014`, ex-truck `SI-2026-502`, and `RET-LOAD-2026-014` check-in. |
| **Catalog, UOM & Sack-Breaking** | **Partial** | `catalog.skus` has single `unit_of_measure_id` ([0004_catalog_schema.sql](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0004_catalog_schema.sql)). `POST /api/v1/stock-adjustments` allows manual +/- adjustments. | Dual UOM / conversion (`1` 50 kg sack → `50.0 kg` loose bin @ ₱36.00/kg cost) as a single atomic sack-breaking event. |
| **Expiry Lots, FEFO & FIFO Costing** | **Missing** | `inventory.stock_balances` PK is `(sku_id, location_id)` ([0006](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0006_inventory_ledger_and_balances.sql)); `calculateWeightedAverageCost` in [decimal/index.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/shared-domain/src/decimal/index.ts) uses WAC. | Lot code (`HS-2610A`, `HS-2611A`), `mfg_date`, `exp_date`, FEFO picking on dispatch/sale, and FIFO COGS valuation. |
| **Purchase Orders & Receiving (`PO-2026-041`, `RR-2026-071`)** | **Partial** | `orders.purchase_orders` & `receivePurchaseOrder` ([purchaseOrders.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/purchaseOrders.ts)) support partial receipt (`PARTIALLY_RECEIVED`). No `SHORT_CLOSED` status or persisted RR document. | `RR-2026-071` with lot/expiry + supplier CI `VFM-9012` + due date; short-closing `PO-2026-041` (25 of 30 received, 5 short). |
| **Sales Orders & Pre-Dispatch Edits (`SO-2026-201`)** | **Partial** | `orders.sales_orders` ([0008](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0008_orders_customers_sales_orders.sql)); `updateSalesOrder` ([salesOrders.ts:313](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/salesOrders.ts#L313)) rejects edits unless `status === 'DRAFT'`. | Edit a `CONFIRMED` order (`SO-2026-201`: reduce `FEED-HG50` 10→8, add 4 `VET-MV01`) and update stock reservations atomically. |
| **Delivery Receipts, Sales Invoices & Charge Invoices** | **Missing** | Only `sales_orders` (`SHIPPED` / `DELIVERED`) exist; no `DR`, `SI`, or `CI` documents or counter POS flow. | `DR-2026-301`/`302`, `CI-2026-1140`/`1141` (credit due dates), `SI-2026-501`..`504` (immediate cash/GCash/split). |
| **Customer Tiers, Pricing, Rebates & Credit Controls** | **Missing** | `orders.customers` ([0008](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0008_orders_customers_sales_orders.sql)) only has `name, email, phone, address, status`. `SalesOrderLineInputSchema` takes manual `unitPrice`. | `Walk-In Retail` / `Farm` / `Dealer` price tiers, `20+ sacks` ₱20/sack volume rebate, credit limits, and overdue AR hold checks. |
| **Tax / VAT Handling (12% VATable vs VAT-Exempt)** | **Missing** | No tax columns on `catalog.skus`, `purchase_order_lines`, or `sales_order_lines`. Default currency is `'USD'` in migrations. | VAT-Exempt feeds vs 12% VATable `VET-MV01`, Output VAT (₱204.00), Input VAT (₱240.00), Excess Input VAT Credit (₱36.00). |
| **Accounts Receivable, Collections & PDCs** | **Missing** | No AR tables, payment receipts, or check tracking anywhere in `packages/db` or `apps/api`. | Opening AR, `CR-2026-401` partial payment (₱20k of ₱32k), `CR-2026-402` via `PDC #004912` (₱48.5k, Undeposited PDCs on Hand). |
| **Accounts Payable & Disbursements (`CV-2026-088`/`089`)** | **Missing** | No AP invoices, payment terms, or disbursement vouchers in `packages/db` or `apps/api`. | Opening AP (`SI-VFM-8841`), `CV-2026-088` (₱85k BDO transfer), `CV-2026-089` (₱14,640 immediate payment on `SAV-1104`). |
| **Treasury (Cash Drawers, Bank, GCash, Remittance)** | **Missing** | No cash/bank/wallet account entities or ledger in `packages/db` or `apps/api`. | Catbalogan & Catarman Cash Drawers, GCash Business Wallet, BDO Checking, split payments, and Driver EOD Remittance. |
| **Inter-Branch Stock Transfers (`STF-2026-019`)** | **Partial** | `orders.transfer_orders` ([0009](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/packages/db/migrations/0009_orders_transfer_orders.sql)) + `dispatchTransfer` / `receiveTransfer` ([stockLedger.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/inventory/domain/stockLedger.ts)). | `STF-2026-019` (`LOC-CATB` → `LOC-CTMN`) with specific expiry lots (`HS-2611A`, `BF-2611A`, `TF-2611A`) and truck manifest link. |
| **EOD Reconciliation & Financial Reporting** | **Missing** | `GET /api/v1/stock-balances` ([stockRoutes.ts](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/inventory/routes/stockRoutes.ts)) returns WAC valuation & SKU `defaultSellingPrice` margin only. | Lot-level inventory roll-forward, FIFO COGS, Gross Margin (₱10,540), VAT summary, Cash/Bank/PDC tie-out, AR/AP aging, Balance Sheet. |

---

## 3. Step-by-Step Gap Walkthrough

### Day 0 Starting State (`01-day0-starting-state.md`)
- **Locations & Fleet:** `LOC-CATB`, `LOC-CTMN`, and `TRK-ELF1` can be created as rows in `inventory.locations`, but without `code` (`LOC-*`/`TRK-*` is only in `name`), location type (`WAREHOUSE` / `DEPOT` / `TRUCK`), or vehicle capacity (`4,500 kg`).
- **Product Catalog (7 SKUs):** `catalog.products`, `catalog.units_of_measure`, and `catalog.skus` support creating the 7 SKUs, **except** there is no `tax_class` (`VAT_EXEMPT` vs `VATABLE_12`), no tiered prices (`Dealer` / `Farm` / `Walk-In Retail`), no base cost, and no loose-bin conversion metadata on `FEED-BF50`.
- **Suppliers & Customers:** `orders.suppliers` and `orders.customers` support basic contact fields, **missing** `code` (`SUP-001`, `CUST-001`), `price_tier`, `payment_terms_days`, `credit_limit`, and opening AP/AR balances.
- **Opening Inventory & Lots:** Opening stock can be posted via `POST /api/v1/stock-adjustments`, **except** `HS-2610A` (12 sacks @ ₱1,720) and `HS-2611A` (20 sacks @ ₱1,750) collapse into a single `(FEED-HS50, LOC-CATB)` row with WAC `₱1,738.75`, losing lot codes, `mfg_date`, and `exp_date`.
- **Opening Cash, Bank, AR, AP, Equity:** **Missing** completely—no tables exist for drawers, GCash, BDO checking, AR invoices (`CI-2026-1102`, `CI-2026-1045`), AP invoices (`SI-VFM-8841`), or equity.

### Day 1 Simulation Steps (`02-day1-simulation-script.md`)
1. **Step 1 (06:30 AM — `PO-2026-041` Inbound & Short-Close):**
   - `receivePurchaseOrder` (`POST /api/v1/purchase-orders/:id/receipts`) handles receiving 25/30 `FEED-HS50`, 25/25 `FEED-HG50`, and 20/20 `FEED-BF50`, transitioning PO to `PARTIALLY_RECEIVED`.
   - **Gaps:** Cannot record expiry lots (`HS-2611B`, `HG-2611B`, `BF-2611B`), cannot create a persisted `RR-2026-071` linked to supplier CI `VFM-9012` (due Dec 9) / AP ledger, and cannot **short-close** `PO-2026-041` (only `CANCELLED` exists via `cancelPurchaseOrder`).
2. **Step 2 (07:00 AM — Confirming `SO-2026-201` & `SO-2026-202`):**
   - `createSalesOrder` + `confirmSalesOrder` reserve stock at `LOC-CATB`.
   - **Gaps:** No automatic `Farm` / `Dealer` tier pricing, no `20+ sacks` ₱20.00/sack volume rebate on `FEED-HG50`, no credit limit check (`CUST-001`: ₱32k + ₱46.4k ≤ ₱80k), and no overdue-invoice warning/hold (`CUST-002`: `CI-2026-1045` 5 days overdue).
3. **Step 3 (07:30 AM — Pre-Dispatch Modification of `SO-2026-201`):**
   - **Hard Blocker:** `updateSalesOrder` ([salesOrders.ts:313](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/apps/api/src/modules/orders/domain/salesOrders.ts#L313)) throws `409 INVALID_ORDER_STATE` for any status other than `DRAFT`. Cannot reduce `FEED-HG50` (10→8) or add `4` `VET-MV01` on a `CONFIRMED` order.
4. **Step 4 (08:00 AM — Loading & Dispatch of `Elf Truck #1`):**
   - `STF-2026-019` can use `createTransferOrder` → `confirmTransferOrder` → `dispatchTransferOrder`.
   - **Gaps:** No FEFO lot picking (`HS-2610A` depleted before `HS-2611A`, `HG-2611A` depleted before `HG-2611B`), no combined truck payload manifest (4,204 kg), no `DR-2026-301`/`302` or `CI-2026-1140`/`1141` generation, and no `LOAD-2026-014` rolling-stock load workflow.
5. **Step 5 (08:45 AM — Counter Sack-Breaking):**
   - **Gap:** No atomic sack-breaking/conversion operation. Requires two disconnected `POST /api/v1/stock-adjustments` calls (`-1` `FEED-BF50` sack, `+50.0000` `FEED-BF50-LOOSE` kg at manual `unitCost: "36.0000"`), with no lot link to `BF-2611B`.
6. **Step 6 (09:15 AM — Morning Walk-In Counter Sale `SI-2026-501`):**
   - **Gap:** Requires full SO lifecycle (`DRAFT → CONFIRMED → SHIPPED → DELIVERED`) instead of a direct counter `SI` sale; no `12%` Output VAT calculation on `VET-MV01` (₱72.00 VAT); no cash drawer inflow (+₱1,862.00).
7. **Step 7 (09:30 AM — San Jorge Delivery `DR-2026-301` & Partial Payment `CR-2026-401`):**
   - `deliverSalesOrder` marks SO `DELIVERED`.
   - **Gaps:** No signed DR/CI (`CI-2026-1140` for ₱44,052 due Dec 9), no `CR-2026-401` partial payment (₱20,000 BDO transfer against `CI-2026-1102`, leaving ₱12,000 open), and no BDO bank inflow.
8. **Step 8 (10:30 AM — Supplier AP Settlement `CV-2026-088`):**
   - **Missing:** No AP invoice `SI-VFM-8841` (₱85,000), no `CV-2026-088` disbursement voucher, and no BDO bank outflow.
9. **Step 9 (11:15 AM — Ex-Truck Rolling-Stock Sale `SI-2026-502` in Gandara):**
   - **Missing:** No ex-truck sale from `LOAD-2026-014` rolling stock, and no `Driver Cash on Hand` tracking (₱15,240.00 held by Kuya Jun for EOD remittance).
10. **Step 10 (12:00 PM — Local Supplier Inbound `PO-2026-042` / `RR-2026-072` & Immediate Payment `CV-2026-089`):**
    - PO + receipt works for stock qty, **missing** `DRK-2611B` / `MV-2611` lots, Input VAT (₱240.00 on `VET-MV01`), supplier SI `SAV-1104`, and immediate `CV-2026-089` BDO outflow (₱14,640.00).
11. **Step 11 (01:15 PM — Calbayog Overdue Collection `CR-2026-402` via `PDC #004912` & Delivery `DR-2026-302`):**
    - **Missing:** No PDC collection (`PDC #004912`, Metrobank, dated Dec 4, ₱48,500.00), no `Undeposited PDCs on Hand` asset tracking, and no overdue-release gate.
12. **Step 12 (02:30 PM — Catarman Depot Replenishment `STF-2026-019`):**
    - `receiveTransferOrder` (`POST /api/v1/transfer-orders/:id/receipts`) moves stock from `in_transit` to `LOC-CTMN` `on_hand`.
    - **Gap:** Does not preserve source expiry lots (`HS-2611A`, `BF-2611A`, `TF-2611A`) or lot costs.
13. **Step 13 (03:15 PM — Catarman Counter Sale `SI-2026-503` with Split Payment):**
    - **Missing:** No `SI-2026-503` counter sale and no **split payment** recording (₱15,000.00 GCash Business Wallet + ₱8,540.00 Catarman Depot Cash Drawer).
14. **Step 14 (04:00 PM — Afternoon Walk-In Sale `SI-2026-504` via GCash):**
    - **Missing:** No direct counter `SI` and no GCash Business Wallet inflow (+₱2,620.00).
15. **Step 15 (05:45 PM — Truck Return `RET-LOAD-2026-014` & EOD Remittance):**
    - **Missing:** No rolling-stock return check-in (`4` `FEED-BF50`, `2` `FEED-LM25` back to `LOC-CATB`) and no driver EOD remittance workflow (₱15,240.00 cash → Catbalogan Drawer; ₱48,500.00 `PDC #004912` → Undeposited PDCs on Hand).

### EOD Reconciliation (`03-eod-reconciliation.md`)
- **Inventory by Location & Expiry Lot:** `GET /api/v1/stock-balances` aggregates by `(sku_id, location_id)` using WAC, so lot-level closing quantities and lot-specific values (e.g., `HS-2610A` = 0 vs `HS-2611A` = 7 vs `HS-2611B` = 25) cannot be reported.
- **Sales, FIFO COGS & Gross Margin:** No sales/COGS/margin report; existing `grossMargin` on `stock_balances` is only a static `sku.defaultSellingPrice - weightedAverageCost` snapshot.
- **VAT Summary, Cash/Bank/GCash/PDC Balances, AR/AP, Balance Sheet & Equity Tie-Out:** **Completely missing** (no underlying tables or endpoints).

---

## 4. Prioritized Gap Summary

### Tier 1 — Critical Architectural & Domain Blockers (New Subsystems Required)
1. **Expiry Lot & FEFO/FIFO Ledger (`inventory`):** Add `inventory.stock_lots` (`lot_code`, `mfg_date`, `exp_date`, `unit_cost`), lot-level balances, FEFO allocation on issues/transfers, and FIFO COGS tracking (or dual FIFO/WAC).
2. **Invoicing, AR & AP Subledger (`finance` / `orders`):** Add Customer Charge/Sales Invoices (`CI`/`SI`), Supplier Bills, Collection Receipts (`CR`), Check/Payment Vouchers (`CV`), partial payment allocations, and Post-Dated Checks (`PDC` lifecycle: On Hand → Deposited → Cleared/Bounced).
3. **Treasury & Cash/Bank Accounts:** Add `cash_drawers`, `bank_accounts`, `ewallets`, split-payment tenders, and Driver EOD Remittance reconciliation.
4. **Tax / VAT Engine:** Add `tax_class` (`VAT_EXEMPT`, `VATABLE_12`) on SKUs, line-level net/VAT/gross amounts, and Output/Input VAT reporting.

### Tier 2 — Partial / Existing-Module Schema & Workflow Gaps
5. **Pre-Dispatch Confirmed SO Edits (`salesOrders.ts`):** Allow `updateSalesOrder` on `CONFIRMED` (unshipped) orders by computing reservation deltas (`reserveStock` / `releaseReservation`) instead of blocking all non-`DRAFT` edits.
6. **PO Short-Close & Receiving Reports (`purchaseOrders.ts`):** Add `SHORT_CLOSED` PO status/action and a persisted `receiving_reports` record (`RR-*`, supplier invoice ref, due date).
7. **Pricing Tiers, Volume Rebates & Credit Controls (`orders`):** Extend `orders.customers` with `code`, `price_tier`, `payment_terms_days`, `credit_limit`; add tier price lists, volume rebate rules, and overdue/credit-limit checks.
8. **UOM Conversion / Sack-Breaking (`catalog` & `inventory`):** Add SKU pack-size/conversion rules and an atomic `SACK_BREAK` movement pair (`-1` sack → `+50 kg` loose bin with derived cost/kg).
9. **Rolling Stock & Route Manifests (`orders` / `logistics`):** Add `location_type` (`WAREHOUSE`, `DEPOT`, `TRUCK`) and a `route_loads` / `truck_manifests` workflow uniting `DR`s, `STF`s, `LOAD-*` rolling stock, ex-truck `SI`s, and `RET-LOAD-*` returns.

### Tier 3 — Reporting & Web UI Gaps
10. **EOD Reconciliation Dashboard & Reports (`apps/api` + `apps/web`):** Build EOD reports (Inventory Roll-Forward by Lot/Location, Sales & FIFO Gross Margin, VAT Summary, Cash/Bank/GCash/PDC Reconciliation, AR/AP Aging, Balance Sheet Tie-Out).
11. **Operational UI Flows (`apps/web`):** Add Counter POS / Quick Sale, Sack-Breaking action, Receiving Report & Short-Close UI, Truck Dispatch/Remittance UI, and AR/AP/Treasury pages (currently only 9 CRUD pages exist in `apps/web/src/app/`).

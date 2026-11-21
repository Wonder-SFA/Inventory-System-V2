# Inventory System V2 — Architecture & Domain Blueprint

This blueprint packages all settled planning decisions from the Wayfinder Map ([Tickets 001–011](./wayfinder/MAP.md)) into a build-ready guide for implementation.

---

## 1. System Overview & Core Principles

### Business Scope & Tenancy
- **Single-tenant, multi-location** inventory system built for one business operating across one or more physical sites (**Locations** such as warehouses and stores).
- Clean workspace and module isolation from day one so the system can evolve into a multi-tenant SaaS product later without rewriting core logic.

### Core Truth 1 — Bank-Statement Stock History (Append-Only Ledger)
- Stock quantities are **never overwritten directly**.
- Every stock change is recorded as an immutable **Stock Movement** (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`).
- Current stock counts (**On-Hand Stock**, **Reserved Stock**, **Available Stock**, and **In-Transit Stock**) are projected from that ledger into fast balance records for daily operations and concurrency safety.

### Core Truth 2 — Separate Feature Boxes (Modular Monolith)
- One deployable application organized into **strictly isolated feature modules ("boxes")**.
- Modules communicate **only** through explicit **public TypeScript interfaces** (for direct lookups/queries) and **internal domain events** (for reactions).
- Modules **never reach directly into another module's database tables**. Each module owns a private PostgreSQL schema (`catalog.*`, `inventory.*`, `orders.*`, `iam.*`, and later `reporting.*`, `finance.*`).

### Technology Stack
- **Monorepo:** TypeScript everywhere with `pnpm` workspaces + Turborepo.
- **Web App (`apps/web`):** Next.js / React desktop browser application (Phases 1–3 focus on 1–4 office computers).
- **Backend API (`apps/api`):** Fastify modular monolith serving both Web and future Mobile clients.
- **Database & ORM:** PostgreSQL + Drizzle ORM (predictable queries and locking on the append-only stock ledger).
- **Authentication:** PostgreSQL-backed sessions via **Better Auth** (works for both Web and Mobile, extensible for Phase 2 RBAC).
- **Live Updates:** **Server-Sent Events (SSE)** for automatic one-way live updates of stock and order screens.
- **Mobile App (`apps/mobile`, Phase 4):** Native mobile app (iOS & Android, e.g., React Native / Expo) reusing shared TypeScript domain types and validation rules.

### Hosting & Cloud Portability
- **Initial Hosting:** Containerized app + Managed PostgreSQL on a Managed Cloud Platform (e.g., Railway or Render) for automatic HTTPS, daily backups, and low operational overhead.
- **Planned Future Migration:** Move to **Google Cloud (Cloud Run + Cloud SQL)** when scaling or moving to SaaS.
- **Portability Rule:** Stateless API servers, standard Docker container, standard PostgreSQL features only, and zero platform-specific vendor lock-in so the Google Cloud move requires zero code rewrites.

---

## 2. Monorepo & Modular Folder Structure

```text
inventory-system-v2/
├── apps/
│   ├── web/                          # Next.js / React desktop web app
│   ├── api/                          # Fastify modular monolith server
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── catalog/          # Phase 1: Products, SKUs, Units of Measure (+ Phase 2 Barcodes/QR)
│   │       │   ├── inventory/        # Phase 1: Locations, Stock Movements (ledger), Stock Balances
│   │       │   ├── orders/           # Phase 1: Suppliers, Customers, Purchase/Sales/Transfer Orders
│   │       │   ├── iam/              # Phase 1: Users, Better Auth sessions (+ Phase 2 RBAC & Audit Log)
│   │       │   ├── reporting/        # Phase 3: Valuation (WAC), Turnover, Exports, Read Models
│   │       │   └── finance/          # Phase 5: Internal Cash & Expense Tracker + Quick Counter Sale
│   │       └── shared/               # Outbox runner, SSE broadcaster, HTTP server setup
│   └── mobile/                       # Phase 4: React Native / Expo offline-first scanner app
├── packages/
│   ├── shared-domain/                # Shared TypeScript types, validation schemas, domain constants
│   └── db/                           # Shared PostgreSQL connection, Drizzle config, per-schema migrations
├── docs/
│   ├── ARCHITECTURE_BLUEPRINT.md     # This blueprint
│   ├── adr/                          # 7 accepted Architecture Decision Records + index
│   └── wayfinder/                    # Planning map & decision tickets (001–011)
├── GLOSSARY.md                       # Shared plain-English domain vocabulary
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

### Inside Each Feature Box (`apps/api/src/modules/<box>/`)
Every module follows the same clean internal boundaries:
- `db/schema.ts` — Drizzle tables inside the box's dedicated PostgreSQL schema (e.g., `inventory.*`). Private to this module.
- `domain/` — Business rules, workflows, and state transitions.
- `public/` — The only functions and types other modules are allowed to call or import.
- `events/` — Domain events published (via the transactional outbox) or subscribed to from other boxes.

---

## 3. Mandatory Phase 1 Extension Points ("Plugs")

To ensure Phases 2–5 plug in cleanly without rewriting Phase 1 modules, four extension points are built into Phase 1 from day one:

1. **Single Permission Gate (`iam`):**
   - Every mutating action across `catalog`, `inventory`, and `orders` calls `authorize(actor, action, resource)`.
   - *Phase 1:* Passes for any authenticated user.
   - *Phase 2+:* Swaps in custom roles, user-level Location scoping, `Allow Negative Stock`, `View Costs & Prices`, and optional dollar/quantity limits without changing order or stock code.
2. **Saved Event Log / Transactional Outbox (`inventory` & `orders`):**
   - Every stock movement and order status change writes a durable domain event (`StockReceived`, `StockIssued`, `StockAdjusted`, `OrderConfirmed`, etc.) in the **same database transaction** as the change itself.
   - *Phase 3–5:* Consumed reliably by `reporting` read models, SSE live screen updates, and future external Accounting/POS adapters without missing events.
3. **Flexible SKU Lookup (`catalog`):**
   - `catalog` exposes a lookup interface accepting either `skuId` or `code`.
   - *Phase 2:* Multi-barcode and QR aliases (UPC, EAN, Code 128, QR) attach cleanly without changing how `orders` or `inventory` reference a SKU.
4. **Optional `unitCost` on Receipts (`orders` & `inventory`):**
   - Purchase Order lines and `RECEIPT` stock movements accept an optional `unitCost` and currency from day one.
   - *Phase 3:* Enables Weighted Average Cost valuation immediately with clean historical cost data and zero backfilling.

---

## 4. Phase 1 (MVP) Core Workflows & Rules

### Catalog & Locations (`catalog` & `inventory`)
- **Lifecycle:** Products, SKUs, and Locations use `Active` / `Archived` status. Any record with existing Stock Movements or orders cannot be hard-deleted—it is archived to preserve ledger history. Unused records may be cleanly deleted.
- **Single Base Unit:** Each SKU has one base **Unit of Measure** (e.g., `pcs`, `kg`, `L`). Bulk packs are separate SKUs or converted on receipt.
- **Locations:** Represent physical buildings/sites (e.g., Main Warehouse, Downtown Store), structured so sub-locations (bins/shelves) can be added underneath later without rewriting the ledger.

### Stock Ledger, Real-Time Counts & Negative Stock (`inventory`)
- **Append-Only Ledger:** Every change appends an immutable `StockMovement` (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`) recording `skuId`, `locationId`, `quantityDelta`, `reasonCategory`, `referenceType`/`referenceId`, `actorId`, and `createdAt`.
- **Projected Stock Balances:** A `StockBalance` projection per `(skuId, locationId)` tracks `onHand`, `reserved`, `available` (`onHand - reserved`), and `inTransit` for fast screen reads and safe concurrent locking.
- **Flexible Negative Stock:** In Phase 1, both `Available Stock` and `On-Hand Stock` are allowed to drop below zero so urgent operations are never blocked. Whenever either drops to `<= 0`, the system warns the user and places a visible **Zero / Negative Stock** marker on that `(skuId, locationId)` record for follow-up reconciliation. *(In Phase 2, `Allow Negative Stock` becomes a role permission.)*
- **Manual Adjustments:** Every manual `ADJUSTMENT` requires a `reasonCategory` (`STOCK_COUNT`, `DAMAGED`, `EXPIRED`, `LOST`, `OTHER`) and supports an optional free-text note.

### Order Workflows & Edge Cases (`orders` → `inventory`)
- **Partial Fulfillment:** Purchase Orders, Sales Orders, and Transfer Orders track `orderedQty` vs. fulfilled quantities per line item, supporting partial receiving and partial shipping.
- **Purchase Orders (Supplier → Location):** `Draft` → `Confirmed` → `Partially Received` → `Received` (or `Cancelled`). Receiving items records a `RECEIPT` movement into the destination Location's `On-Hand Stock`.
- **Sales Orders (Location → Customer):** `Draft` → `Confirmed` (increases `Reserved Stock`) → `Partially Shipped` / `Shipped` (releases reservation and records an `ISSUE` movement deducting `On-Hand Stock`) → `Delivered`. Customer returns or rejected deliveries record a `RECEIPT` movement (`reason: CUSTOMER_RETURN`) when goods physically return.
- **Transfer Orders (Location A → Location B):** `Draft` → `Confirmed` → `In-Transit` (Location A dispatches: `TRANSFER_OUT` deducts A's `On-Hand Stock` and adds to `In-Transit Stock`) → `Partially Received` / `Received` (Location B receives: `TRANSFER_IN` deducts `In-Transit Stock` and adds to B's `On-Hand Stock`). Missing or damaged remainders can be closed out with a discrepancy reason so stock never remains stuck `In-Transit`.
- **Order Cancellations / Early Close:** Cancelling or closing a partially fulfilled order preserves all already-recorded Stock Movements, releases any remaining `Reserved Stock` back to `Available Stock`, and closes the unfulfilled remainder.

---

## 5. Phased Roadmap Summary (Phases 1–5)

Because future features live in isolated boxes behind Phase 1's extension points, the post-MVP order below is **flexible** (with two natural dependencies noted):

- **Phase 1 — MVP Core:**
  `catalog` (Products, SKUs, Units), `inventory` (Locations, Append-Only Stock Ledger, Projected Balances), `orders` (Purchase, Sales, Transfer Orders), and basic `iam` (Better Auth login + `authorize()` gate), plus the Saved Event Log (Outbox).
- **Phase 2 — Permissions (#7) & Barcodes/QR (#2):**
  - **RBAC (`iam`):** Protected `Owner` role + 4 editable starter roles (`Admin`, `Manager`, `Staff`, `Viewer`), custom role builder, user-level Location scoping, `Allow Negative Stock` & `View Costs & Prices` checkboxes, optional dollar/quantity limits, immediate enforcement, and immutable IAM Audit Log.
  - **Barcodes & QR (`catalog`):** Multiple barcodes per SKU (UPC, EAN, Code 128, QR), blank-by-default with on-demand "Generate Barcode", browser print-ready PDFs (office sheets & thermal rolls), handheld + camera scan-to-increment (+1), and Owner-configurable unknown/unexpected scan handling.
- **Phase 3 — Reporting & Analytics (#4):**
  - New `reporting` box with pre-calculated summary read models updated from the Saved Event Log + short-term caching.
  - **Weighted Average Cost** stored per Location with a Per-Location / Company-wide UI toggle and hover formula popovers.
  - Core reports: Stock Valuation, Low-Stock & Reorder, Stock Movement & Adjustment History, Inventory Turnover & Aging; exports in CSV, Excel (`.xlsx`), and PDF; dollar columns gated by `View Costs & Prices`.
- **Phase 4 — Cloud Access, Live Sync & Mobile (#6):**
  - *(Naturally builds on Barcodes #2.)*
  - Containerized deployment on Managed Cloud (Railway/Render + Managed PostgreSQL) ready for future Google Cloud migration.
  - **SSE** live screen updates across desktop and mobile.
  - **Native Mobile App (`apps/mobile`)** with offline-first warehouse scanning: **Physical Reality Wins** on reconnect—queued offline movements replay into the ledger, and any clash with server state flags a **Manager Exception** for paperwork reconciliation.
- **Phase 5 — Cash & Expense Tracker + Quick Counter Sale (#5):**
  - *(Safest after Permissions #7 and Reporting/Valuation #4 are settled.)*
  - New internal `finance` box: Owner/Admin-gated **Cash & Expense Tracker** with user-defined Income & Expense Categories and payment-based **Cash Balance** timing ("Mark as Paid" / partial payments).
  - 1-step **Quick Counter Sale** screen for manual walk-in sales (immediately deducts `On-Hand Stock` and records cash payment, skipping Draft/Reservation/Shipping).
  - Full retail POS hardware/shifts remain out of scope; Saved Event Log remains ready for future external Accounting (QuickBooks/Xero) or POS (Square/Shopify POS) plug-in adapters with retry + "Needs Attention" error queue.

---

## 6. Domain Glossary & Architecture Decision Records

1. **Shared Domain Vocabulary ([GLOSSARY.md](../GLOSSARY.md)):**
   Plain-English definitions and "avoid" terms covering Catalog, Locations & Stock, Orders & Counterparties (including `Quick Counter Sale`), Finance & Valuation (`Weighted Average Cost`, `Cash Balance`), and Operations & Governance (`Manager Exception`, `IAM Audit Log`).
2. **Architecture Decision Records ([docs/adr/README.md](./adr/README.md)):**
   - [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./adr/0001-modular-monolith-and-schema-isolation.md)
   - [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./adr/0002-append-only-stock-ledger-and-outbox.md)
   - [ADR-0003: TypeScript Monorepo & Core Stack](./adr/0003-typescript-monorepo-and-core-stack.md)
   - [ADR-0004: Flexible Negative Stock Policy](./adr/0004-flexible-negative-stock-policy.md)
   - [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md)
   - [ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions](./adr/0006-offline-mobile-physical-reality-wins.md)
   - [ADR-0007: Portable Containerized Cloud Hosting](./adr/0007-portable-containerized-cloud-hosting.md)

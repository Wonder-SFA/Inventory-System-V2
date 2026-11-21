# Inventory System V2 — Architecture & Domain Blueprint

This blueprint packages all settled planning decisions from the Wayfinder Map ([Tickets 001–011](./wayfinder/MAP.md)) into a build-ready guide for implementation.

---

## 1. System Overview & Core Principles

### Business Scope & Tenancy
- **Single-tenant, multi-location** inventory system built for one business operating across one or more physical sites (**Locations** such as warehouses and stores).
- **Isolated per-company deployment:** When offered as a subscription product, each subscribing company gets its own independent application instance and **100% separate PostgreSQL database** (no `tenant_id` column). Subscriptions, billing, and updates are managed through a separate future **Developer Control Panel**, backed by a lightweight **`iam` Access Switch** hook (`Active` / `Read-Only` / `Suspended`, defaulting to `Active` in Phase 1).

### Core Truth 1 — Bank-Statement Stock History (Append-Only Ledger)
- Stock quantities are **never overwritten directly**.
- Every stock change is recorded as an immutable **Stock Movement** (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`).
- Current stock counts (**On-Hand Stock**, **Reserved Stock**, **Available Stock**, and **In-Transit Stock**) are projected from that ledger into fast balance records for daily operations and concurrency safety.

### Core Truth 2 — Separate Feature Boxes (Modular Monolith)
- One deployable application organized into **strictly isolated feature modules ("boxes")**.
- Modules communicate **only** through explicit **public TypeScript interfaces** (for direct lookups/queries, with cross-module mutations orchestrated inside `shared`'s `executeCommand` unit-of-work seam per [MODULE_SEAMS.md](./MODULE_SEAMS.md)—hiding raw Drizzle `tx` handles, `iam` Access Switch / `AccessPolicy` checks, `shared.idempotency_keys`, and `shared.outbox_events` appends behind one interface so `orders.*`, `inventory.*`, and `shared.outbox_events` commit atomically) and **internal domain events** (for reactions). Cross-module imports are restricted to `modules/<other>/public` and enforced automatically in Phase 1 CI via ESLint (`no-restricted-imports` / `eslint-plugin-boundaries`).
- Modules **never reach directly into another module's database tables**. Each module owns a private PostgreSQL schema (`catalog.*`, `inventory.*`, `orders.*`, `iam.*`, `shared.*`, and later `reporting.*`, `finance.*`), defined with Drizzle `pgSchema('<module>')` and aggregated with an explicit `schemaFilter` in `drizzle.config.ts`. Application code checks usage (`hasReferences()`) before deleting, backed by PostgreSQL `FOREIGN KEY ... ON DELETE RESTRICT` within and across schemas.

### Technology Stack
- **Monorepo:** TypeScript everywhere with `pnpm` workspaces + Turborepo.
- **Web App (`apps/web`):** Next.js / React desktop browser application (Phases 1–3 focus on 1–4 office computers).
- **Backend API (`apps/api`):** Fastify modular monolith exposing versioned **REST + JSON under `/api/v1/*`** (plus unversioned `/health` & `/ready` probes and `/api/auth/*`), validated by Zod schemas in `packages/shared-domain` via `fastify-type-provider-zod` + `@fastify/swagger` (OpenAPI 3.1; `/docs` mounted only when `NODE_ENV !== 'production'`), with uniform envelopes (`{ data, warnings?, page?, meta }` / `{ error }`), uniform cursor/keyset pagination (`(created_at DESC, id DESC)`), Fastify `trustProxy`, and tiered `@fastify/rate-limit` bounds (`1 MB` body, `500` order lines/request) serving both Web and future Mobile clients.
- **Database & ORM:** PostgreSQL + Drizzle ORM (`UUIDv7` primary keys on domain entities/movements, UTC `TIMESTAMPTZ` timestamps, and `NUMERIC(18, 4)` for all quantities and money computed as decimal strings via a fixed-precision decimal library in `packages/shared-domain` and serialized as JSON decimal strings, with strict UI & API validation rejecting >4 decimal places).
- **Authentication:** PostgreSQL-backed sessions via **Better Auth**, with its Drizzle adapter explicitly mapped to `iam.*` tables inside the single Drizzle migration pipeline (proxied same-origin via Next.js `/api/*` for `HttpOnly`, `SameSite=Lax` Web cookies, plus Better Auth Bearer tokens for Phase 4 Mobile, extensible for Phase 2 RBAC, and `iam` Access Switch returning `403 ACCESS_READ_ONLY` / `403 ACCESS_SUSPENDED`).
- **Live Updates:** **"Tap on the Shoulder"** via lightweight invalidation-only Server-Sent Events (`GET /api/v1/events/stream` emitting only `{ seqId, topics, locationIds, skuIds }` — zero quantities, costs, or PII; `: keepalive` every `25s`, max `5` concurrent streams/user) that trigger a quiet background refetch (and one quiet refresh on reconnect—zero idle traffic).
- **Mobile App (`apps/mobile`, Phase 4):** Native mobile app (iOS & Android, e.g., React Native / Expo) reusing shared TypeScript domain types and validation rules.

### Hosting & Cloud Portability
- **Phase 1 Hosting (Local Server):** Containerized app + PostgreSQL running **locally on an old PC via Docker Compose** (\$0 cost during testing).
- **Planned Later-Phase Migration:** Move to Managed Cloud (e.g., Railway or Render) or **Google Cloud (Cloud Run + Cloud SQL)** when scaling across production sites or moving to SaaS.
- **Portability Rule:** Stateless API servers, standard Docker container, standard PostgreSQL features only, and zero platform-specific vendor lock-in so moving from local Docker to the cloud requires zero code rewrites.

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
│   │       └── shared/               # executeCommand, OutboxDispatcher, SSE broadcaster, HTTP setup
│   └── mobile/                       # Phase 4: React Native / Expo offline-first scanner app
├── packages/
│   ├── shared-domain/                # Decimal4 value module, Zod schemas, domain types & constants
│   └── db/                           # Shared PostgreSQL connection, Drizzle config, per-schema migrations
├── docs/
│   ├── ARCHITECTURE_BLUEPRINT.md     # This blueprint
│   ├── MODULE_SEAMS.md               # Settled deep-module seams (D1–D5)
│   ├── API_DESIGN_GAPS.md            # Settled REST API, idempotency & SSE contract (Q1–Q8)
│   ├── DATABASE_DESIGN_GAPS.md       # Settled schema, locking & index decisions
│   ├── ARCHITECTURE_REVIEW_GAPS.md   # Settled system-wide pre-code gaps
│   ├── adr/                          # 8 accepted Architecture Decision Records + index
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

1. **Request-Scoped `AccessPolicy` (`iam`):**
   - `iam.resolvePolicy(actor)` builds a request-scoped `AccessPolicy` once per request: every mutating action goes through `executeCommand` calling `policy.assertCan(action, resource, context)`, every location-scoped read/SSE interface requires `policy.locationScope` (`LocationScope` compile-time token), and response serialization invokes `policy.redactCosts(dto)`.
   - *Phase 1:* Resolves `allLocations: true` and `canViewCosts: true` for any authenticated user (while the `iam` Access Switch defaults to `Active`).
   - *Phase 2+:* Swaps in custom roles, user-level Location scoping, `Allow Negative Stock`, `View Costs & Prices` key omission, and optional dollar/quantity limits without rewriting query or order code.
2. **Saved Event Log / `OutboxDispatcher` (`shared.outbox_events`):**
   - Every stock movement and order status change writes a durable domain event (`StockReceived`, `StockIssued`, `StockAdjusted`, `OrderConfirmed`, etc.) into append-only `shared.outbox_events` with a monotonic `BIGSERIAL` `seq_id` in the **same database transaction** as the change itself via `executeCommand`'s `ctx.emit(event)`.
   - `shared`'s `OutboxDispatcher` owns cursor reads, per-consumer checkpoints (e.g., `reporting.event_checkpoints`), idempotent `event_id` deduplication, a synchronous `drainOutbox()` test helper, and internal wakeup adapters (immediate in-memory nudge on commit + PostgreSQL `LISTEN/NOTIFY` / fallback poll for multi-instance cloud) for SSE pings, Phase 3 reporting read models, and future external Accounting/POS adapters.
3. **Flexible SKU Lookup (`catalog`):**
   - `catalog` exposes a lookup interface accepting either `skuId` or `code`.
   - *Phase 2:* Multi-barcode and QR aliases (UPC, EAN, Code 128, QR) attach cleanly without changing how `orders` or `inventory` reference a SKU.
4. **Sub-Location Hierarchy Plug (`inventory.locations`):**
   - `inventory.locations` includes a nullable `parent_location_id` (self-referencing FK) from Phase 1.
   - *Phase 2:* Enables shelves, aisles, and bins underneath parent Locations without backfills or schema churn. *(Full cost & profit tracking—`unit_cost`, `currency`, per-location Weighted Average Cost, and valuation/margins—was promoted to **active in Phase 1**.)*

---

## 4. Phase 1 (MVP) Core Workflows & Rules

### Catalog & Locations (`catalog` & `inventory`)
- **Lifecycle & Uniqueness:** Products, SKUs, and Locations use `Active` / `Archived` status. Any record with existing Stock Movements or orders cannot be hard-deleted (checked via `hasReferences()` in app code and enforced via PostgreSQL `FOREIGN KEY ... ON DELETE RESTRICT` within and across schemas)—it is archived to preserve ledger history. Unused records may be cleanly deleted. Functional unique indexes enforce case-insensitive uniqueness on SKU `code` (`UNIQUE (LOWER(code))`) and Location `name` (`UNIQUE (LOWER(name))`), and **archived SKU codes are never reused** for new products (un-archive if the exact same SKU returns).
- **Single Base Unit:** Each SKU has one base **Unit of Measure** (e.g., `pcs`, `kg`, `L`). Bulk packs are separate SKUs or converted on receipt. All quantities and monetary amounts store `NUMERIC(18, 4)`, reject inputs exceeding 4 decimal places, and pass through the `Decimal4` branded value module (`Quantity`, `UnitCost`, `Money`, and `calculateWeightedAverageCost`) in `packages/shared-domain`.
- **Locations:** Represent physical buildings/sites (e.g., Main Warehouse, Downtown Store), including a nullable `parent_location_id` self-FK so sub-locations (bins/shelves) can plug in underneath later without rewriting the ledger.

### Stock Ledger, Real-Time Counts, Costing & Negative Stock (`inventory`)
- **Append-Only Ledger & DB Immutability:** Every change appends an immutable `StockMovement` (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`) recording `id` (`UUIDv7`), `skuId`, `locationId`, `quantityDelta`, `unitCost`, `currency`, `reasonCategory`, `referenceType`/`referenceId`, `actorId`, `idempotencyKey` (`UUID`, unique from Phase 1 to prevent double-clicks/retries and power Phase 4 mobile sync; multi-line order actions pair request-level `shared.idempotency_keys` in the same DB transaction with deterministic per-line UUIDv5 movement keys), and `createdAt` (`TIMESTAMPTZ`). A PostgreSQL `BEFORE UPDATE OR DELETE` trigger rejects any mutation or deletion at the database layer.
- **Projected Stock Balances & Safe Locking:** `inventory.stock_balances` uses a composite PK `(sku_id, location_id)` tracking `on_hand`, `reserved`, `available` (`GENERATED ALWAYS AS (on_hand - reserved) STORED`), and `in_transit`. Write paths upsert missing rows (`INSERT ... ON CONFLICT DO NOTHING`) and deterministically sort `(sku_id, location_id)` pairs before acquiring `SELECT ... FOR UPDATE` locks so concurrent multi-line orders never deadlock.
- **Phase 1 Cost & Profit Tracking (Per-Location WAC):** Purchase Order lines and `RECEIPT` movements capture `unit_cost` (`NUMERIC(18, 4)`) and `currency` (`CHAR(3)`), updating Weighted Average Cost per `(sku_id, location_id)` and powering valuation & profit tracking from Phase 1 (with Per-Location / Company-wide view toggle). Under negative stock: when `oldQty <= 0` and `newQty > 0`, WAC resets to the incoming `unitCost`; when `newQty <= 0`, `lastKnownWac` is preserved and rows `<= 0` are flagged `"Estimated — Negative Stock"` on the Valuation Report until reconciled.
- **Flexible Negative Stock:** In Phase 1, both `Available Stock` and `On-Hand Stock` are allowed to drop below zero so urgent operations are never blocked. Whenever either drops to `<= 0`, the system warns the user and places a visible **Zero / Negative Stock** marker (backed by a partial index `WHERE on_hand <= 0 OR available <= 0`) for follow-up reconciliation. *(In Phase 2, `Allow Negative Stock` becomes a role permission.)*
- **Phase 1 Speed Indexes:** Dedicated indexes on `stock_movements (sku_id, location_id, created_at DESC)`, `stock_movements (reference_type, reference_id)`, `UNIQUE (idempotency_key)`, partial `stock_balances (location_id, sku_id) WHERE on_hand <= 0 OR available <= 0`, `orders (status, created_at DESC)`, and `orders (location_id, status)`.
- **Manual Adjustments:** Every manual `ADJUSTMENT` requires a `reasonCategory` (`STOCK_COUNT`, `DAMAGED`, `EXPIRED`, `LOST`, `OTHER`) and supports an optional free-text note.

### Order Workflows & Edge Cases (`orders` → `inventory`)
- **Partial Fulfillment & Guardrails:** Purchase Orders, Sales Orders, and Transfer Orders track `orderedQty` vs. fulfilled quantities per line item with database `CHECK (ordered_qty > 0)` and `CHECK (fulfilled_qty >= 0)` constraints, plus integer `version` / `expectedVersion` optimistic locking (`409 STALE_VERSION`) on mutable `Draft` order `PATCH` edits. Customer **Sales Orders** strictly cap shipping at `orderedQty` (`422 OVER_SHIP_NOT_ALLOWED`), while supplier **Purchase Orders** allow over-receiving (`fulfilled_qty > ordered_qty`) after a UI confirmation warning backed by explicit `allowOverReceive: true` on `POST /api/v1/purchase-orders/:id/receipts` (`422 OVER_RECEIVE_CONFIRMATION_REQUIRED` if omitted).
- **Purchase Orders (Supplier → Location):** `Draft` → `Confirmed` → `Partially Received` → `Received` (or `Cancelled`). Receiving items records a `RECEIPT` movement into the destination Location's `On-Hand Stock` (with `unitCost` updating per-location WAC).
- **Sales Orders (Location → Customer):** `Draft` → `Confirmed` (increases `Reserved Stock`) → `Partially Shipped` / `Shipped` (releases reservation and records an `ISSUE` movement deducting `On-Hand Stock`) → `Delivered`. Customer returns or rejected deliveries record a `RECEIPT` movement (`reason: CUSTOMER_RETURN`) when goods physically return.
- **Transfer Orders (Location A → Location B):** `Draft` → `Confirmed` → `In-Transit` (Location A dispatches via `inventory/public`'s `dispatchTransfer`: `TRANSFER_OUT` deducts A's `On-Hand Stock` at A's WAC, **snapshots A's `Weighted Average Cost` onto the `TRANSFER_OUT` movement/dispatch record**, and adds to `In-Transit Stock`) → `Partially Received` / `Received` (Location B receives via `receiveTransfer`: `TRANSFER_IN` deducts `In-Transit Stock` and adds to B's `On-Hand Stock` at the exact snapshotted dispatch cost, even if Location A's WAC changes while `In-Transit`). Missing or damaged remainders can be closed out with a discrepancy reason so stock never remains stuck `In-Transit`.
- **Order Cancellations / Early Close:** Cancelling or closing a partially fulfilled order preserves all already-recorded Stock Movements, releases any remaining `Reserved Stock` back to `Available Stock`, and closes the unfulfilled remainder.

---

## 5. Phased Roadmap Summary (Phases 1–5)

Because future features live in isolated boxes behind Phase 1's extension points, the post-MVP order below is **flexible** (with two natural dependencies noted):

- **Phase 1 — MVP Core + Cost & Profit Tracking (Local Docker on Old PC):**
  `catalog` (Products, SKUs, Units), `inventory` (Locations, Append-Only Stock Ledger, Projected Balances, Per-Location Weighted Average Cost & Profit Tracking), `orders` (Purchase, Sales, Transfer Orders), basic `iam` (Better Auth login in `iam.*`, `authorize()` gate, `Access Switch`), the Saved Event Log (Outbox), and ESLint module boundary enforcement—hosted locally on an old PC via Docker Compose.
- **Phase 2 — Permissions (#7) & Barcodes/QR (#2):**
  - **RBAC (`iam`):** Protected `Owner` role + 4 editable starter roles (`Admin`, `Manager`, `Staff`, `Viewer`), custom role builder, user-level Location scoping, `Allow Negative Stock` & `View Costs & Prices` checkboxes, optional dollar/quantity limits, immediate enforcement, and immutable IAM Audit Log (`BEFORE UPDATE OR DELETE` locked).
  - **Barcodes & QR (`catalog`) & Sub-Locations:** Multiple barcodes per SKU (UPC, EAN, Code 128, QR), blank-by-default with on-demand "Generate Barcode", browser print-ready PDFs (office sheets & thermal rolls), handheld + camera scan-to-increment (+1), Owner-configurable unknown/unexpected scan handling, and sub-location hierarchy using `parent_location_id`.
- **Phase 3 — Advanced Reporting & Analytics (#4):**
  - Dedicated `reporting` read models updated via outbox checkpoints (`reporting.event_checkpoints`) + short-term caching.
  - Expands Phase 1 Valuation (Weighted Average Cost with `"Estimated — Negative Stock"` flags) into full Low-Stock & Reorder, Stock Movement & Adjustment History, Inventory Turnover & Aging reports, and CSV / Excel (`.xlsx`) / PDF exports (dollar columns gated by `View Costs & Prices`).
- **Phase 4 — Cloud Hosting, Live Sync & Mobile (#6):**
  - *(Naturally builds on Barcodes #2.)*
  - Move from local Docker hosting to Managed Cloud / **Google Cloud (Cloud Run + Cloud SQL)** when ready for multi-site cloud access.
  - **"Tap on the Shoulder"** SSE invalidation pings + quiet background refresh across desktop and mobile.
  - **Native Mobile App (`apps/mobile`)** with offline-first warehouse scanning (`UUIDv7` + `idempotency_key`): **Physical Reality Wins** on reconnect—queued offline movements replay into the ledger, and any clash with server state flags a **Manager Exception** for paperwork reconciliation.
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
   - [ADR-0008: REST API Contract, Multi-Line Idempotency & Invalidation SSE](./adr/0008-rest-api-contract-idempotency-and-sse.md)

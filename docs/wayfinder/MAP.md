# Wayfinder Map: Inventory System V2

**Label:** `wayfinder:map`

## Destination

A complete, decision-ready **Architecture & Domain Blueprint** for Inventory System V2—including a `GLOSSARY.md`, Architecture Decision Records (ADRs), a modular boundary & folder structure design, and a phased roadmap from Phase 1 (MVP) through all 7 target features—ready to hand off to implementation.

## Notes

- **Domain & Tenancy:** Single-tenant system with multi-location support (warehouses/stores as a first-class concept) and clean workspace isolation so it can evolve later if needed.
- **Phase 1 (MVP) Scope:** Catalog (Items/SKUs) + Locations + Real-Time Stock Ledger (In/Out/Adjustments) + Basic Purchase & Sales Orders behind basic authentication.
- **Core Truth 1 — Bank-Statement Stock History (Append-Only Ledger):** Stock quantities are never overwritten directly. Every change is recorded as an immutable movement event (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER`), and current stock is calculated/projected from that history.
- **Core Truth 2 — Separate Feature Boxes (Modular Monolith):** One deployable application organized into strictly isolated feature modules that communicate only through explicit public interfaces and domain events—never reaching into each other's database tables.
- - **Tech Stack:** TypeScript everywhere (Next.js/React web + Node/TypeScript backend) + PostgreSQL database, structured as a monorepo so domain types and validation rules can be shared across web, server, and a future mobile app.
- **Security & Scale Objective:** Backend system design must be secure and remain stable under heavy use and high traffic.
- **Concurrency & Live Updates:** System must remain stable and consistent when multiple users make live updates at the same time.
- **Planned Cloud Migration (Future SaaS):** Start on a Managed Cloud Platform (Railway/Render + Managed PostgreSQL), with a planned future migration to **Google Cloud (Cloud Run + Cloud SQL)**. Keep the system design strictly portable—standard Docker container, stateless app servers, standard PostgreSQL, and zero platform-specific vendor lock-in.
- **Communication Style:** Keep discussions in plain, everyday English (avoid unnecessary technical jargon) and ask grilling questions one at a time via interactive prompts.
- **Skills to consult per session:** `grilling`, `domain-modeling`.

## Decisions so far

<!-- One line per closed ticket, linking to the ticket that holds the detail. -->
- [001: Domain Glossary and Core Entities](./tickets/001-domain-glossary-and-core-entities.md): Locked core domain terms in `GLOSSARY.md` (Product/SKU, single base Unit of Measure, site-level Locations, On-Hand/Reserved/Available Stock, Purchase/Sales Orders, and Transfer Orders with In-Transit state).
- [002: TypeScript Monorepo & Backend Tooling](./tickets/002-typescript-stack-tooling.md): Locked `pnpm` + Turborepo, Fastify, Drizzle ORM, and PostgreSQL-backed session auth (Better Auth).
- [003: Modular Architecture & Feature Box Boundaries](./tickets/003-modular-architecture-and-boundaries.md): Locked 4 feature boxes (`catalog`, `inventory`, `orders`, `iam`), public interfaces + internal domain events, and separate PostgreSQL schemas per box.
- [004: Phase 1 (MVP) Workflows & Data Model](./tickets/004-phase-1-mvp-workflows-and-data-model.md): Locked Phase 1 workflows—flexible negative stock (warning + marker), Reserve-on-Confirm / Issue-on-Ship Sales Orders with Return receipts, partial receiving/shipping, Transfer Order In-Transit discrepancy closeout, required adjustment reasons, and archive-only lifecycle for used SKUs/Locations.
- [005: Phased Roadmap & Module Extension Points](./tickets/005-phased-roadmap-and-extension-points.md): Locked four Phase 1 extension points (single `iam` permission gate, durable transactional event outbox, flexible `catalog` SKU code lookup, and optional `unitCost` on receipts) and recorded the flexible default rollout order (Phase 2: Permissions & Barcodes → Phase 3: Reporting → Phase 4: Mobile & Live Sync → Phase 5: Accounting & POS).
- [006: Role-Based Permissions (Feature #7)](./tickets/006-role-based-permissions.md): Locked protected `Owner` + 4 editable starter/custom roles, user-level Location scoping, granular permission checkboxes (including `Allow Negative Stock` and `View Costs & Prices`), optional dollar/quantity limits, immediate enforcement, and an immutable IAM Audit Log.
- [007: SKU & Barcode/QR Management (Feature #2)](./tickets/007-sku-and-barcode-management.md): Locked multi-barcode-per-SKU support (UPC, EAN, Code 128, QR), on-demand "Generate Barcode" button, browser print-ready PDFs (office sheets & thermal rolls), handheld + camera scan-to-increment (+1), and Owner-configurable unknown/unexpected scan handling.
- [008: Reporting & Analytics (Feature #4)](./tickets/008-reporting-and-analytics.md): Locked Weighted Average Cost (stored per-Location with Per-Location / Company-wide UI toggle and hover formula popovers), 4 core reports (Valuation, Low-Stock, Movement History, Turnover/Aging), CSV/Excel/PDF exports, `View Costs & Prices` gating, and event-driven summary tables + short-term caching.
- [009: Cloud Access & Mobile Apps (Feature #6)](./tickets/009-cloud-access-and-mobile-apps.md): Locked containerized Managed Cloud Platform hosting (Railway/Render + Managed PostgreSQL, portable to Google Cloud for future SaaS), Server-Sent Events (SSE) for live screen updates, and a Phase 4 native mobile app (iOS/Android) with offline scanning where physical reality wins on reconnect and clashes become Manager Exceptions.
- [010: Accounting & POS Integration (Feature #5)](./tickets/010-accounting-and-pos-integration.md): Replaced live accounting sync and full POS with an internal `finance` Cash & Expense Tracker (user-defined categories, payment-based Cash Balance, Owner/Admin gated) and a 1-step Quick Counter Sale screen, while keeping the Saved Event Log ready for future external Accounting/POS plug-ins.
- [011: Final Architecture & Domain Blueprint Packaging](./tickets/011-final-architecture-and-domain-blueprint.md): Packaged all settled decisions from Tickets 001–010 into `docs/ARCHITECTURE_BLUEPRINT.md` (monorepo & feature-box structure, Phase 1 extension points, workflows, and phased roadmap), with final `GLOSSARY.md` polish and `docs/adr/` records queued for the dedicated `/domain-modeling` session.

## Not yet specified

<!-- In-scope fog that depends on earlier decisions and will graduate into tickets as the frontier advances: -->
- *(Wayfinder Map complete — all 11 tickets are closed. Next step: run `/domain-modeling` to finalize `GLOSSARY.md` and write key ADRs in `docs/adr/`.)*

## Out of scope

<!-- Work ruled beyond the destination; closed, never graduates. -->
- Writing production application code or setting up the GitHub repository during this planning map (this map stops at the handoff-ready blueprint).

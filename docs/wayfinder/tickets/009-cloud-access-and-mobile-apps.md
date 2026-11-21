# 009: Cloud Access & Mobile Apps (Feature #6)

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [005: Phased Roadmap & Module Extension Points](./005-phased-roadmap-and-extension-points.md), [006: Role-Based Permissions (Feature #7)](./006-role-based-permissions.md), [007: SKU & Barcode/QR Management (Feature #2)](./007-sku-and-barcode-management.md)

## Question

What hosting/deployment topology, real-time live-update transport (WebSockets vs. SSE), and offline-capable mobile warehouse scanning/conflict-resolution workflows should be designed for Phase 4? *(Note: Naturally builds on Barcodes #2 and Permissions #7 in the flexible default roadmap.)*

## Resolution

1. **Cloud Hosting & Deployment Topology (Containerized Managed Cloud, SaaS-Portable):**
   - **Initial Hosting:** Deploy on a **Managed Cloud Platform** (e.g., Railway or Render) paired with **Managed PostgreSQL** for automatic HTTPS, automated daily backups, predictable pricing, and minimal server maintenance.
   - **Planned Migration to Google Cloud (Future SaaS):** Migrating to **Google Cloud (Cloud Run + Cloud SQL)** is a **planned future migration** (for scaling / multi-tenant SaaS). Keep the modular monolith stateless, packaged in a standard **Docker container**, and relying only on standard PostgreSQL features—with zero Managed-Cloud-Platform-specific proprietary lock-in—so the move requires zero code rewrites.
2. **Real-Time Live Updates (SSE):**
   - Use **Server-Sent Events (SSE)** for automatic one-way live updates of stock levels and order statuses across open screens (1–4 office computers in Phases 1–3, and mobile devices in Phase 4) without requiring manual page refreshes.
3. **Mobile App & Offline Warehouse Scanning (Phase 4):**
   - **App Form Factor:** Plan a **native mobile app (iOS & Android, e.g., React Native / Expo)** for Phase 4, reusing shared TypeScript domain types and validation rules from the monorepo. *(Phases 1–3 remain desktop browser-only for 1–4 computers.)*
   - **Offline-First, Operations-Never-Halt Policy:** Allow workers to keep scanning during Wi-Fi drops so warehouse operations never pause.
   - **Conflict Resolution (Physical Reality Wins):** On reconnect, replay queued offline movement events into the append-only stock ledger—never rejecting physical movements or asking workers to haul goods back. If a replayed scan clashes with server state (e.g., an order was cancelled at the office or stock dips negative), accept the physical movement and automatically flag a **Manager Exception** for paperwork reconciliation.

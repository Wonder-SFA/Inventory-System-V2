# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for Inventory System V2. Each record captures a significant, hard-to-reverse decision, the trade-offs considered, and why we chose our path.

## Index

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](./0001-modular-monolith-and-schema-isolation.md) | Modular Monolith & Isolated PostgreSQL Schemas | Accepted | 2026-11-21 |
| [0002](./0002-append-only-stock-ledger-and-outbox.md) | Append-Only Stock Ledger & Transactional Outbox | Accepted | 2026-11-21 |
| [0003](./0003-typescript-monorepo-and-core-stack.md) | TypeScript Monorepo & Core Stack | Accepted | 2026-11-21 |
| [0004](./0004-flexible-negative-stock-policy.md) | Flexible Negative Stock Policy | Accepted | 2026-11-21 |
| [0005](./0005-per-location-weighted-average-cost.md) | Per-Location Weighted Average Cost | Accepted | 2026-11-21 |
| [0006](./0006-offline-mobile-physical-reality-wins.md) | Offline Mobile Sync — Physical Reality Wins & Manager Exceptions | Accepted | 2026-11-21 |
| [0007](./0007-portable-containerized-cloud-hosting.md) | Portable Containerized Cloud Hosting | Accepted | 2026-11-21 |

## ADR Lifecycle Rules

- **Proposed**: Under discussion, not yet locked.
- **Accepted**: Decision made and active for implementation.
- **Deprecated**: No longer applies.
- **Superseded**: Replaced by a newer ADR.

**Never silently edit an accepted ADR to change a decision.** When an accepted decision needs to change later, write a new ADR that marks the earlier one as `Superseded by ADR-NNNN` so future readers preserve the full history of *why* the system evolved.

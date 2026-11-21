# ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas

**Status:** Accepted
**Date:** 2026-11-21

## Context

Inventory System V2 starts with a Phase 1 MVP (`catalog`, `inventory`, `orders`, and `iam`) and grows over five phases to add Role-Based Permissions, Barcodes/QR, Reporting & Valuation, Live Sync & Offline Mobile, and an internal Cash & Expense Tracker + Quick Counter Sale (`finance`). We need a structure that lets new feature areas plug in cleanly without rewriting existing code, while keeping deployment simple for a small team.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Microservices from day one** | Independent deployments and strict physical process separation | Heavy network, auth, distributed transaction, and operational overhead for Phase 1 |
| **Traditional monolith with one shared DB schema** | Fast initial wiring | Modules quickly tangle together by joining directly across each other's database tables |
| **Modular monolith with separate PostgreSQL schemas** | Single deployable app with strict code and database boundaries | Requires discipline around public interfaces and domain events |

## Decision & Rationale

We will build a **modular monolith** organized into isolated feature boxes—starting with `catalog`, `inventory`, `orders`, and `iam` in Phase 1, and adding `reporting` (Phase 3) and `finance` (Phase 5) later.

- **Module communication:** Boxes talk to each other **only** through explicit public TypeScript interfaces (for direct queries) and internal domain events (for reactions). Cross-module imports are restricted to `modules/<other>/public` and enforced automatically in Phase 1 CI via ESLint (`no-restricted-imports` / `eslint-plugin-boundaries`).
- **Cross-module transactions:** Cross-module mutations run inside `shared`'s `executeCommand` unit-of-work seam (per [MODULE_SEAMS.md](../MODULE_SEAMS.md)), encapsulating the underlying `TransactionContext` (Drizzle `tx` handle), `iam` gate, idempotency replay/UUIDv5 derivation, and `shared.outbox_events` append so `orders.*`, `inventory.*`, and `shared.outbox_events` commit atomically in a single PostgreSQL transaction without leaking raw `tx` handles across callers. `inventory/public` exposes batch domain intents (`reserveStock`, `releaseReservation`, `postMovements`, `dispatchTransfer`, `receiveTransfer`).
- **Database ownership & migrations:** Each box owns its own private PostgreSQL schema (`catalog.*`, `inventory.*`, `orders.*`, `iam.*`, `shared.*`, plus `reporting.*` and `finance.*`), defined with Drizzle's `pgSchema('<module>')` and aggregated with an explicit `schemaFilter` in `drizzle.config.ts`. Better Auth's Drizzle adapter is configured explicitly against `iam.*` tables inside the single Drizzle migration pipeline.
- **Referential integrity & deletion:** Application code checks usage (`hasReferences()`) via public TypeScript interfaces before deleting so used SKUs/Locations archive cleanly. Because each company runs a dedicated PostgreSQL database, `FOREIGN KEY ... ON DELETE RESTRICT` is enforced both within and across schemas as a database-level backup lock against accidental deletion.

This gives us microservices-grade boundaries (for example, guaranteeing that only `inventory` ever writes to the stock ledger) without the operational complexity of distributed services, and leaves a clean path to split out a service later if needed.

## Consequences

- **Positive:** Future features (Reporting, Mobile SSE, Finance, or external Accounting/POS adapters) can subscribe to events and call public interfaces without modifying `catalog`, `inventory`, or `orders`.
- **Positive:** Database locks and stock consistency stay inside one PostgreSQL transaction boundary.
- **Negative:** Cross-module queries cannot use ad-hoc SQL joins across schemas; read models or public interface lookups are required.
- **Risks & Mitigations:** A developer could bypass module boundaries by importing internal files or querying another schema. Mitigate with clear folder conventions (`public/`, `db/`, `domain/`, `events/`) and lint/import boundary checks.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0003: TypeScript Monorepo & Core Stack](./0003-typescript-monorepo-and-core-stack.md)

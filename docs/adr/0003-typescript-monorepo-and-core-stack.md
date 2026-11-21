# ADR-0003: TypeScript Monorepo & Core Stack

**Status:** Accepted
**Date:** 2026-11-21

## Context

Inventory System V2 needs a desktop web application in Phases 1–3, a standalone API capable of serving both desktop browsers and a Phase 4 native mobile app, predictable SQL behavior for concurrent stock ledger updates, and built-in authentication that scales cleanly into Phase 2 Role-Based Permissions without vendor lock-in.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Next.js API routes / tRPC only** | Fewer moving parts initially | Tightly couples the backend to Next.js when adding a standalone native mobile app and SSE streams |
| **Prisma ORM** | Popular developer experience | Heavier runtime abstraction; harder to control exact PostgreSQL locking and multi-schema ledger queries |
| **Hosted third-party auth (e.g., Auth0 / Clerk)** | Fast initial login UI | External cost, vendor lock-in, and extra syncing to enforce custom roles and Location scopes inside local DB transactions |
| **`pnpm` + Turborepo, Fastify, Drizzle ORM, Better Auth, Next.js** | Clean standalone API, full SQL control, zero auth lock-in, shared TS types across web/API/mobile | Requires managing separate `apps/web` and `apps/api` processes |

## Decision & Rationale

We will standardize on a **TypeScript monorepo (`pnpm` workspaces + Turborepo)** with:
- **Frontend Web (`apps/web`):** Next.js / React.
- **Backend API (`apps/api`):** **Fastify** (lightweight, fast standalone server exposing versioned REST + JSON under `/api/v1/*` validated with Zod in `packages/shared-domain` via `fastify-type-provider-zod` + `@fastify/swagger` OpenAPI 3.1 per [ADR-0008](./0008-rest-api-contract-idempotency-and-sse.md) to cleanly serve the web app, SSE live streams, and the future React Native / Expo mobile app).
- **Database & ORM:** **PostgreSQL + Drizzle ORM** (stays close to SQL for predictable multi-schema tables via `pgSchema('<module>')` + `schemaFilter` in `drizzle.config.ts`, row locking, and transactional outbox writes). All domain entities use **`UUIDv7`** primary keys and **`TIMESTAMPTZ`** (UTC) timestamps.
- **Exact Numeric Precision:** Quantities and money standardize on **`NUMERIC(18, 4)`** in `packages/db`, represented in TypeScript as decimal strings and computed via a fixed-precision decimal library in `packages/shared-domain` (never JavaScript `number` floats), backed by a strict UI & API validation guardrail rejecting inputs with more than 4 decimal places.
- **Authentication:** **Better Auth** with its Drizzle adapter explicitly mapped to `iam.*` tables inside the single Drizzle migration pipeline (same-origin `/api/*` Next.js proxy with `HttpOnly`, `SameSite=Lax` cookies for Web, Bearer tokens for Phase 4 mobile, and natural extension into Phase 2 `iam` roles, Location scoping, and the `authorize(actor, action, resource)` gate).

## Consequences

- **Positive:** Domain types, validation rules, and glossary vocabulary live in `packages/shared-domain` and are reused across web, API, and mobile without drift.
- **Positive:** Zero external auth vendor lock-in; permission and Location changes take effect immediately on the user's next request.
- **Negative:** Running separate web and API apps adds minor local/container orchestration compared to a single Next.js app.
- **Risks & Mitigations:** Keep local startup and Docker packaging unified in the monorepo scripts so both services run cleanly with one command.

## Related Decisions

- [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./0001-modular-monolith-and-schema-isolation.md)
- [ADR-0007: Portable Containerized Cloud Hosting](./0007-portable-containerized-cloud-hosting.md)
- [ADR-0008: REST API Contract, Multi-Line Idempotency & Invalidation SSE](./0008-rest-api-contract-idempotency-and-sse.md)

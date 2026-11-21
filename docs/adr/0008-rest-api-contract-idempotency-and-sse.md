# ADR-0008: REST API Contract, Multi-Line Idempotency & Invalidation SSE

**Status:** Accepted
**Date:** 2026-11-21

## Context

[ADR-0003](./0003-typescript-monorepo-and-core-stack.md) selects Fastify (`apps/api`) as a standalone backend serving `apps/web` in Phases 1–3 and an independently deployed native mobile app (`apps/mobile`) in Phase 4, while [ADR-0002](./0002-append-only-stock-ledger-and-outbox.md) mandates `UNIQUE (idempotency_key)` on `inventory.stock_movements` and [ADR-0007](./0007-portable-containerized-cloud-hosting.md) mandates "Tap on the Shoulder" SSE updates. Before writing Phase 1 endpoints, we must settle the HTTP contract, multi-line order idempotency semantics, warning/cost-redaction response structure, pagination, auth transport, SSE payload boundaries, and draft concurrency protection so independently deployed mobile clients and Phase 2 RBAC plug in without breaking changes.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| **tRPC-only on Fastify + offset pagination + full-payload SSE** | Minimal boilerplate in web-only Phase 1; jump-to-page UI | Weaker runtime contract for independently deployed Phase 4 mobile builds; still needs REST for auth/SSE/exports; offset paging drifts under concurrent inserts; full-payload SSE risks leaking Phase 2 cost/Location-restricted data |
| **HTTP-only idempotency (`shared.idempotency_keys`) without ledger keys** | Avoids multi-line key derivation | Drops database-level duplicate-scan enforcement on `inventory.stock_movements` for Phase 4 offline batch sync |
| **Cross-origin Fastify port/domain + `?token=` SSE URLs** | No Next.js API proxy needed | CORS/`SameSite` cookie friction across Docker & Cloud Run; query-string tokens leak session secrets into proxy logs |
| **Versioned REST + Zod/OpenAPI 3.1, `shared.idempotency_keys` + per-line UUIDv5, uniform envelope/cursor, same-origin proxy & invalidation-only SSE** | Runtime-safe for deployed mobile builds, atomic multi-line idempotency + DB scan lock, zero PII/cost leaks over SSE, and zero cross-origin web friction | Requires maintaining Next.js `/api/*` proxy rewrites and explicit `shared.idempotency_keys` + `version` columns from Phase 1 |

## Decision & Rationale

We will standardize the Fastify HTTP and SSE boundary on eight rules:

1. **REST + JSON, Zod & URI Versioning (`/api/v1/*`):** Expose REST + JSON under `/api/v1/*` (keeping `/health` and `/ready` unversioned and Better Auth on `/api/auth/*`), validated by Zod schemas in `packages/shared-domain` via `fastify-type-provider-zod` + `@fastify/swagger` (OpenAPI 3.1). Use Glossary-aligned plural kebab-case nouns and explicit command `POST` endpoints for state transitions (`/confirm`, `/receipts`, `/shipments`, `/deliver`, `/returns`, `/dispatch`, `/close-discrepancy`, `/cancel`, `/archive`, `/unarchive`) plus `GET /api/v1/skus/lookup?code=...`. Mount `/docs` only when `NODE_ENV !== 'production'`, and run CI OpenAPI breaking-change diffs once Phase 4 mobile ships.
2. **Multi-Line Order Idempotency:** Require `Idempotency-Key: <uuid>` on every stock-mutating and order-fulfilling `POST` endpoint. Store request-level replay state in `shared.idempotency_keys` inside the **same DB transaction** (replaying `200`/`201` on identical payload hash and returning `409 IDEMPOTENCY_KEY_CONFLICT` on mismatch) and derive deterministic per-line **UUIDv5** keys (`(requestKey, lineId)`) for `inventory.stock_movements.idempotency_key` (while Phase 4 batch mobile sync passes per-scan UUIDs directly).
3. **Uniform Envelopes, Warnings, Decimals & Cost Redaction:** Use `{ data, warnings?, page?, meta: { requestId } }` for `2xx` responses and `{ error: { code, message, details?, requestId } }` for `4xx`/`5xx` (no stack traces or raw SQL). Serialize all `NUMERIC(18, 4)` quantities/money as JSON decimal strings (rejecting `> 4` decimals with `422 DECIMAL_PRECISION_EXCEEDED`). Mark cost/valuation fields optional from Phase 1 so Phase 2 omits them when `View Costs & Prices` is false (never `"0.0000"`). Require `allowOverReceive: true` on Purchase Order receipts when exceeding `orderedQty` (`422 OVER_RECEIVE_CONFIRMATION_REQUIRED` otherwise; Sales Orders always cap at `orderedQty` with `422 OVER_SHIP_NOT_ALLOWED`).
4. **Uniform Cursor / Keyset Pagination:** Paginate all list endpoints via opaque base64url `cursor` over `(created_at DESC, id DESC)` (default `limit=50`, max `100`, invalid cursor → `400 INVALID_CURSOR`), guaranteeing zero duplicate IDs across pages on append-only tables.
5. **Same-Origin Web Proxy, Mobile Bearer Auth & Invalidation-Only SSE:** Proxy `/api/*` same-origin through Next.js (`apps/web`) to Fastify for `HttpOnly`, `SameSite=Lax` cookies and browser `EventSource`; enable Better Auth Bearer tokens (`Authorization: Bearer`) for Phase 4 mobile (never `?token=` in URLs). Restrict `GET /api/v1/events/stream` to minimal invalidation-only pings (`seqId`, `topics`, `locationIds`, `skuIds` — zero quantities, costs, or PII), `: keepalive\n\n` every `25s`, max `5` concurrent streams/user, one quiet client refetch on reconnect, and Phase 2 Location filtering. Enforce `iam` Access Switch in Fastify `preHandler` (`403 ACCESS_READ_ONLY` on mutations; `403 ACCESS_SUSPENDED` across `/api/v1/*` except `/health`, `/api/v1/session`, and sign-out).
6. **Draft Order Optimistic Locking:** Maintain an integer `version` column on orders; require `expectedVersion` on `PATCH /api/v1/*-orders/:id` edits and return `409 STALE_VERSION` on mismatch.
7. **Proxy-Aware Rate Limiting & Payload Caps:** Enable Fastify `trustProxy` for Next.js / Cloud Run proxy hops; apply tiered `@fastify/rate-limit` limits (`10/min` per IP on auth, `120/min` per user on mutations, `300/min` per user on reads, in-memory in Phase 1 single-container Docker); cap payloads at `1 MB` body, `500` order lines/request, and `200` Phase 4 mobile sync scans/batch; expose `GET /health` and `GET /ready`.

## Consequences

- **Positive:** One consistent HTTP/SSE contract serves Phase 1 web, Phase 2 RBAC redaction, Phase 4 offline mobile, and Phase 5+ integrations without breaking deployed clients or leaking sensitive fields.
- **Positive:** Double-clicks on multi-line orders replay cleanly without violating ledger uniqueness or losing per-scan offline deduplication.
- **Negative:** Adding `shared.idempotency_keys`, Next.js `/api/*` proxy rewrites, and order `version` fields adds modest upfront scaffolding in Phase 1.
- **Risks & Mitigations:** Over time, `shared.idempotency_keys` grows with mutations; add a simple TTL retention cleanup job (e.g., pruning expired request cache rows older than 24–72h) without ever touching `inventory.stock_movements`.

## Related Decisions

- [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./0002-append-only-stock-ledger-and-outbox.md)
- [ADR-0003: TypeScript Monorepo & Core Stack](./0003-typescript-monorepo-and-core-stack.md)
- [ADR-0004: Flexible Negative Stock Policy](./0004-flexible-negative-stock-policy.md)
- [ADR-0005: Per-Location Weighted Average Cost](./0005-per-location-weighted-average-cost.md)
- [ADR-0006: Offline Mobile Sync — Physical Reality Wins & Manager Exceptions](./0006-offline-mobile-physical-reality-wins.md)
- [ADR-0007: Portable Containerized Cloud Hosting](./0007-portable-containerized-cloud-hosting.md)

# ADR-0007: Portable Containerized Cloud Hosting

**Status:** Accepted
**Date:** 2026-11-21

## Context

The business wants **$0-cost local hosting on an old computer during Phase 1 testing** (1–4 office computers) before moving to managed cloud hosting—and ultimately **Google Cloud (Cloud Run + Cloud SQL)**—in later phases as the system rolls out across production locations or expands into a multi-tenant SaaS offering.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Start directly on full Google Cloud infrastructure** | No later migration step | Higher upfront IAM, networking, and DevOps setup overhead before product-market fit |
| **Use platform-specific PaaS features (proprietary queues, auth, or DB extensions)** | Fast initial glue code | Creates painful vendor lock-in that requires rewrites when moving to Google Cloud |
| **Standard Docker container + Managed Cloud Platform + standard PostgreSQL** | Simple day-one operations with a zero-rewrite migration path to Cloud Run + Cloud SQL | Must avoid proprietary Managed-Cloud-only features |

## Decision & Rationale

We will run **Phase 1 locally on an old PC via Docker Compose** (with zero code differences from production), deferring **Managed Cloud Hosting / Google Cloud (Cloud Run + Cloud SQL)** to a later phase while enforcing strict **cloud portability** from day one:

- Package `apps/api` and `apps/web` as **standard Docker containers** alongside standard PostgreSQL.
- Keep API application servers **stateless** (sessions live in PostgreSQL via Better Auth; background consumers read from the PostgreSQL outbox).
- **Live Screen Updates ("Tap on the Shoulder"):** Real-time UI updates use a lightweight invalidation-only SSE ping on `GET /api/v1/events/stream` (`seqId`, `topics`, `locationIds`, `skuIds` — zero quantities, costs, or PII; `: keepalive` every `25s`, max `5` streams/user) that triggers a quiet background data refetch (and one quiet refresh on reconnect after Wi-Fi drops, local PC reboots, or future Cloud Run recycles)—zero idle polling traffic and zero complex client-side event-replay state.
- Rely strictly on **standard PostgreSQL** features and standard environment-variable configuration, with zero proprietary hosting lock-in, Fastify `trustProxy` enabled for Next.js / Cloud Run proxy hops, and unversioned `GET /health` & `GET /ready` container probes per [ADR-0008](./0008-rest-api-contract-idempotency-and-sse.md).

## Consequences

- **Positive:** Fast, predictable initial deployment without dedicated DevOps staff.
- **Positive:** Migrating to Google Cloud (Cloud Run + Cloud SQL) later requires updating deployment/DNS config and restoring a PostgreSQL dump—zero application code rewrites.
- **Negative:** Forgoes platform-specific managed queues or proprietary add-ons in favor of PostgreSQL-backed patterns (outbox, sessions, SSE).
- **Risks & Mitigations:** Over time, SSE connections on stateless containers require care when scaling to multiple API instances; if horizontal scaling is needed on Cloud Run later, back SSE fan-out with PostgreSQL `LISTEN/NOTIFY` or a portable Pub/Sub adapter behind the `shared` broadcaster interface.

## Related Decisions

- [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./0001-modular-monolith-and-schema-isolation.md)
- [ADR-0003: TypeScript Monorepo & Core Stack](./0003-typescript-monorepo-and-core-stack.md)
- [ADR-0008: REST API Contract, Multi-Line Idempotency & Invalidation SSE](./0008-rest-api-contract-idempotency-and-sse.md)

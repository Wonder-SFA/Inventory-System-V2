# ADR-0007: Portable Containerized Cloud Hosting

**Status:** Accepted
**Date:** 2026-11-21

## Context

The business wants simple, low-maintenance, predictable cloud hosting for initial rollout (1–4 office computers in Phases 1–3, plus mobile devices in Phase 4), while preserving a planned future migration to **Google Cloud (Cloud Run + Cloud SQL)** if the system scales or expands into a multi-tenant SaaS offering.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Start directly on full Google Cloud infrastructure** | No later migration step | Higher upfront IAM, networking, and DevOps setup overhead before product-market fit |
| **Use platform-specific PaaS features (proprietary queues, auth, or DB extensions)** | Fast initial glue code | Creates painful vendor lock-in that requires rewrites when moving to Google Cloud |
| **Standard Docker container + Managed Cloud Platform + standard PostgreSQL** | Simple day-one operations with a zero-rewrite migration path to Cloud Run + Cloud SQL | Must avoid proprietary Managed-Cloud-only features |

## Decision & Rationale

We will deploy the application initially on a **Managed Cloud Platform** (such as Railway or Render) paired with **Managed PostgreSQL** for automatic HTTPS, automated daily backups, and minimal server maintenance, while enforcing strict **Google Cloud portability**:

- Package `apps/api` and `apps/web` as **standard Docker containers**.
- Keep API application servers **stateless** (sessions live in PostgreSQL via Better Auth; background consumers read from the PostgreSQL outbox).
- Rely strictly on **standard PostgreSQL** features and standard environment-variable configuration, with zero proprietary hosting lock-in.

## Consequences

- **Positive:** Fast, predictable initial deployment without dedicated DevOps staff.
- **Positive:** Migrating to Google Cloud (Cloud Run + Cloud SQL) later requires updating deployment/DNS config and restoring a PostgreSQL dump—zero application code rewrites.
- **Negative:** Forgoes platform-specific managed queues or proprietary add-ons in favor of PostgreSQL-backed patterns (outbox, sessions, SSE).
- **Risks & Mitigations:** Over time, SSE connections on stateless containers require care when scaling to multiple API instances; if horizontal scaling is needed on Cloud Run later, back SSE fan-out with PostgreSQL `LISTEN/NOTIFY` or a portable Pub/Sub adapter behind the `shared` broadcaster interface.

## Related Decisions

- [ADR-0001: Modular Monolith & Isolated PostgreSQL Schemas](./0001-modular-monolith-and-schema-isolation.md)
- [ADR-0003: TypeScript Monorepo & Core Stack](./0003-typescript-monorepo-and-core-stack.md)

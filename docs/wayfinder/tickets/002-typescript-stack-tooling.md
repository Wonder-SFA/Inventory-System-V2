# 002: TypeScript Monorepo & Backend Tooling

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** None

## Question

Within our chosen **TypeScript + PostgreSQL** stack, which specific tools should we lock in for:
1. Monorepo management (e.g., `pnpm` workspaces + Turborepo)
2. Backend framework & API style (e.g., Fastify, NestJS, Hono, or Next.js API/tRPC)
3. Database access & migrations (e.g., Drizzle ORM vs. Prisma)
4. Authentication for Phase 1 (and extensible for future Role-Based Permissions)

## Resolution

Locked in the TypeScript + PostgreSQL stack tooling:
1. **Monorepo:** `pnpm` workspaces + Turborepo (fast installs, strict dependency isolation, and cached builds for web, backend, and future mobile).
2. **Backend Framework:** **Fastify** (lightweight, fast standalone API server that cleanly serves both the Web App and a future Mobile App).
3. **Database Access & Migrations:** **Drizzle ORM** (lightweight, stays close to PostgreSQL for predictable queries on the append-only stock ledger).
4. **Authentication:** Built-in session auth (**Better Auth**) stored in PostgreSQL (free, secure, works for Web and Mobile, and easy to extend with Role-Based Permissions in Feature #7).

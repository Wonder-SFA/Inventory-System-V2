# API Design Gaps — Inventory System V2

> **Status:** Settled (All Items Q1–Q8 Resolved)  
> **Source:** Pre-implementation `/api-patterns` + `/grill-with-docs` review of [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md), [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md), and [ADR-0008](./adr/0008-rest-api-contract-idempotency-and-sse.md).  
> **Note:** All API contract decisions below are settled and reflected in [ADR-0008](./adr/0008-rest-api-contract-idempotency-and-sse.md), [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0003](./adr/0003-typescript-monorepo-and-core-stack.md), and [ADR-0007](./adr/0007-portable-containerized-cloud-hosting.md). [GLOSSARY.md](../GLOSSARY.md) remains intentionally free of implementation details.

---

## 1. High-Impact API Design Gaps (Resolved Before Phase 1 Coding)

### 1.1 API Style, Validation Source of Truth & URI Versioning — ✅ Settled (Q1)
- **Affects:** [ADR-0003: TypeScript Monorepo & Core Stack](./adr/0003-typescript-monorepo-and-core-stack.md), [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md)
- **Gap / Risk:** ADR-0003 locks in Fastify (`apps/api`) over Next.js API routes / tRPC-only, but leaves open REST vs. tRPC-on-Fastify, validation/OpenAPI tooling, URI versioning, and how order state transitions map to HTTP. Because Phase 4 mobile clients (`apps/mobile`) deploy independently via app stores, build-time TypeScript type sharing alone cannot protect older installed mobile builds at runtime.
- **Settled Decision:**
  - **Style & URI Versioning:** Standardize on **REST + JSON** under **`/api/v1/*`** on Fastify. Keep `/health` and `/ready` unversioned and Better Auth endpoints at `/api/auth/*`.
  - **Schema Validation & OpenAPI:** Define Zod schemas in `packages/shared-domain` (reused by web/mobile form validation) and wire them into Fastify via `fastify-type-provider-zod` + `@fastify/swagger` to auto-generate **OpenAPI 3.1**.
  - **Glossary-Aligned Naming & Explicit Command `POST` Endpoints:** Use plural kebab-case nouns aligned with [GLOSSARY.md](../GLOSSARY.md) (`products`, `skus`, `units-of-measure`, `locations`, `stock-balances`, `stock-movements`, `suppliers`, `customers`, `purchase-orders`, `sales-orders`, `transfer-orders` — avoiding terms such as `items`, `warehouses`, `vendors`, `po`, or `uom`). Model business state transitions as explicit command `POST` endpoints rather than overloading `PATCH /:id { status }`:
    - `POST /api/v1/purchase-orders/:id/confirm`, `/receipts`, `/cancel`
    - `POST /api/v1/sales-orders/:id/confirm`, `/shipments`, `/deliver`, `/returns`, `/cancel`
    - `POST /api/v1/transfer-orders/:id/confirm`, `/dispatch`, `/receipts`, `/close-discrepancy`, `/cancel`
    - `POST /api/v1/<resource>/:id/archive` and `/unarchive`
    - `GET /api/v1/skus/lookup?code=...` (ready for Phase 2 multi-barcode and QR aliases)

### 1.2 Multi-Line Order Idempotency — ✅ Settled (Q2)
- **Affects:** [ADR-0002: Append-Only Stock Ledger & Transactional Outbox](./adr/0002-append-only-stock-ledger-and-outbox.md), [ADR-0006: Offline Mobile Sync](./adr/0006-offline-mobile-physical-reality-wins.md), [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md)
- **Gap / Risk:** `inventory.stock_movements` enforces `UNIQUE (idempotency_key)` (`UUID`). A single-line adjustment or single Phase 4 mobile scan maps 1-to-1, **but a multi-line order action** (e.g., `POST /api/v1/purchase-orders/:id/receipts` receiving 5 lines) inserts 5 `stock_movements` rows inside one transaction. Reusing a single HTTP `Idempotency-Key` header verbatim across all 5 rows violates `UNIQUE (idempotency_key)`, whereas dropping idempotency exposes double-clicks/retries to duplicate stock postings.
- **Settled Decision:**
  - Require `Idempotency-Key: <uuid>` header on every stock-mutating and order-fulfilling `POST` endpoint.
  - Add `shared.idempotency_keys` (`key UUID PRIMARY KEY`, `actor_id`, `method`, `path`, `request_hash`, `status_code`, `response_body JSONB`, `created_at`) written inside the **same PostgreSQL transaction** as the domain mutation.
  - Derive deterministic per-line **UUIDv5** keys from `(requestKey, lineId)` for `inventory.stock_movements.idempotency_key` on multi-line order actions, while Phase 4 batch mobile sync supplies per-scan UUIDs directly.
  - **Replay Rules:** Same key + identical `request_hash` → replay the stored `200`/`201` response verbatim; same key + different `request_hash` → reject with **`409 IDEMPOTENCY_KEY_CONFLICT`**.

### 1.3 Response Envelope, Non-Blocking Warnings & Cost Field Redaction — ✅ Settled (Q3)
- **Affects:** [ADR-0004: Flexible Negative Stock Policy](./adr/0004-flexible-negative-stock-policy.md), [ADR-0005: Per-Location Weighted Average Cost](./adr/0005-per-location-weighted-average-cost.md), [ADR-0006](./adr/0006-offline-mobile-physical-reality-wins.md), [Ticket 006](./wayfinder/tickets/006-role-based-permissions.md)
- **Gap / Risk:** Successful (`2xx`) operations must surface structured non-blocking warnings (Zero/Negative Stock, PO over-receiving, Phase 4 offline `Manager Exception` clashes). Meanwhile, Phase 2's `View Costs & Prices` permission must redact financial fields server-side without substituting misleading `"0.0000"` values or breaking typed clients, and PO over-receiving needs an API-enforced confirmation guardrail.
- **Settled Decision:**
  - **Consistent Envelopes:**
    - `2xx` single/action responses: `{ "data": T, "warnings"?: ApiWarning[], "meta": { "requestId": "..." } }`
    - `2xx` list responses: `{ "data": T[], "page": { "limit": number, "nextCursor": string | null, "hasMore": boolean }, "meta": { "requestId": "..." } }`
    - `4xx`/`5xx` error responses (zero stack traces or raw SQL): `{ "error": { "code": string, "message": string, "details"?: [{ "field": string, "code": string, "message": string }], "requestId": string } }`
  - **Exact Decimal Serialization:** Serialize all `NUMERIC(18, 4)` quantities, unit costs, Weighted Average Costs, and monetary totals as **JSON strings** matching `/^-?\d+(\.\d{1,4})?$/` (never JavaScript `number`). Reject inputs exceeding 4 decimal places with **`422 DECIMAL_PRECISION_EXCEEDED`**.
  - **Cost Field Redaction Readiness:** Type `unitCost?`, `weightedAverageCost?`, and `totalValue?` as **optional** on shared DTOs from Phase 1. In Phase 2, omit those keys entirely from responses when `View Costs & Prices` is false (never substitute `"0.0000"`).
  - **PO Over-Receiving Guardrail:** Require explicit `allowOverReceive: true` in `POST /api/v1/purchase-orders/:id/receipts` whenever `fulfilledQty + receiveQty > orderedQty`; if omitted, reject with **`422 OVER_RECEIVE_CONFIRMATION_REQUIRED`** so the UI prompts confirmation and retries cleanly. Customer Sales Order shipments remain strictly capped at `orderedQty` (**`422 OVER_SHIP_NOT_ALLOWED`**).

### 1.4 Uniform Cursor / Keyset Pagination — ✅ Settled (Q4)
- **Affects:** [ADR-0002](./adr/0002-append-only-stock-ledger-and-outbox.md), [DATABASE_DESIGN_GAPS.md §2.1](./DATABASE_DESIGN_GAPS.md#2-medium-impact-database-considerations)
- **Gap / Risk:** Offset pagination (`?page=2`) produces duplicate or skipped rows when concurrent `StockMovement` or order rows insert at the top during paging, and degrades on deep append-only tables.
- **Settled Decision:**
  - Standardize on **cursor / keyset pagination** over `(created_at DESC, id DESC)` (using `UUIDv7` `id` as the deterministic tie-breaker for equal timestamps) across **all** list endpoints, encoded as an opaque base64url `cursor` query parameter.
  - Bounded `limit`: default `50`, maximum `100` (`> 100` → `422`). Invalid cursor → **`400 INVALID_CURSOR`**.
  - **Snapshot Semantics:** Under descending keyset order, newly inserted rows at the top never cause duplicate IDs on subsequent pages (they appear on refresh / page 1); archived or deleted rows are cleanly skipped.

### 1.5 Web ↔ API Origin, Auth Transport & "Tap on the Shoulder" SSE — ✅ Settled (Q5)
- **Affects:** [ADR-0003](./adr/0003-typescript-monorepo-and-core-stack.md), [ADR-0007: Portable Containerized Cloud Hosting](./adr/0007-portable-containerized-cloud-hosting.md)
- **Gap / Risk:** Browser `EventSource` cannot send custom `Authorization` headers, cross-origin ports/domains complicate `SameSite` session cookies in Docker and Cloud Run, `?token=` query strings leak credentials into proxy logs, and pushing domain payloads over SSE could leak Phase 2 cost or Location-restricted fields.
- **Settled Decision:**
  - **Web Origin & Auth:** Proxy `/api/*` **same-origin through Next.js (`apps/web`)** to Fastify (`apps/api`) so Better Auth `HttpOnly`, `SameSite=Lax` (`Secure` over HTTPS) cookies and browser `EventSource` work seamlessly in local Docker and Cloud Run with zero cross-origin cookie friction.
  - **Mobile Auth (Phase 4):** Enable Better Auth Bearer tokens (`Authorization: Bearer <token>`) on REST and `fetch`-based SSE clients — **never** `?token=` in URLs.
  - **Minimal Invalidation-Only SSE Contract:** `GET /api/v1/events/stream` (`Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`) emits lightweight `invalidate` events containing only `{ seqId, topics, locationIds, skuIds }` (**zero quantities, zero costs, zero PII**). Send `: keepalive\n\n` every `25s`, cap concurrent SSE streams at **`5` per user**, trigger **one quiet client refetch on reconnect**, and filter by `actor.allowedLocationIds` when Phase 2 Location scoping activates.
  - **`iam` Access Switch Enforcement:** Enforce the Access Switch in a Fastify `preHandler`:
    - `Active`: normal operation.
    - `Read-Only`: `GET`/`HEAD` + sign-out allowed; all mutations return **`403 ACCESS_READ_ONLY`**.
    - `Suspended`: all `/api/v1/*` routes (except `/health`, `/api/v1/session`, and sign-out) return **`403 ACCESS_SUSPENDED`**.

### 1.6 Concurrent Draft Order Edits — Optimistic Locking — ✅ Settled (Q6)
- **Affects:** [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md), [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md)
- **Gap / Risk:** `SELECT ... FOR UPDATE` protects `inventory.stock_balances` during order confirmation and fulfillment, but if two office PCs open and edit the same `Draft` order concurrently, last-write-wins silently overwrites the first clerk's line changes.
- **Settled Decision:**
  - Add an integer `version` column on orders (`purchase_orders`, `sales_orders`, `transfer_orders`) incremented on update.
  - Require `expectedVersion` on `PATCH /api/v1/*-orders/:id` edits and reject mismatches with **`409 STALE_VERSION`** so the UI prompts a reload before saving.

---

## 2. Medium-Impact Operational & Contract Controls

| # | Status | Area | Affects | Risk / Tension | Settled Decision |
|---|--------|------|---------|----------------|------------------|
| **2.1** | ✅ Settled | **OpenAPI Docs Exposure & CI Contract Diff** *(Q7)* | [ADR-0003](./adr/0003-typescript-monorepo-and-core-stack.md), OWASP API8/API9 | Leaving `/docs` exposed in production expands attack surface; unguarded contract edits break independently deployed Phase 4 mobile builds. | **Settled:** Mount `/docs` UI **only when `NODE_ENV !== 'production'`**. Generate `openapi.json` in CI and enable breaking-change diff checks once Phase 4 mobile ships. |
| **2.2** | ✅ Settled | **Rate Limiting, `trustProxy`, Payload Bounds & Probes** *(Q8)* | [ADR-0007](./adr/0007-portable-containerized-cloud-hosting.md), OWASP API4 | Without `trustProxy`, Next.js / Cloud Run proxy hops collapse all users onto one proxy IP so one login typo rate-limits the whole office; unbounded payloads risk exhausting Phase 1 local PC memory. | **Settled:** Enable Fastify `trustProxy` (restricted to known proxy hops); `@fastify/rate-limit` with `X-RateLimit-*` + `Retry-After` on `429` (auth `10/min` per real IP, mutations `120/min` per user, reads `300/min` per user; in-memory store for Phase 1 single-container Docker, swappable to PG/Redis if horizontally scaling later). Enforce payload caps (`1 MB` JSON body, `500` order lines/request, `200` Phase 4 mobile sync scans/batch) and expose unversioned `GET /health` (`200`) and `GET /ready` (`SELECT 1` → `200`/`503`). |

---

## 3. Concrete Reference Operation (`POST /api/v1/purchase-orders/:id/receipts`)

### Request
```http
POST /api/v1/purchase-orders/0195a1b2-0000-7000-8000-000000000010/receipts
Content-Type: application/json
Idempotency-Key: 6f8c2a10-4b9a-4e21-9a11-8c3e1f2d9b04
Cookie: better-auth.session_token=...
```
```json
{
  "allowOverReceive": true,
  "note": "Pallet 2 arrived with 2 bonus units",
  "lines": [
    {
      "orderLineId": "0195a1b2-0000-7000-8000-000000000011",
      "quantity": "12.0000",
      "unitCost": "4.2500",
      "currency": "USD"
    }
  ]
}
```

### Success (`201 Created`)
```json
{
  "data": {
    "purchaseOrderId": "0195a1b2-0000-7000-8000-000000000010",
    "status": "RECEIVED",
    "movements": [
      {
        "id": "0195a1b4-1234-7000-8000-000000000099",
        "type": "RECEIPT",
        "skuId": "0195a100-0000-7000-8000-000000000001",
        "locationId": "0195a000-0000-7000-8000-000000000001",
        "quantityDelta": "12.0000",
        "unitCost": "4.2500",
        "currency": "USD",
        "createdAt": "2026-11-21T09:47:00.000Z"
      }
    ]
  },
  "warnings": [
    {
      "code": "PURCHASE_ORDER_OVER_RECEIVED",
      "message": "Received 12.0000 vs ordered 10.0000 on line 0195a1b2-0000-7000-8000-000000000011.",
      "orderLineId": "0195a1b2-0000-7000-8000-000000000011"
    }
  ],
  "meta": {
    "requestId": "req_0195a1b41234"
  }
}
```

### Rejection Cases

| HTTP Status | `error.code` | Trigger |
|---|---|---|
| `400` | `MISSING_IDEMPOTENCY_KEY` | Missing or non-UUID `Idempotency-Key` header |
| `401` | `UNAUTHENTICATED` | Missing or expired Better Auth session / Bearer token |
| `403` | `ACCESS_READ_ONLY` / `ACCESS_SUSPENDED` / `FORBIDDEN` | `iam` Access Switch restriction, or Phase 2 RBAC / Location denial |
| `404` | `PURCHASE_ORDER_NOT_FOUND` | Unknown Purchase Order ID (or hidden outside Phase 2 Location scope) |
| `409` | `INVALID_ORDER_STATE` | Attempting to receive a `DRAFT` or `CANCELLED` Purchase Order |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | Same `Idempotency-Key` reused with a different request payload |
| `422` | `DECIMAL_PRECISION_EXCEEDED` | `quantity` or `unitCost` has `> 4` decimal places (e.g., `"4.12345"`) |
| `422` | `OVER_RECEIVE_CONFIRMATION_REQUIRED` | Receipt exceeds `orderedQty` without `allowOverReceive: true` *(Sales Order shipments always fail with `422 OVER_SHIP_NOT_ALLOWED`)* |
| `429` | `RATE_LIMITED` | Exceeded rate limit (`Retry-After` and `X-RateLimit-*` headers included) |

---

## 4. Next Steps

1. **All architecture, database, and API design gaps are settled** across [ARCHITECTURE_REVIEW_GAPS.md](./ARCHITECTURE_REVIEW_GAPS.md), [DATABASE_DESIGN_GAPS.md](./DATABASE_DESIGN_GAPS.md), and this document, and reflected in `docs/adr/` ([README](./adr/README.md)) and [ARCHITECTURE_BLUEPRINT.md](./ARCHITECTURE_BLUEPRINT.md).
2. Proceed to **`/to-spec`** → **`/to-tickets`** to produce the buildable Phase 1 specification and implementation issues.

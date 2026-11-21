# 003: Modular Architecture & Feature Box Boundaries

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [001: Domain Glossary and Core Entities](./001-domain-glossary-and-core-entities.md), [002: TypeScript Monorepo & Backend Tooling](./002-typescript-stack-tooling.md)

## Question

How should we structure the codebase and database so that each feature lives in an isolated "box" (module) and new features (like Barcodes, Reporting, POS/Accounting, Mobile, and RBAC) can be plugged in later without rewriting existing modules? Specifically:
- What are the exact module boundaries (`catalog`, `inventory`, `orders`, `iam`, etc.)?
- How do modules communicate (public TypeScript interfaces + internal domain events)?
- How is database ownership enforced so modules don't reach into each other's tables?

## Resolution

Locked in the modular monolith boundaries:
1. **4 Core Feature Boxes:** `catalog` (Products, SKUs, Units), `inventory` (Locations, append-only Stock Ledger, balances), `orders` (Suppliers, Customers, Purchase/Sales/Transfer Orders), and `iam` (Users, Sessions, future RBAC).
2. **Communication:** Modules use **public TypeScript interfaces** for direct queries and **internal domain events** for reactions, so future modules (Reporting, Accounting/POS, live UI updates) can subscribe without modifying existing boxes.
3. **Database Ownership:** **Separate PostgreSQL schemas per box** (`catalog.*`, `inventory.*`, `orders.*`, `iam.*`) with private Drizzle tables per module, ensuring only `inventory` ever writes to the stock ledger and concurrency locks stay in one place.

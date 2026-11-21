# 001: Domain Glossary and Core Entities

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** None

## Question

What are the exact domain terms, definitions, and boundaries for our core concepts—such as Product vs. Item vs. SKU vs. Variant, Unit of Measure, Location/Bin, Stock Movement, and Purchase Order vs. Sales Order—and how do they relate to each other in `GLOSSARY.md`?

## Resolution

Captured in [GLOSSARY.md](../../../GLOSSARY.md):
- **Catalog:** **Product** (general item that can be added/edited/removed) → **SKU** (each specific, countable version on the shelf).
- **Units:** Each SKU has one base **Unit of Measure** (pieces, kg, liters, etc.); bulk packs are separate SKUs or converted on receipt.
- **Locations:** **Location** represents a physical building/site (e.g., Main Warehouse, Downtown Store) in Phase 1, designed so sub-locations (bins/shelves) can be added underneath later without rewriting the ledger.
- **Stock:** Append-only **Stock Movements** produce **On-Hand Stock**; **Reserved Stock** tracks open Sales Orders; **Available Stock** = On-Hand minus Reserved.
- **Orders & Counterparties:** **Purchase Orders** (from **Suppliers**), **Sales Orders** (to **Customers**), and formal **Transfer Orders** (with an **In-Transit** state between Locations) are all part of Phase 1.

# 004: Phase 1 (MVP) Workflows & Data Model

**Label:** `wayfinder:grilling`
**Status:** Closed
**Blocked by:** [001: Domain Glossary and Core Entities](./001-domain-glossary-and-core-entities.md), [003: Modular Architecture & Feature Box Boundaries](./003-modular-architecture-and-boundaries.md)

## Question

What are the exact user workflows, edge cases, and data structures for Phase 1 (MVP):
- Creating and managing Products/SKUs and Locations
- Recording Stock Movements (Receipts, Issues, Adjustments, Transfers) and computing real-time stock counts (On-Hand, Reserved, Available)
- Basic Purchase Orders (receiving stock from suppliers), Sales Orders (reserving/fulfilling stock to customers), and Transfer Orders (with an In-Transit state between locations)
- Handling edge cases like negative stock prevention, partial order fulfillment, and order cancellations

## Resolution

Locked the Phase 1 (MVP) workflows, edge cases, and data model across all four feature boxes:

1. **Products, SKUs & Locations (`catalog` & `inventory`):**
   - **Lifecycle:** Products, SKUs, and Locations use `Active` / `Archived` status. Any entity with existing stock movements or orders cannot be hard-deleted—it is archived/deactivated to preserve ledger history. Unused entities (zero movements/orders) may be deleted cleanly.
   - **Single Base Unit:** Each SKU has one base `Unit of Measure` (e.g., `pcs`, `kg`, `L`).

2. **Stock Ledger, Real-Time Counts & Negative Stock (`inventory`):**
   - **Append-Only Movements:** Every stock change creates an immutable `StockMovement` record (`RECEIPT`, `ISSUE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN`) with `skuId`, `locationId`, `quantityDelta`, `reasonCategory`, `referenceType`/`referenceId`, `actorId`, and `createdAt`.
   - **Projected Stock Balances:** A `StockBalance` projection per `(skuId, locationId)` tracks `onHand`, `reserved`, `available` (`onHand - reserved`), and `inTransit` for fast table reads and concurrent updates.
   - **Flexible Negative Stock:** Both `Available` and `On-Hand` are allowed to drop below zero so users are never blocked during urgent operations. Whenever `onHand <= 0` or `available <= 0`, the system issues a warning to the user and flags the `(skuId, locationId)` record with a visible **Zero / Negative Stock** marker for follow-up reconciliation.
   - **Manual Adjustments:** Every manual `ADJUSTMENT` requires a `reasonCategory` (`STOCK_COUNT`, `DAMAGED`, `EXPIRED`, `LOST`, `OTHER`) and supports an optional free-text note.

3. **Order Workflows & Edge Cases (`orders` -> `inventory`):**
   - **Partial Fulfillment:** Purchase Orders, Sales Orders, and Transfer Orders track `orderedQty` vs. `fulfilledQty` (`receivedQty` / `shippedQty`) per line item, supporting partial receiving and partial shipping.
   - **Purchase Orders (Supplier -> Location):** `Draft` → `Confirmed` → `Partially Received` → `Received` (or `Cancelled`). Receiving items records a `RECEIPT` movement into the destination Location's `On-Hand`.
   - **Sales Orders (Location -> Customer):** `Draft` → `Confirmed` (reserves stock in `Reserved`) → `Partially Shipped` / `Shipped` (releases reservation and records an `ISSUE` movement deducting `On-Hand`) → `Delivered` (delivery status tracking). Customer returns or rejected deliveries are recorded as a `RECEIPT` movement (`reason: CUSTOMER_RETURN`) when the item physically returns to the Location.
   - **Transfer Orders (Location A -> Location B):** `Draft` → `Confirmed` → `In-Transit` (Location A ships: `TRANSFER_OUT` deducts A's `On-Hand` and adds to `In-Transit`) → `Partially Received` / `Received` (Location B receives: `TRANSFER_IN` deducts `In-Transit` and adds to B's `On-Hand`). Any missing or damaged remainder can be closed out with a discrepancy reason so items do not remain stuck `In-Transit`.
   - **Order Cancellations / Early Close:** Cancelling or closing a partially fulfilled order preserves all already-recorded stock movements, releases any remaining `Reserved` stock back to `Available`, and marks the unfulfilled remainder `Cancelled` / `Closed`.

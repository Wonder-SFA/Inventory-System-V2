# Inventory System V2

Shared domain vocabulary for tracking products, stock levels, locations, and orders across the business.

## Language

### Catalog

**Product**:
A general item in the catalog that groups one or more sellable or trackable versions (for example, "Cotton T-Shirt").
_Avoid_: Item, Goods, Merchandise

**SKU**:
A specific, uniquely coded version of a Product that is actually counted on the shelf and bought or sold (for example, "Cotton T-Shirt — Red, Medium"). Every Product has at least one SKU.
_Avoid_: Variant, Product Option, Item

**Unit of Measure**:
The single base unit in which a SKU's quantity is always counted and stored (for example, pieces, kilograms, or liters).
_Avoid_: UoM, Pack Size, Selling Unit

### Locations & Stock

**Stock Lot**:
A distinct batch or production run of a lot-tracked SKU identified by a code and optional manufacturing and expiry dates.
_Avoid_: Batch Layer, Expiry Group, Serial Pool

**Lot Balance**:
The on-hand, reserved, and available quantity of a specific Stock Lot at a specific Location.
_Avoid_: Sub-stock, Batch Count

**FEFO Allocation**:
First-Expired, First-Out rule where the system automatically allocates stock from the earliest-expiring available Stock Lot at a Location.
_Avoid_: Expiry Sweep, Auto-Batching

**Location**:
A physical site where stock is stored or sold (for example, "Main Warehouse" or "Downtown Store").
_Avoid_: Warehouse, Branch, Site, Bin

**Stock Movement**:
An immutable, append-only record of a change in stock quantity for a specific SKU at a Location (Receipt, Issue, Adjustment, or Transfer).
_Avoid_: Stock Transaction, Inventory Log, Stock Edit

**On-Hand Stock**:
The physical quantity of a SKU currently sitting at a Location, calculated by summing its Stock Movements.
_Avoid_: Physical Stock, Current Count, Total Stock

**Reserved Stock**:
The quantity of a SKU at a Location that is set aside for open, unfulfilled Sales Orders and cannot be promised to another customer.
_Avoid_: Committed Stock, Allocated Stock, Held Stock

**Available Stock**:
The quantity of a SKU at a Location that can be sold or allocated right now (`On-Hand Stock` minus `Reserved Stock`).
_Avoid_: Free Stock, Sellable Stock

**In-Transit Stock**:
The quantity of a SKU currently between Locations on an open Transfer Order after dispatch and before receipt.
_Avoid_: Moving Stock, Pending Transfer

### Orders & Counterparties

**Supplier**:
An external vendor from whom the business buys stock.
_Avoid_: Vendor, Provider

**Customer**:
An external person or organization that buys stock from the business.
_Avoid_: Client, Buyer, Account

**Purchase Order**:
An order placed with a Supplier to buy specific SKUs to be received into a Location.
_Avoid_: PO, Restock Order, Inbound Order

**Sales Order**:
An order placed by a Customer to buy specific SKUs to be reserved and fulfilled from a Location.
_Avoid_: SO, Customer Order, Outbound Order

**Transfer Order**:
An internal order to move specific SKUs from one Location to another, tracking stock through an In-Transit state between dispatch and receipt.
_Avoid_: Stock Move Request, Internal Order

**Quick Counter Sale**:
A single-step walk-in sale recorded over the counter that immediately deducts On-Hand Stock at a Location and records cash payment, skipping Draft, Reservation, and Shipping steps.
_Avoid_: POS Sale, Register Ring, Walk-in Order

### Finance & Valuation

*(All quantities and monetary values use exact 4-decimal fixed precision (`NUMERIC(18, 4)`), rejecting user inputs with more than 4 decimal places.)*

**Weighted Average Cost**:
The per-unit value of a SKU's On-Hand Stock at a Location, recalculated as the total value of stock on hand plus newly received stock divided by the new total quantity. When stock recovers from zero or negative (`<= 0`) back into positive territory, cost resets to the incoming unit cost; while `On-Hand Stock` remains `<= 0`, the last known cost is preserved and flagged as `"Estimated — Negative Stock"` on Valuation Reports until reconciled.
_Avoid_: Unit Price, Standard Cost

**FIFO Cost**:
The cost of goods sold and valuation derived from the specific unit cost of the individual Stock Lots or receipt layers allocated under First-In, First-Out or First-Expired, First-Out order.
_Avoid_: Layer Price, Historic Cost

**Cash Balance**:
The business's real cash on hand, updated when Purchase Orders, Sales Orders, Quick Counter Sales, or manual income and expense entries are marked paid.
_Avoid_: Revenue, Profit, Bank Feed

### Operations & Governance

**Manager Exception**:
A flagged discrepancy created when a physical warehouse action recorded offline clashes with server state upon reconnect (such as an order cancelled at the office or stock dipping negative), requiring manager follow-up without rejecting the physical movement.
_Avoid_: Sync Error, Conflict Failure, Rejected Scan

**IAM Audit Log**:
An immutable historical record of every role creation, permission edit, approval limit change, and user-to-Location assignment change.
_Avoid_: Activity Feed, System Log, Access History

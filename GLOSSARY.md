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

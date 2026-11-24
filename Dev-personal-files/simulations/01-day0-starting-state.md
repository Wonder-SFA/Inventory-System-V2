# Day 0 Starting State — Samar Island Agri-Feeds Trading

**Snapshot Date:** Monday night, November 23, 2026 (close of business before Day 1)  
**Tax Status:** VAT-Registered Business (12% VAT on VATable veterinary products; VAT-Exempt on agricultural feeds)  
**Currency:** Philippine Peso (`₱`)

---

## 1. Business Profile & Roles

**Samar Island Agri-Feeds Trading** is a wholesale and retail animal feed distributor operating on Samar Island.

- **Owner:** Handles all business approvals, pricing, supplier payments, and end-of-day reconciliation (sole operator of the accounting/inventory records).
- **Field Staff (physical operations only):**
  - *Kuya Jun* — Route Driver (`Elf Truck #1`)
  - *Dodoy* — Pahinante / Truck Helper
  - *Rico* — Catbalogan Main Bodega Helper
  - *Ate Marites* — Catarman Satellite Depot Caretaker (reports counter sales and confirms incoming transfers by phone)

---

## 2. Locations & Fleet

| Code | Name | Address / Role | Overnight Status (Day 0) |
| :--- | :--- | :--- | :--- |
| `LOC-CATB` | **Catbalogan Main Bodega** | Brgy. Mercedes, Catbalogan City, Samar — Main warehouse + walk-in front counter | Stocked (₱172,080.00) |
| `LOC-CTMN` | **Catarman Satellite Depot** | Brgy. Dalakit, Catarman, Northern Samar — Satellite counter | Stocked (₱42,200.00) |
| `TRK-ELF1` | **Elf Truck #1** (`Plate HAA-4821`) | 6-wheeler Isuzu Elf (~4,500 kg capacity) — Northbound Route vehicle | Empty (0 sacks / ₱0.00) |

---

## 3. Product Catalog (7 SKUs)

| SKU | Product Name | Pack / Unit | Tax Class | Base Unit Cost (ex-VAT) | Dealer Price | Farm Price | Walk-In Retail Price |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | Hog Starter Pellets | 50 kg Sealed Sack | VAT-Exempt | ₱1,720 (`HS-2610A`) / ₱1,750 (`HS-2611A`/`B`) | ₱1,860.00 | ₱1,900.00 | ₱1,950.00 |
| `FEED-HG50` | Hog Grower Pellets | 50 kg Sealed Sack | VAT-Exempt | ₱1,640.00 | ₱1,750.00 *(₱1,730.00 for 20+ sacks)* | ₱1,790.00 | ₱1,840.00 |
| `FEED-BF50` | Broiler Finisher Crumble | 50 kg Sealed Sack *(breakable to 50 kg loose @ ₱36.00/kg cost)* | VAT-Exempt | ₱1,800.00 / sack | ₱1,920.00 | ₱1,960.00 | ₱2,000.00 *(Loose: ₱44.00/kg)* |
| `FEED-LM25` | Layer Mash | 25 kg Sealed Sack | VAT-Exempt | ₱860.00 | ₱930.00 | ₱950.00 | ₱980.00 |
| `FEED-TF25` | Tilapia Floating Feeds | 25 kg Sealed Sack | VAT-Exempt | ₱920.00 | ₱1,000.00 | ₱1,030.00 | ₱1,060.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | 50 kg Sealed Sack | VAT-Exempt | ₱620.00 | ₱690.00 | ₱720.00 | ₱750.00 |
| `VET-MV01` | Multivitamin + Electrolyte Powder | 1 kg Pack | 12% VATable | ₱200.00 net *(₱224.00 VAT-inc)* | ₱280.00 VAT-inc *(₱250 net + ₱30 VAT)* | ₱308.00 VAT-inc *(₱275 net + ₱33 VAT)* | ₱336.00 VAT-inc *(₱300 net + ₱36 VAT)* |

---

## 4. Suppliers (2)

| Code | Supplier Name | Origin & Terms | Opening AP Balance | Open Purchase Orders / Unpaid Invoices |
| :--- | :--- | :--- | :--- | :--- |
| `SUP-001` | **Visayas Feed Mills Corp.** | Cebu / Tacloban via San Juanico Bridge · 15-day credit | **₱85,000.00** | • **Unpaid Invoice:** `SI-VFM-8841` dated Nov 9, 2026, due Nov 24, 2026 (**₱85,000.00**)<br>• **Open PO:** `PO-2026-041` placed Nov 21, 2026 for 30 `FEED-HS50` @ ₱1,750, 25 `FEED-HG50` @ ₱1,640, 20 `FEED-BF50` @ ₱1,800 (**₱129,500.00** expected) |
| `SUP-002` | **Samar Agri-Vet & Rice Mill Trading** | Local Samar supplier · COD / Bank Transfer | **₱0.00** | None |

---

## 5. Customers (5)

| Code | Customer Name | Price Tier | Payment Terms | Credit Limit | Opening AR Balance | Open Invoices |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CUST-WALKIN` | **Walk-In Cash Customer** | Walk-In Retail | Cash / GCash | ₱0.00 | **₱0.00** | None |
| `CUST-001` | **San Jorge Piggery Farm** | Farm | 15-day credit | ₱80,000.00 | **₱32,000.00** | `CI-2026-1102` dated Nov 12, 2026, due Nov 27, 2026 (**Current**) |
| `CUST-002` | **Calbayog Agrivet Supply** | Dealer | 30-day credit | ₱150,000.00 | **₱48,500.00** | `CI-2026-1045` dated Oct 20, 2026, due Nov 19, 2026 (**5 days overdue**) |
| `CUST-003` | **Gandara Poultry & Feeds** | Dealer | COD | ₱0.00 | **₱0.00** | None |
| `CUST-004` | **Catarman Backyard Raisers Coop** | Farm | COD / GCash | ₱0.00 | **₱0.00** | None |

---

## 6. Opening Inventory by Location & Expiry Lot (ex-VAT)

### Catbalogan Main Bodega (`LOC-CATB`)

| SKU | Product | Expiry Lot | Mfg Date | Exp Date | Qty On Hand | Unit Cost (ex-VAT) | Total Value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | Hog Starter Pellets | `HS-2610A` | 2026-10-10 | 2027-01-08 | 12 sacks | ₱1,720.00 | ₱20,640.00 |
| `FEED-HS50` | Hog Starter Pellets | `HS-2611A` | 2026-11-05 | 2027-02-03 | 20 sacks | ₱1,750.00 | ₱35,000.00 |
| `FEED-HG50` | Hog Grower Pellets | `HG-2611A` | 2026-11-05 | 2027-02-03 | 25 sacks | ₱1,640.00 | ₱41,000.00 |
| `FEED-BF50` | Broiler Finisher Crumble | `BF-2611A` | 2026-11-08 | 2027-02-06 | 18 sacks *(0 kg loose)* | ₱1,800.00 | ₱32,400.00 |
| `FEED-LM25` | Layer Mash | `LM-2611A` | 2026-11-08 | 2027-02-06 | 24 sacks | ₱860.00 | ₱20,640.00 |
| `FEED-TF25` | Tilapia Floating Feeds | `TF-2611A` | 2026-11-10 | 2027-03-10 | 15 sacks | ₱920.00 | ₱13,800.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | `DRK-2611A` | 2026-11-15 | 2027-01-14 | 10 sacks | ₱620.00 | ₱6,200.00 |
| `VET-MV01` | Multivitamin + Electrolyte | `MV-2610` | 2026-10-01 | 2027-10-01 | 12 packs | ₱200.00 | ₱2,400.00 |
| **Subtotal** | | | | | | | **₱172,080.00** |

### Catarman Satellite Depot (`LOC-CTMN`)

| SKU | Product | Expiry Lot | Mfg Date | Exp Date | Qty On Hand | Unit Cost (ex-VAT) | Total Value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | Hog Starter Pellets | `HS-2611A` | 2026-11-05 | 2027-02-03 | 6 sacks | ₱1,750.00 | ₱10,500.00 |
| `FEED-HG50` | Hog Grower Pellets | `HG-2611A` | 2026-11-05 | 2027-02-03 | 5 sacks | ₱1,640.00 | ₱8,200.00 |
| `FEED-BF50` | Broiler Finisher Crumble | `BF-2611A` | 2026-11-08 | 2027-02-06 | 4 sacks | ₱1,800.00 | ₱7,200.00 |
| `FEED-LM25` | Layer Mash | `LM-2611A` | 2026-11-08 | 2027-02-06 | 8 sacks | ₱860.00 | ₱6,880.00 |
| `FEED-TF25` | Tilapia Floating Feeds | `TF-2611A` | 2026-11-10 | 2027-03-10 | 6 sacks | ₱920.00 | ₱5,520.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | `DRK-2611A` | 2026-11-15 | 2027-01-14 | 5 sacks | ₱620.00 | ₱3,100.00 |
| `VET-MV01` | Multivitamin + Electrolyte | `MV-2610` | 2026-10-01 | 2027-10-01 | 4 packs | ₱200.00 | ₱800.00 |
| **Subtotal** | | | | | | | **₱42,200.00** |

### Elf Truck #1 (`TRK-ELF1`)
- **0 sacks / ₱0.00**

**Total Opening Inventory (All Locations):** **₱214,280.00**

---

## 7. Opening Cash, Bank, Receivables & Equity Summary

| Account / Category | Opening Balance |
| :--- | :--- |
| Catbalogan Counter Cash Drawer | ₱25,000.00 |
| Catarman Depot Cash Drawer | ₱10,000.00 |
| GCash Business Wallet | ₱18,500.00 |
| BDO Business Checking Account | ₱210,000.00 |
| **Total Liquid Funds** | **₱263,500.00** |
| Undeposited PDCs on Hand | ₱0.00 |
| Accounts Receivable (`CUST-001` ₱32,000 + `CUST-002` ₱48,500) | ₱80,500.00 |
| Inventory on Hand (ex-VAT) | ₱214,280.00 |
| **Total Opening Assets** | **₱558,280.00** |
| Less: Accounts Payable (`SUP-001` `SI-VFM-8841`) | (₱85,000.00) |
| **Opening Net Equity** | **₱473,280.00** |

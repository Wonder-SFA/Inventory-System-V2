# End-of-Day Reconciliation Sheet — Tuesday, November 24, 2026 (06:00 PM)

Use this answer key to verify every stock count, money balance, receivable, payable, VAT figure, and gross margin after running [02-day1-simulation-script.md](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/Dev-personal-files/simulations/02-day1-simulation-script.md).

---

## 1. Closing Inventory by Location & Expiry Lot (ex-VAT)

### Catbalogan Main Bodega (`LOC-CATB`)

| SKU | Product | Expiry Lot | Opening | + In / Return | − Out / Sale | Closing Qty | Unit Cost | Closing Value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | Hog Starter Pellets | `HS-2610A` | 12 sacks | 0 | −12 *(San Jorge)* | **0 sacks** | ₱1,720.00 | ₱0.00 |
| `FEED-HS50` | Hog Starter Pellets | `HS-2611A` | 20 sacks | 0 | −13 *(3 SJ + 10 CTMN)* | **7 sacks** | ₱1,750.00 | ₱12,250.00 |
| `FEED-HS50` | Hog Starter Pellets | `HS-2611B` | 0 sacks | +25 *(VFM)* | 0 | **25 sacks** | ₱1,750.00 | ₱43,750.00 |
| `FEED-HG50` | Hog Grower Pellets | `HG-2611A` | 25 sacks | 0 | −25 *(8 SJ + 17 Calb)* | **0 sacks** | ₱1,640.00 | ₱0.00 |
| `FEED-HG50` | Hog Grower Pellets | `HG-2611B` | 0 sacks | +25 *(VFM)* | −3 *(Calbayog)* | **22 sacks** | ₱1,640.00 | ₱36,080.00 |
| `FEED-BF50` | Broiler Finisher (Sealed) | `BF-2611A` | 18 sacks | +4 *(Unsold)* | −18 *(8 CTMN + 10 Roll)* | **4 sacks** | ₱1,800.00 | ₱7,200.00 |
| `FEED-BF50` | Broiler Finisher (Sealed) | `BF-2611B` | 0 sacks | +20 *(VFM)* | −1 *(Broken to bin)* | **19 sacks** | ₱1,800.00 | ₱34,200.00 |
| `FEED-BF50` | Broiler Finisher (Loose Bin) | `BF-2611B` | 0 kg | +50 kg *(Broken)* | −25 kg *(10 + 15)* | **25.0 kg** | ₱36.00/kg | ₱900.00 |
| `FEED-LM25` | Layer Mash | `LM-2611A` | 24 sacks | +2 *(Unsold)* | −18 *(10 Calb + 6 Roll + 2 SI-504)* | **8 sacks** | ₱860.00 | ₱6,880.00 |
| `FEED-TF25` | Tilapia Floating Feeds | `TF-2611A` | 15 sacks | 0 | −5 *(Catarman)* | **10 sacks** | ₱920.00 | ₱9,200.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | `DRK-2611A` | 10 sacks | 0 | −1 *(SI-501)* | **9 sacks** | ₱620.00 | ₱5,580.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | `DRK-2611B` | 0 sacks | +20 *(SAV)* | 0 | **20 sacks** | ₱620.00 | ₱12,400.00 |
| `VET-MV01` | Multivitamin + Electrolyte | `MV-2610` | 12 packs | 0 | −6 *(4 SJ + 2 SI-501)* | **6 packs** | ₱200.00 | ₱1,200.00 |
| `VET-MV01` | Multivitamin + Electrolyte | `MV-2611` | 0 packs | +10 *(SAV)* | 0 | **10 packs** | ₱200.00 | ₱2,000.00 |
| **Subtotal (`LOC-CATB`)** | | | | | | | | **₱171,640.00** |

### Catarman Satellite Depot (`LOC-CTMN`)

| SKU | Product | Expiry Lot | Opening | + Transfer In | − Sold | Closing Qty | Unit Cost | Closing Value |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | Hog Starter Pellets | `HS-2611A` | 6 sacks | +10 | −8 | **8 sacks** | ₱1,750.00 | ₱14,000.00 |
| `FEED-HG50` | Hog Grower Pellets | `HG-2611A` | 5 sacks | 0 | 0 | **5 sacks** | ₱1,640.00 | ₱8,200.00 |
| `FEED-BF50` | Broiler Finisher Crumble | `BF-2611A` | 4 sacks | +8 | 0 | **12 sacks** | ₱1,800.00 | ₱21,600.00 |
| `FEED-LM25` | Layer Mash | `LM-2611A` | 8 sacks | 0 | 0 | **8 sacks** | ₱860.00 | ₱6,880.00 |
| `FEED-TF25` | Tilapia Floating Feeds | `TF-2611A` | 6 sacks | +5 | −6 | **5 sacks** | ₱920.00 | ₱4,600.00 |
| `RAW-DRK50` | Rice Bran (Darak D1) | `DRK-2611A` | 5 sacks | 0 | −3 | **2 sacks** | ₱620.00 | ₱1,240.00 |
| `VET-MV01` | Multivitamin + Electrolyte | `MV-2610` | 4 packs | 0 | 0 | **4 packs** | ₱200.00 | ₱800.00 |
| **Subtotal (`LOC-CTMN`)** | | | | | | | | **₱57,320.00** |

### Elf Truck #1 (`TRK-ELF1`)
- **0 units / ₱0.00** (all pre-orders delivered, `STF-2026-019` dropped, 10 rolling sacks sold, 6 unsold rolling sacks returned).

### Total Inventory Roll-Forward

| Metric | Amount |
| :--- | :--- |
| Opening Inventory (Day 0) | ₱214,280.00 |
| + Day 1 Purchases (ex-VAT: `VFM-9012` ₱120,750 + `SAV-1104` ₱14,400) | ₱135,150.00 |
| − Day 1 FIFO Cost of Goods Sold (COGS) | (₱120,470.00) |
| **Total Closing Inventory (`₱171,640 + ₱57,320`)** | **₱228,960.00** |

---

## 2. Sales, FIFO COGS & Gross Margin

| Document | Customer | Gross Billed | VAT-Exempt Sales | VATable Net Sales | Output VAT (12%) | Net Revenue (ex-VAT) | FIFO COGS | Gross Profit |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CI-2026-1140` | San Jorge Piggery (`CUST-001`) | ₱44,052.00 | ₱42,820.00 | ₱1,100.00 | ₱132.00 | ₱43,920.00 | ₱39,810.00 | ₱4,110.00 |
| `SI-2026-501` | Walk-In Catbalogan (`CUST-WALKIN`) | ₱1,862.00 | ₱1,190.00 | ₱600.00 | ₱72.00 | ₱1,790.00 | ₱1,380.00 | ₱410.00 |
| `SI-2026-502` | Gandara Poultry (`CUST-003`) | ₱15,240.00 | ₱15,240.00 | ₱0.00 | ₱0.00 | ₱15,240.00 | ₱14,240.00 | ₱1,000.00 |
| `CI-2026-1141` | Calbayog Agrivet (`CUST-002`)* | ₱43,900.00 | ₱43,900.00 | ₱0.00 | ₱0.00 | ₱43,900.00 | ₱41,400.00 | ₱2,500.00 |
| `SI-2026-503` | Catarman Coop (`CUST-004`) | ₱23,540.00 | ₱23,540.00 | ₱0.00 | ₱0.00 | ₱23,540.00 | ₱21,380.00 | ₱2,160.00 |
| `SI-2026-504` | Walk-In Catbalogan (`CUST-WALKIN`) | ₱2,620.00 | ₱2,620.00 | ₱0.00 | ₱0.00 | ₱2,620.00 | ₱2,260.00 | ₱360.00 |
| **Total Day 1** | | **₱131,214.00** | **₱129,310.00** | **₱1,700.00** | **₱204.00** | **₱131,010.00** | **₱120,470.00** | **₱10,540.00** |

*\*Note: `CI-2026-1141` reflects ₱44,300.00 list Dealer price less **₱400.00** volume rebate (20 sacks `FEED-HG50` × ₱20/sack) = **₱43,900.00** net billed.*  
**Gross Margin:** ₱10,540.00 ÷ ₱131,010.00 = **8.05%**

---

## 3. VAT Summary

| VAT Component | Amount | Source |
| :--- | :--- | :--- |
| Output VAT (12% on VATable sales) | ₱204.00 | `CI-2026-1140` (₱132.00) + `SI-2026-501` (₱72.00) |
| Less: Input VAT (12% on VATable purchases) | (₱240.00) | `SAV-1104` (10 packs `VET-MV01` × ₱24.00) |
| **Net VAT Position** | **(₱36.00)** | **₱36.00 Excess Input VAT Credit** *(asset)* |

---

## 4. Cash, Bank, GCash & PDC Balances

| Account | Opening | Inflows | Outflows | Closing Balance |
| :--- | :--- | :--- | :--- | :--- |
| Catbalogan Counter Cash Drawer | ₱25,000.00 | +₱1,862.00 (`SI-501`) + ₱15,240.00 (`SI-502` remit) | ₱0.00 | **₱42,102.00** |
| Catarman Depot Cash Drawer | ₱10,000.00 | +₱8,540.00 (`SI-503` cash portion) | ₱0.00 | **₱18,540.00** |
| GCash Business Wallet | ₱18,500.00 | +₱15,000.00 (`SI-503` GCash) + ₱2,620.00 (`SI-504`) | ₱0.00 | **₱36,120.00** |
| BDO Business Checking Account | ₱210,000.00 | +₱20,000.00 (`CR-2026-401` San Jorge) | −₱85,000.00 (`CV-088`) − ₱14,640.00 (`CV-089`) | **₱130,360.00** |
| **Total Liquid Funds** | **₱263,500.00** | **+₱63,262.00** | **(₱99,640.00)** | **₱227,122.00** |
| Undeposited PDCs on Hand | ₱0.00 | +₱48,500.00 (`PDC #004912`, Metrobank, Dec 4) | ₱0.00 | **₱48,500.00** |

---

## 5. Accounts Receivable (AR) & Accounts Payable (AP)

### Accounts Receivable (AR)

| Customer | Opening AR | + New Credit Sales | − Collections | Closing AR | Open Invoices |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `CUST-001` San Jorge Piggery | ₱32,000.00 | +₱44,052.00 (`CI-1140`) | −₱20,000.00 (`CR-401`) | **₱56,052.00** | `CI-2026-1102` (₱12,000 due Nov 27) + `CI-2026-1140` (₱44,052 due Dec 9) |
| `CUST-002` Calbayog Agrivet | ₱48,500.00 | +₱43,900.00 (`CI-1141`) | −₱48,500.00 (`CR-402` PDC)* | **₱43,900.00** | `CI-2026-1141` (₱43,900 due Dec 24) |
| **Total AR** | **₱80,500.00** | **+₱87,952.00** | **(₱68,500.00)** | **₱99,952.00** | |

*\*Note on PDC Accounting View: If your software keeps `CI-2026-1045` open in AR until `PDC #004912` clears on December 4 rather than reclassifying it to Undeposited PDCs on Hand, `CUST-002` AR will display as **₱92,400.00** and Total AR as **₱148,452.00** (with Undeposited PDCs at ₱0.00).*

### Accounts Payable (AP)

| Supplier | Opening AP | + New Credit Purchases | − Payments | Closing AP | Open Invoices |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SUP-001` Visayas Feed Mills | ₱85,000.00 | +₱120,750.00 (`VFM-9012`) | −₱85,000.00 (`CV-088`) | **₱120,750.00** | `VFM-9012` (₱120,750 due Dec 9) |
| `SUP-002` Samar Agri-Vet | ₱0.00 | +₱14,640.00 (`SAV-1104`) | −₱14,640.00 (`CV-089`) | **₱0.00** | None |
| **Total AP** | **₱85,000.00** | **+₱135,390.00** | **(₱99,640.00)** | **₱120,750.00** | |

---

## 6. Balance Sheet & Equity Tie-Out

| Balance Sheet Line | Opening (Day 0) | Closing (Day 1) |
| :--- | :--- | :--- |
| Liquid Funds (Cash + GCash + BDO) | ₱263,500.00 | ₱227,122.00 |
| Undeposited PDCs on Hand | ₱0.00 | ₱48,500.00 |
| Accounts Receivable | ₱80,500.00 | ₱99,952.00 |
| Inventory on Hand (ex-VAT) | ₱214,280.00 | ₱228,960.00 |
| Excess Input VAT Credit | ₱0.00 | ₱36.00 |
| **Total Assets** | **₱558,280.00** | **₱604,570.00** |
| Less: Accounts Payable | (₱85,000.00) | (₱120,750.00) |
| **Net Equity** | **₱473,280.00** | **₱483,820.00** |

**Equity Proof:** Opening Net Equity **₱473,280.00** + Day 1 Gross/Net Profit **₱10,540.00** = **₱483,820.00** (reconciles to the exact centavo).

# Day 1 Simulation Script — Tuesday, November 24, 2026

This script describes one realistic day of operations for **Samar Island Agri-Feeds Trading**, from 06:30 AM opening to 06:00 PM closing. Carry out each step in chronological order using the starting state in [01-day0-starting-state.md](file:///Users/steveamor/Documents/Projects/Inventory%20System%20V2/Dev-personal-files/simulations/01-day0-starting-state.md).

---

### Step 1 · 06:30 AM — Mill Truck Inbound Arrival & Short Delivery (Catbalogan Main Bodega)
The overnight feed mill truck from **Visayas Feed Mills Corp. (`SUP-001`)** arrives at the Catbalogan Main Bodega against open purchase order **`PO-2026-041`**. Rico unloads and counts the sacks, and the owner notes a **short delivery** of 5 sacks on Hog Starter Pellets (the supplier's dispatch manifest confirms the 5 sacks were left off and will not be billed). The owner short-closes `PO-2026-041` and logs **`RR-2026-071`** against supplier Charge Invoice **`VFM-9012`** (15-day credit, due **December 9, 2026**):

| SKU | Ordered | Received | Expiry Lot | Mfg Date | Exp Date | Unit Cost | Line Total |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `FEED-HS50` | 30 sacks | **25 sacks** *(5 short)* | `HS-2611B` | 2026-11-18 | 2027-02-16 | ₱1,750.00 | ₱43,750.00 |
| `FEED-HG50` | 25 sacks | **25 sacks** | `HG-2611B` | 2026-11-18 | 2027-02-16 | ₱1,640.00 | ₱41,000.00 |
| `FEED-BF50` | 20 sacks | **20 sacks** | `BF-2611B` | 2026-11-18 | 2027-02-16 | ₱1,800.00 | ₱36,000.00 |
| **Total** | | **70 sacks** | | | | | **₱120,750.00** |

---

### Step 2 · 07:00 AM — Confirming Northbound Route Pre-Orders (Catbalogan Office)
Before loading `Elf Truck #1`, the owner finalizes two confirmed customer orders for the Northbound Route:
1. **`SO-2026-201` — San Jorge Piggery Farm (`CUST-001`, Farm tier, 15-day credit):**
   - 15 sacks `FEED-HS50` @ ₱1,900.00 = ₱28,500.00
   - 10 sacks `FEED-HG50` @ ₱1,790.00 = ₱17,900.00
   - **Initial Order Total:** **₱46,400.00** *(Existing AR ₱32,000 + ₱46,400 = ₱78,400, within ₱80,000 credit limit)*
2. **`SO-2026-202` — Calbayog Agrivet Supply (`CUST-002`, Dealer tier, 30-day credit):**
   - 20 sacks `FEED-HG50` @ ₱1,750.00 less ₱20.00/sack **volume rebate** (₱1,730.00 net/sack) = ₱34,600.00
   - 10 sacks `FEED-LM25` @ ₱930.00 = ₱9,300.00
   - **Order Total:** **₱43,900.00** *(Note: `CI-2026-1045` for ₱48,500.00 is 5 days overdue; owner instructs Kuya Jun to collect the overdue ₱48,500.00 before releasing this new delivery.)*

---

### Step 3 · 07:30 AM — Pre-Dispatch Order Modification (San Jorge Piggery)
San Jorge Piggery Farm (`CUST-001`) calls to revise **`SO-2026-201`** before the truck departs:
- Reduce `FEED-HG50` from **10 sacks down to 8 sacks** (saves ₱3,580.00)
- Add **4 packs** of `VET-MV01` (Multivitamin + Electrolyte Powder) @ **₱308.00 VAT-inc** (₱275.00 net + ₱33.00 VAT per pack = **₱1,232.00**)
- **Revised `SO-2026-201` Total:** **₱44,052.00** *(₱42,820.00 VAT-Exempt + ₱1,100.00 VATable net + ₱132.00 Output VAT)*

---

### Step 4 · 08:00 AM — Loading & Dispatch of Elf Truck #1 (Northbound Route)
Rico and Dodoy load `Elf Truck #1` at Catbalogan Main Bodega strictly following **FEFO** (picking oldest Expiry Lots first). Total payload: **92 sacks + 4 packs = 4,204 kg**.

| Allocation / Document | Customer / Destination | Items & Exact Expiry Lots Picked |
| :--- | :--- | :--- |
| **`DR-2026-301` / `CI-2026-1140`** | San Jorge Piggery (`CUST-001`) | • 12 sacks `FEED-HS50` (`HS-2610A` — *depletes oldest lot*)<br>• 3 sacks `FEED-HS50` (`HS-2611A`)<br>• 8 sacks `FEED-HG50` (`HG-2611A`)<br>• 4 packs `VET-MV01` (`MV-2610`) |
| **`DR-2026-302` / `CI-2026-1141`** | Calbayog Agrivet (`CUST-002`) | • 17 sacks `FEED-HG50` (`HG-2611A` — *depletes lot*)<br>• 3 sacks `FEED-HG50` (`HG-2611B`)<br>• 10 sacks `FEED-LM25` (`LM-2611A`) |
| **`STF-2026-019`** | Catarman Satellite Depot (`LOC-CTMN`) | • 10 sacks `FEED-HS50` (`HS-2611A`)<br>• 8 sacks `FEED-BF50` (`BF-2611A`)<br>• 5 sacks `FEED-TF25` (`TF-2611A`) |
| **`LOAD-2026-014`** *(Rolling Stock)* | Unallocated ex-truck stock | • 10 sacks `FEED-BF50` (`BF-2611A`)<br>• 6 sacks `FEED-LM25` (`LM-2611A`) |

Kuya Jun and Dodoy depart Catbalogan heading north on the Maharlika Highway.

---

### Step 5 · 08:45 AM — Counter Sack-Breaking (Catbalogan Main Bodega)
To prepare for morning retail buyers asking for per-kilo broiler feed, the owner has Rico open **1 sealed 50 kg sack** of `FEED-BF50` from lot **`BF-2611B`** (sack cost ₱1,800.00) and pour it into the front counter's **Loose Bin** (**50.0 kg** @ ₱36.00/kg cost).

---

### Step 6 · 09:15 AM — Morning Walk-In Counter Sale (Catbalogan Main Bodega)
A walk-in backyard raiser (`CUST-WALKIN`, Walk-In Retail tier) buys at the Catbalogan counter under **`SI-2026-501`** and pays **Cash** into the Catbalogan Counter Cash Drawer:
- 10 kg loose `FEED-BF50` (`BF-2611B`) @ ₱44.00/kg = ₱440.00 *(VAT-Exempt)*
- 1 sack `RAW-DRK50` (`DRK-2611A`) @ ₱750.00 = ₱750.00 *(VAT-Exempt)*
- 2 packs `VET-MV01` (`MV-2610`) @ ₱336.00 VAT-inc = ₱672.00 *(₱600.00 net + ₱72.00 Output VAT)*
- **Total Collected (Cash):** **₱1,862.00**

---

### Step 7 · 09:30 AM — Route Stop 1: San Jorge Delivery & Partial Payment
`Elf Truck #1` arrives at **San Jorge Piggery Farm (`CUST-001`)**.
- The farm manager signs **`DR-2026-301`** and accepts **`CI-2026-1140`** for **₱44,052.00** (15-day credit, due **December 9, 2026**).
- At the same time, the farm sends a **₱20,000.00 BDO Bank Transfer** as a **partial payment** against their earlier open invoice **`CI-2026-1102`** (₱32,000.00 balance), leaving **₱12,000.00** unpaid on `CI-2026-1102`. The owner confirms the transfer in BDO online banking and issues **`CR-2026-401`**.

---

### Step 8 · 10:30 AM — Supplier AP Settlement (Visayas Feed Mills Corp.)
Today is the due date of **Visayas Feed Mills Corp. (`SUP-001`)** invoice **`SI-VFM-8841`** (**₱85,000.00**, dated Nov 9). The owner transfers **₱85,000.00** from the **BDO Business Checking Account** and records **`CV-2026-088`**.

---

### Step 9 · 11:15 AM — Route Stop 2: Unplanned Ex-Truck Rolling-Stock Sale (Gandara)
While passing through Gandara, **Gandara Poultry & Feeds (`CUST-003`, Dealer tier, COD)** flags down `Elf Truck #1` to buy immediate stock from the truck's **Rolling Stock (`LOAD-2026-014`)**. Kuya Jun calls the owner for price confirmation, delivers the sacks, and collects full **COD Cash** under **`SI-2026-502`**:
- 6 sacks `FEED-BF50` (`BF-2611A`) @ ₱1,920.00 = ₱11,520.00 *(VAT-Exempt)*
- 4 sacks `FEED-LM25` (`LM-2611A`) @ ₱930.00 = ₱3,720.00 *(VAT-Exempt)*
- **Total Collected (Cash held by Kuya Jun for EOD remittance):** **₱15,240.00**

---

### Step 10 · 12:00 PM — Local Supplier Inbound Delivery & Immediate Payment (Catbalogan)
**Samar Agri-Vet & Rice Mill Trading (`SUP-002`)** delivers a noon restock order (**`PO-2026-042`** / **`RR-2026-072`** / Supplier SI **`SAV-1104`**) to Catbalogan Main Bodega:
- 20 sacks `RAW-DRK50` (`DRK-2611B`, Mfg 2026-11-23, Exp 2027-01-23) @ ₱620.00 = ₱12,400.00 *(VAT-Exempt)*
- 10 packs `VET-MV01` (`MV-2611`, Mfg 2026-11-10, Exp 2027-11-10) @ ₱224.00 VAT-inc = ₱2,240.00 *(₱2,000.00 net + ₱240.00 Input VAT)*
- **Total Due:** **₱14,640.00** — paid immediately by the owner via **BDO Bank Transfer** (**`CV-2026-089`**).

---

### Step 11 · 01:15 PM — Route Stop 3: Overdue Collection & Pre-Order Delivery (Calbayog)
`Elf Truck #1` reaches **Calbayog Agrivet Supply (`CUST-002`)**:
1. Before unloading, Kuya Jun collects a **Post-Dated Check (`PDC #004912`, Metrobank, dated December 4, 2026)** for **₱48,500.00** settling overdue **`CI-2026-1045`** (owner approves via phone and records **`CR-2026-402`**).
2. With the overdue balance settled, Kuya Jun unloads **`DR-2026-302`** and hands over **`CI-2026-1141`** for **₱43,900.00** (30-day credit, due **December 24, 2026**, reflecting the ₱20.00/sack volume rebate on 20 sacks `FEED-HG50`).

---

### Step 12 · 02:30 PM — Route Stop 4: Catarman Satellite Depot Replenishment Drop
`Elf Truck #1` arrives at **Catarman Satellite Depot (`LOC-CTMN`)** and unloads **`STF-2026-019`**:
- 10 sacks `FEED-HS50` (`HS-2611A`)
- 8 sacks `FEED-BF50` (`BF-2611A`)
- 5 sacks `FEED-TF25` (`TF-2611A`)

Ate Marites verifies the physical count and texts confirmation to the owner.

---

### Step 13 · 03:15 PM — Catarman Satellite Depot Counter Sale
**Catarman Backyard Raisers Coop (`CUST-004`, Farm tier, COD/GCash)** picks up feeds at the Catarman Satellite Depot under **`SI-2026-503`**:
- 8 sacks `FEED-HS50` (`HS-2611A`) @ ₱1,900.00 = ₱15,200.00 *(VAT-Exempt)*
- 6 sacks `FEED-TF25` (`TF-2611A`) @ ₱1,030.00 = ₱6,180.00 *(VAT-Exempt)*
- 3 sacks `RAW-DRK50` (`DRK-2611A`) @ ₱720.00 = ₱2,160.00 *(VAT-Exempt)*
- **Total Billed:** **₱23,540.00** — settled with a **split payment**: **₱15,000.00 via GCash** (sent directly to the business GCash wallet, verified by owner) + **₱8,540.00 Cash** (placed in the Catarman Depot Cash Drawer).

---

### Step 14 · 04:00 PM — Afternoon Walk-In Counter Sale (Catbalogan Main Bodega)
A walk-in customer (`CUST-WALKIN`, Walk-In Retail tier) buys at the Catbalogan counter under **`SI-2026-504`** and pays via **GCash**:
- 15 kg loose `FEED-BF50` (`BF-2611B`) @ ₱44.00/kg = ₱660.00 *(VAT-Exempt)*
- 2 sacks `FEED-LM25` (`LM-2611A`) @ ₱980.00 = ₱1,960.00 *(VAT-Exempt)*
- **Total Collected (GCash Business Wallet):** **₱2,620.00**

---

### Step 15 · 05:45 PM — Truck Return, Unsold Rolling Stock Check-In & EOD Remittance (Catbalogan)
`Elf Truck #1` returns to Catbalogan Main Bodega. Kuya Jun and Dodoy unload the unsold **Rolling Stock (`RET-LOAD-2026-014`)** back into the Main Bodega (`LOC-CATB`), leaving `Elf Truck #1` empty:
- **4 sacks** `FEED-BF50` (`BF-2611A`)
- **2 sacks** `FEED-LM25` (`LM-2611A`)

Kuya Jun hands over his route **Remittance** to the owner:
- **₱15,240.00 Cash** (from Gandara `SI-2026-502`) → placed into the **Catbalogan Counter Cash Drawer**
- **₱48,500.00 `PDC #004912`** (from Calbayog `CR-2026-402`) → logged into **Undeposited PDCs on Hand**
- Signed copies of `DR-2026-301`, `DR-2026-302`, `STF-2026-019`, and `SI-2026-502`

At **06:00 PM**, the owner closes the books for the day.

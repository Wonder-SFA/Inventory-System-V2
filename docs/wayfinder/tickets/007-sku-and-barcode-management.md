# 007: SKU & Barcode/QR Management (Feature #2)

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [005: Phased Roadmap & Module Extension Points](./005-phased-roadmap-and-extension-points.md)

## Question

Which barcode/QR formats (EAN, UPC, Code128, QR), auto-generation rules, label-printing workflows, and hardware/camera scanning behaviors should plug into `catalog`'s flexible SKU lookup for Phase 2?

## Resolution

Locked the Phase 2 SKU & Barcode/QR Management design plugging into `catalog`'s flexible SKU lookup:

1. **Supported Formats & Multiple Barcodes per SKU:**
   - Support all standard formats: **UPC, EAN, Code 128, and QR codes**.
   - Allow **multiple barcodes per SKU** (for example, an internal warehouse Code 128/QR label alongside one or more manufacturer or supplier UPC/EAN barcodes). Each active barcode maps unambiguously to a single SKU.
2. **Code Creation & Auto-Generation:**
   - Barcodes are **left blank by default** when creating a new SKU.
   - Staff can type or scan manufacturer/supplier barcodes anytime, or click a **"Generate Barcode"** button to auto-generate a unique internal Code 128 or QR code.
3. **Label-Printing Workflows:**
   - Generate **print-ready PDFs directly from the browser** supporting both **standard office label sheets** (Avery-style grids) and **common thermal roll sizes** (printed via the OS print dialog).
   - Labels display Product/SKU name, SKU code, barcode/QR image, and **optional price** (respecting the `View Costs & Prices` permission from [006: Role-Based Permissions](./006-role-based-permissions.md)).
4. **Hardware & Camera Scanning Behavior:**
   - Support both **USB/Bluetooth handheld scanners** (keyboard-wedge input) and **browser camera scanning** (phone/tablet/webcam).
   - Enable **rapid "scan-to-increment" (+1 per scan)** on receiving, shipping, transfer, and stock-count screens, with instant audio/visual confirmation feedback.
5. **Unknown or Unexpected Scans (Owner-Configurable):**
   - **Default behavior:** Block & alert clearly (error beep + red visual warning) when a scanned barcode is unknown or does not belong to the active order, with a quick option on unknown codes to assign to an existing SKU or create a new SKU (if permitted).
   - **Owner toggle:** Expose a system setting so the **Owner** can toggle how unexpected-on-order or unknown scans are handled (e.g., strict block-and-alert vs. prompt/allow adding to the active order).

# 006: Role-Based Permissions (Feature #7)

**Label:** `wayfinder:grilling`
**Status:** Closed
**Assignee:** Antigravity
**Blocked by:** [005: Phased Roadmap & Module Extension Points](./005-phased-roadmap-and-extension-points.md)

## Question

What exact roles, permission matrix (who can view, adjust stock, approve orders, or override negative stock/discounts), location-level access scopes, and approval thresholds should plug into the `iam` permission gate for Phase 2?

## Resolution

Locked the Phase 2 Role-Based Permissions design for the `iam` feature box:

1. **Custom Roles + Protected Owner + Editable Starters:**
   - One protected **`Owner`** role (always has full access, cannot be edited or deleted, preventing accidental lockout).
   - Ships with 4 editable starter role templates (**`Admin`**, **`Manager`**, **`Staff`**, **`Viewer`**) that Admins can customize, duplicate, or replace with fully custom roles built from granular permission checkboxes.

2. **User-Level Location Scoping:**
   - Roles define *what* actions a user can perform; Locations assigned to each user define *where* they can perform them (specific Locations or `All Locations`).
   - For Transfer Orders, dispatching from Location A requires access to Location A, and receiving at Location B requires access to Location B.

3. **Granular Permission Matrix & Optional Limits:**
   - **Yes/No Permission Checkboxes** across all 4 feature boxes:
     - `catalog`: View Products/SKUs, Create/Edit Products/SKUs, Archive/Delete Products/SKUs.
     - `inventory`: View Stock & Movements, Record Manual Adjustments, **Allow Negative Stock** (dedicated permission—users without it are blocked from pushing stock below zero; users with it proceed with the Phase 1 warning + Zero/Negative marker).
     - `orders`: View Orders, Draft Orders, Confirm Orders, Receive/Ship/Deliver Orders, Cancel/Close Orders, and **View Costs & Prices** (hides supplier `unitCost` and financial totals from staff who shouldn't see margins or purchase costs).
     - `iam`: Manage Users & Location Assignments, Manage Custom Roles, View IAM Audit Log.
   - **Optional Dollar/Quantity Limits:** Per role/permission, an Admin can optionally configure a max limit (e.g., max Purchase Order total or max manual adjustment quantity). Actions above the limit are blocked and require a user whose role has a higher or unlimited threshold.
   - **Deferred:** Two-person "Pending Approval" queues/states are deferred to a later phase to keep Phase 2 workflows simple.

4. **Immediate Enforcement & Auditability:**
   - Role, permission, and Location assignment changes take effect **immediately** on the user's next request via `iam`'s `authorize(actor, action, resource)` gate.
   - All role creations, permission edits, limit changes, and user role/location updates are recorded in an immutable **IAM Audit Log**.

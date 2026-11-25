'use client';

import {
  type Decimal4,
  type RecentReceiptCostsResult,
  ZERO_DECIMAL4,
  add,
  formatDecimal4,
  gt,
  isPositive,
} from '@iv2/shared-domain';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiClientError, apiFetch } from '../lib/api-client';

export interface CutoverLocationTarget {
  locationId: string;
  locationName: string;
  unlottedOnHand: string;
  currency: string;
}

export interface LotDraftRow {
  lotCode: string;
  mfgDate: string;
  expDate: string;
  quantity: string;
  unitCost: string;
}

export interface LocationLotAssignment {
  locationId: string;
  lots: Array<{
    lotCode: string;
    mfgDate?: string | null;
    expDate?: string | null;
    quantity: string;
    unitCost?: string;
  }>;
}

interface OpeningLotCutoverModalProps {
  open: boolean;
  mode: 'cutover' | 'cycle-count';
  sku: {
    id: string;
    code: string;
    name: string;
    trackExpiry: boolean;
  };
  locations: CutoverLocationTarget[];
  onClose: () => void;
  onSkipProspective?: () => Promise<void>;
  onConfirmAssign: (assignments: LocationLotAssignment[]) => Promise<void>;
}

export function OpeningLotCutoverModal({
  open,
  mode,
  sku,
  locations,
  onClose,
  onSkipProspective,
  onConfirmAssign,
}: OpeningLotCutoverModalProps) {
  const [rowsByLoc, setRowsByLoc] = useState<Record<string, LotDraftRow[]>>({});
  const [costHints, setCostHints] = useState<Record<string, RecentReceiptCostsResult | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || locations.length === 0) return;
    let active = true;
    setError(null);

    const initial: Record<string, LotDraftRow[]> = {};
    for (const loc of locations) {
      initial[loc.locationId] = [
        {
          lotCode: '',
          mfgDate: '',
          expDate: '',
          quantity: loc.unlottedOnHand,
          unitCost: '',
        },
      ];
    }
    setRowsByLoc(initial);

    Promise.all(
      locations.map(async (loc) => {
        try {
          const res = await apiFetch<RecentReceiptCostsResult>(
            `/api/v1/skus/${sku.id}/recent-receipt-costs?locationId=${encodeURIComponent(loc.locationId)}`,
          );
          return [loc.locationId, res.data] as const;
        } catch {
          return [loc.locationId, null] as const;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const hintMap: Record<string, RecentReceiptCostsResult | null> = {};
      for (const [locId, hint] of entries) {
        hintMap[locId] = hint;
      }
      setCostHints(hintMap);
      setRowsByLoc((prev) => {
        const next: Record<string, LotDraftRow[]> = {};
        for (const [locId, rows] of Object.entries(prev)) {
          const suggested = hintMap[locId]?.suggestedUnitCost;
          next[locId] = rows.map((r) =>
            !r.unitCost && suggested ? { ...r, unitCost: suggested } : r,
          );
        }
        return next;
      });
    });

    return () => {
      active = false;
    };
  }, [open, sku.id, locations]);

  if (!open) return null;

  function updateRow(locId: string, index: number, patch: Partial<LotDraftRow>) {
    setRowsByLoc((prev) => ({
      ...prev,
      [locId]: (prev[locId] ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }

  function addRow(locId: string) {
    const suggested = costHints[locId]?.suggestedUnitCost ?? '';
    setRowsByLoc((prev) => ({
      ...prev,
      [locId]: [
        ...(prev[locId] ?? []),
        { lotCode: '', mfgDate: '', expDate: '', quantity: '', unitCost: suggested },
      ],
    }));
  }

  function removeRow(locId: string, index: number) {
    setRowsByLoc((prev) => ({
      ...prev,
      [locId]: (prev[locId] ?? []).filter((_, i) => i !== index),
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const assignments: LocationLotAssignment[] = [];
    for (const loc of locations) {
      const rows = (rowsByLoc[loc.locationId] ?? []).filter(
        (r) => r.lotCode.trim() !== '' || r.quantity.trim() !== '',
      );
      if (rows.length === 0) continue;

      let total: Decimal4 = ZERO_DECIMAL4;
      let max: Decimal4;
      try {
        max = formatDecimal4(loc.unlottedOnHand);
      } catch {
        max = ZERO_DECIMAL4;
      }
      const lots: LocationLotAssignment['lots'] = [];

      for (const r of rows) {
        if (!r.lotCode.trim()) {
          setError(`Lot code is required at ${loc.locationName}`);
          return;
        }
        let qty: Decimal4;
        try {
          qty = formatDecimal4(r.quantity.trim());
        } catch {
          setError(`Quantity must be greater than zero for lot ${r.lotCode} at ${loc.locationName}`);
          return;
        }
        if (!isPositive(qty)) {
          setError(`Quantity must be greater than zero for lot ${r.lotCode} at ${loc.locationName}`);
          return;
        }
        if (sku.trackExpiry && !r.expDate) {
          setError(`Expiry date is required for lot ${r.lotCode} at ${loc.locationName}`);
          return;
        }
        total = add(total, qty);
        lots.push({
          lotCode: r.lotCode.trim(),
          ...(r.mfgDate ? { mfgDate: r.mfgDate } : {}),
          ...(r.expDate ? { expDate: r.expDate } : {}),
          quantity: qty,
          ...(r.unitCost.trim() ? { unitCost: r.unitCost.trim() } : {}),
        });
      }

      if (gt(total, max)) {
        setError(
          `Declared quantities (${total}) exceed unlotted stock (${loc.unlottedOnHand}) at ${loc.locationName}`,
        );
        return;
      }

      assignments.push({ locationId: loc.locationId, lots });
    }

    if (assignments.length === 0) {
      setError('Declare at least one Stock Lot or choose "Skip & Drain Old Stock First".');
      return;
    }

    setSubmitting(true);
    try {
      await onConfirmAssign(assignments);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to assign opening lots');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!onSkipProspective) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSkipProspective();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to enable lot tracking');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cutover-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 60,
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 760, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <div>
            <h2 id="cutover-modal-title" style={{ margin: 0, fontSize: 18 }}>
              {mode === 'cutover'
                ? 'Enable Lot Tracking — Guided Opening Split'
                : 'Assign Remaining Unlotted Stock (Cycle Count)'}
            </h2>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {sku.code} — {sku.name} {sku.trackExpiry ? '(Expiry required)' : '(Expiry optional)'}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={submitting}>
            Close
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
          {mode === 'cutover'
            ? 'This SKU has existing On-Hand Stock. Declare its physical Stock Lots below (pre-filled with recent PO receipt cost hints), or skip to leave existing stock unlotted so it drains first.'
            : 'Reclassify remaining unlotted shelf stock into physical Stock Lots. You can assign all or part of the remaining unlotted quantity.'}
        </p>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={handleSubmit}>
          {locations.map((loc) => {
            const rows = rowsByLoc[loc.locationId] ?? [];
            const hint = costHints[loc.locationId];
            const declaredSum = rows.reduce<Decimal4>((acc, r) => {
              const trimmed = r.quantity.trim();
              if (!trimmed) return acc;
              try {
                return add(acc, formatDecimal4(trimmed));
              } catch {
                return acc;
              }
            }, ZERO_DECIMAL4);
            return (
              <div
                key={loc.locationId}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <div>
                    <strong>{loc.locationName}</strong>
                    <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--muted)' }}>
                      Unlotted On-Hand: {loc.unlottedOnHand} (Declared: {declaredSum})
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => addRow(loc.locationId)}
                    disabled={submitting}
                  >
                    + Add Lot
                  </button>
                </div>

                {hint?.suggestedUnitCost && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                    Recent PO Cost Hint: {hint.suggestedUnitCost} {hint.currency}
                    {hint.recentReceipts.length > 1
                      ? ` (${hint.recentReceipts.length} recent PO receipts)`
                      : ''}
                  </div>
                )}

                {rows.map((row, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.3fr 1fr 1fr 0.9fr 0.9fr auto',
                      gap: 8,
                      alignItems: 'end',
                      marginBottom: 8,
                    }}
                  >
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Lot Code *</label>
                      <input
                        value={row.lotCode}
                        onChange={(e) => updateRow(loc.locationId, idx, { lotCode: e.target.value })}
                        placeholder="LOT-001"
                      />
                    </div>
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Mfg Date</label>
                      <input
                        type="date"
                        value={row.mfgDate}
                        onChange={(e) => updateRow(loc.locationId, idx, { mfgDate: e.target.value })}
                      />
                    </div>
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>
                        Exp Date {sku.trackExpiry ? '*' : ''}
                      </label>
                      <input
                        type="date"
                        value={row.expDate}
                        onChange={(e) => updateRow(loc.locationId, idx, { expDate: e.target.value })}
                      />
                    </div>
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Qty *</label>
                      <input
                        value={row.quantity}
                        onChange={(e) =>
                          updateRow(loc.locationId, idx, { quantity: e.target.value })
                        }
                        placeholder="0.0000"
                      />
                    </div>
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 11 }}>Unit Cost</label>
                      <input
                        value={row.unitCost}
                        onChange={(e) =>
                          updateRow(loc.locationId, idx, { unitCost: e.target.value })
                        }
                        placeholder="Optional"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => removeRow(loc.locationId, idx)}
                      disabled={rows.length <= 1 || submitting}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            {mode === 'cutover' && onSkipProspective && (
              <button
                type="button"
                className="btn"
                onClick={handleSkip}
                disabled={submitting}
              >
                Skip &amp; Drain Old Stock First
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving...' : 'Confirm & Assign Lots'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

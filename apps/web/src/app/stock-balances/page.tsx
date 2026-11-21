'use client';

import type {
  AdjustmentReasonCategory,
  Location,
  Sku,
  StockBalance,
  StockBalanceView,
  StockMovement,
} from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

const REASON_CATEGORIES: { value: AdjustmentReasonCategory; label: string }[] = [
  { value: 'STOCK_COUNT', label: 'Stock Count' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'LOST', label: 'Lost' },
  { value: 'OTHER', label: 'Other' },
];

export default function StockBalancesPage() {
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [view, setView] = useState<StockBalanceView>('per-location');
  const [locationId, setLocationId] = useState<string>('');
  const [zeroOrNegativeOnly, setZeroOrNegativeOnly] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);

  // Manual Stock Adjustment modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [adjSkuId, setAdjSkuId] = useState('');
  const [adjLocationId, setAdjLocationId] = useState('');
  const [adjQuantityDelta, setAdjQuantityDelta] = useState('');
  const [adjReasonCategory, setAdjReasonCategory] =
    useState<AdjustmentReasonCategory>('STOCK_COUNT');
  const [adjUnitCost, setAdjUnitCost] = useState('');
  const [adjNote, setAdjNote] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadBalances = useCallback(
    async (
      currentView: StockBalanceView,
      currentLocId: string,
      onlyZeroOrNeg: boolean,
      cursor?: string,
    ) => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      params.set('view', currentView);
      if (currentView === 'per-location' && currentLocId) {
        params.set('locationId', currentLocId);
      }
      if (onlyZeroOrNeg) {
        params.set('zeroOrNegativeOnly', 'true');
      }
      if (cursor) {
        params.set('cursor', cursor);
      }

      const res = await apiFetchPaginated<StockBalance>(
        `/api/v1/stock-balances?${params.toString()}`,
      );
      if (cursor) {
        setBalances((prev) => [...prev, ...res.data]);
      } else {
        setBalances(res.data);
      }
      setNextCursor(res.page.nextCursor);
      setHasMore(res.page.hasMore);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetchPaginated<Location>('/api/v1/locations?status=ACTIVE&limit=100'),
      apiFetchPaginated<Sku>('/api/v1/skus?status=ACTIVE&limit=100'),
    ])
      .then(([locRes, skuRes]) => {
        if (!active) return;
        setLocations(locRes.data);
        setSkus(skuRes.data);
        if (locRes.data.length > 0 && !adjLocationId) {
          setAdjLocationId(locRes.data[0]!.id);
        }
        if (skuRes.data.length > 0 && !adjSkuId) {
          setAdjSkuId(skuRes.data[0]!.id);
        }
      })
      .catch(() => {
        // Handled when balances load or modal opens
      });
    return () => {
      active = false;
    };
  }, [adjLocationId, adjSkuId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadBalances(view, locationId, zeroOrNegativeOnly)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load stock balances');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [view, locationId, zeroOrNegativeOnly, loadBalances]);

  const summary = useMemo(() => {
    let totalInventoryValue = 0;
    let estimatedNegativeCount = 0;
    let hasCosts = false;
    for (const row of balances) {
      if (row.totalValue !== undefined) {
        hasCosts = true;
        totalInventoryValue += Number.parseFloat(row.totalValue);
      }
      if (row.valuationStatus === 'ESTIMATED_NEGATIVE_STOCK') {
        estimatedNegativeCount += 1;
      }
    }
    return {
      totalInventoryValue: hasCosts ? totalInventoryValue.toFixed(4) : null,
      estimatedNegativeCount,
      rowCount: balances.length,
    };
  }, [balances]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadBalances(view, locationId, zeroOrNegativeOnly, nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more balances');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleAdjustmentSubmit(e: FormEvent) {
    e.preventDefault();
    setModalError(null);
    setSubmitting(true);

    try {
      const res = await apiFetch<StockMovement>('/api/v1/stock-movements/adjustments', {
        method: 'POST',
        body: JSON.stringify({
          skuId: adjSkuId,
          locationId: adjLocationId,
          quantityDelta: adjQuantityDelta.trim(),
          reasonCategory: adjReasonCategory,
          ...(adjUnitCost.trim() ? { unitCost: adjUnitCost.trim() } : {}),
          note: adjNote.trim() || null,
        }),
      });

      setWarnings(
        (res.warnings ?? []).map((w) => ({
          code: w.code,
          message: w.message,
        })),
      );
      setModalOpen(false);
      setAdjQuantityDelta('');
      setAdjUnitCost('');
      setAdjNote('');
      await loadBalances(view, locationId, zeroOrNegativeOnly);
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : 'Failed to post manual stock adjustment',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <div className="toolbar">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Stock Balances &amp; Valuation</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Projected On-Hand Stock, Reserved Stock, Available Stock, In-Transit Stock, and
            Weighted Average Cost.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setModalError(null);
            setModalOpen(true);
          }}
        >
          Manual Stock Adjustment
        </button>
      </div>

      {warnings.length > 0 && (
        <div
          className="access-banner read-only"
          role="status"
          style={{ marginBottom: 16, borderRadius: 6 }}
        >
          {warnings.map((w, idx) => (
            <div key={`${w.code}-${idx}`}>
              <strong>{w.code}:</strong> {w.message}
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            TOTAL INVENTORY VALUE
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {summary.totalInventoryValue !== null ? `$${summary.totalInventoryValue}` : 'Redacted'}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            DISPLAYED BALANCES
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{summary.rowCount}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            ESTIMATED — NEGATIVE STOCK
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginTop: 4,
              color: summary.estimatedNegativeCount > 0 ? 'var(--warn-text)' : 'inherit',
            }}
          >
            {summary.estimatedNegativeCount}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
            <button
              type="button"
              className={`tab-btn${view === 'per-location' ? ' active' : ''}`}
              onClick={() => setView('per-location')}
            >
              Per-Location
            </button>
            <button
              type="button"
              className={`tab-btn${view === 'company-wide' ? ' active' : ''}`}
              onClick={() => setView('company-wide')}
            >
              Company-Wide
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {view === 'per-location' && (
              <select
                aria-label="Filter by Location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                style={{
                  padding: '7px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                <option value="">All Locations</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={zeroOrNegativeOnly}
                onChange={(e) => setZeroOrNegativeOnly(e.target.checked)}
              />
              Zero / Negative Stock Only
            </label>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading stock balances...</p>
        ) : balances.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            No stock balances match the current filters.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  {view === 'per-location' && <th>Location</th>}
                  <th>On-Hand</th>
                  <th>Reserved</th>
                  <th>Available</th>
                  <th>In-Transit</th>
                  <th>Weighted Avg Cost</th>
                  <th>Total Value</th>
                  <th>Selling Price</th>
                  <th>Gross Margin</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((row) => (
                  <tr key={`${row.skuId}:${row.locationId ?? 'company'}`}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.skuCode}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{row.skuName}</div>
                    </td>
                    {view === 'per-location' && <td>{row.locationName ?? row.locationId}</td>}
                    <td>{row.onHand}</td>
                    <td>{row.reserved}</td>
                    <td>{row.available}</td>
                    <td>{row.inTransit}</td>
                    <td>
                      {row.weightedAverageCost !== undefined ? row.weightedAverageCost : '—'}
                    </td>
                    <td>{row.totalValue !== undefined ? row.totalValue : '—'}</td>
                    <td>{row.sellingPrice ?? '—'}</td>
                    <td>
                      {row.grossMargin !== undefined && row.grossMargin !== null
                        ? `${row.grossMargin}${row.grossMarginPercent ? ` (${row.grossMarginPercent}%)` : ''}`
                        : '—'}
                    </td>
                    <td>
                      {row.valuationStatus === 'ESTIMATED_NEGATIVE_STOCK' ? (
                        <span
                          className="badge"
                          style={{
                            background: 'var(--warn-bg)',
                            color: 'var(--warn-text)',
                            border: '1px solid var(--warn-border)',
                          }}
                        >
                          Estimated — Negative Stock
                        </span>
                      ) : (
                        <span className="badge badge-active">Normal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && (
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}
      </div>

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="adj-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 50,
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 480 }}>
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <h2 id="adj-modal-title" style={{ margin: 0, fontSize: 18 }}>
                Manual Stock Adjustment
              </h2>
              <button type="button" className="btn btn-sm" onClick={() => setModalOpen(false)}>
                Close
              </button>
            </div>

            {modalError && <div className="error-box">{modalError}</div>}

            <form onSubmit={handleAdjustmentSubmit}>
              <div className="form-field">
                <label htmlFor="adj-sku">SKU</label>
                <select
                  id="adj-sku"
                  value={adjSkuId}
                  onChange={(e) => setAdjSkuId(e.target.value)}
                  required
                >
                  {skus.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="adj-location">Location</label>
                <select
                  id="adj-location"
                  value={adjLocationId}
                  onChange={(e) => setAdjLocationId(e.target.value)}
                  required
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="adj-qty">Quantity Delta (4-decimal, positive or negative)</label>
                <input
                  id="adj-qty"
                  type="text"
                  placeholder="e.g. 10.0000 or -2.5000"
                  value={adjQuantityDelta}
                  onChange={(e) => setAdjQuantityDelta(e.target.value)}
                  required
                />
              </div>

              <div className="form-field">
                <label htmlFor="adj-reason">Reason Category</label>
                <select
                  id="adj-reason"
                  value={adjReasonCategory}
                  onChange={(e) =>
                    setAdjReasonCategory(e.target.value as AdjustmentReasonCategory)
                  }
                  required
                >
                  {REASON_CATEGORIES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label htmlFor="adj-cost">Unit Cost (optional, for positive adjustments)</label>
                <input
                  id="adj-cost"
                  type="text"
                  placeholder="e.g. 12.5000"
                  value={adjUnitCost}
                  onChange={(e) => setAdjUnitCost(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label htmlFor="adj-note">Note (optional)</label>
                <textarea
                  id="adj-note"
                  rows={2}
                  value={adjNote}
                  onChange={(e) => setAdjNote(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Submitting...' : 'Post Adjustment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}

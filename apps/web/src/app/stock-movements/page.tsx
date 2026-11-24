'use client';

import {
  type EffectiveLotPolicy,
  type Location,
  SSE_TOPICS,
  type Sku,
  type StockLotBalance,
  type StockMovement,
  type StockMovementType,
} from '@iv2/shared-domain';
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

const MOVEMENT_TYPES: StockMovementType[] = [
  'RECEIPT',
  'ISSUE',
  'ADJUSTMENT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
];

export default function StockMovementsPage() {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuId, setSkuId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [movementType, setMovementType] = useState<'' | StockMovementType>('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Manual Issue modal state
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [issueLocationId, setIssueLocationId] = useState('');
  const [issueSkuId, setIssueSkuId] = useState('');
  const [issueQty, setIssueQty] = useState('1.0000');
  const [issueNote, setIssueNote] = useState('');
  const [issuePolicy, setIssuePolicy] = useState<EffectiveLotPolicy | null>(null);
  const [issueLotBalances, setIssueLotBalances] = useState<StockLotBalance[]>([]);
  const [issueLotAllocations, setIssueLotAllocations] = useState<Record<string, string>>({});
  const [issueSkipLots, setIssueSkipLots] = useState(false);
  const [issueConfirmExpired, setIssueConfirmExpired] = useState(false);
  const [issueOverrideReason, setIssueOverrideReason] = useState('');
  const [issuing, setIssuing] = useState(false);

  const groupedRows = useMemo(() => {
    const groups: Array<{ key: string; slices: StockMovement[] }> = [];
    const byGroupId = new Map<string, { key: string; slices: StockMovement[] }>();

    for (const m of movements) {
      if (m.movementGroupId) {
        const existing = byGroupId.get(m.movementGroupId);
        if (existing) {
          existing.slices.push(m);
        } else {
          const entry = { key: m.movementGroupId, slices: [m] };
          byGroupId.set(m.movementGroupId, entry);
          groups.push(entry);
        }
      } else {
        groups.push({ key: m.id, slices: [m] });
      }
    }

    for (const g of groups) {
      if (g.slices.length > 1) {
        g.slices.sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0));
      }
    }
    return groups;
  }, [movements]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const loadMovements = useCallback(
    async (
      currentSkuId: string,
      currentLocId: string,
      currentType: '' | StockMovementType,
      cursor?: string,
    ) => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (currentSkuId) params.set('skuId', currentSkuId);
      if (currentLocId) params.set('locationId', currentLocId);
      if (currentType) params.set('type', currentType);
      if (cursor) params.set('cursor', cursor);

      const res = await apiFetchPaginated<StockMovement>(
        `/api/v1/stock-movements?${params.toString()}`,
      );
      if (cursor) {
        setMovements((prev) => [...prev, ...res.data]);
      } else {
        setMovements(res.data);
      }
      setNextCursor(res.page.nextCursor);
      setHasMore(res.page.hasMore);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetchPaginated<Location>('/api/v1/locations?limit=100'),
      apiFetchPaginated<Sku>('/api/v1/skus?limit=100'),
    ])
      .then(([locRes, skuRes]) => {
        if (!active) return;
        setLocations(locRes.data);
        setSkus(skuRes.data);
      })
      .catch(() => {
        // Non-blocking filter metadata load
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadMovements(skuId, locationId, movementType)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load stock movements');
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
  }, [skuId, locationId, movementType, loadMovements]);

  useLiveRefresh(
    [SSE_TOPICS.STOCK_MOVEMENTS, SSE_TOPICS.LOCATIONS, SSE_TOPICS.CATALOG],
    () => loadMovements(skuId, locationId, movementType),
  );

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadMovements(skuId, locationId, movementType, nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more movements');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (!showIssueForm || !issueLocationId) {
      setIssuePolicy(null);
      return;
    }
    let active = true;
    void apiFetch<EffectiveLotPolicy>(
      `/api/v1/iam/lot-policies/effective?locationId=${encodeURIComponent(issueLocationId)}`,
    )
      .then((res) => {
        if (active) setIssuePolicy(res.data);
      })
      .catch(() => {
        if (active) {
          setIssuePolicy({
            pickingMode: 'AUTO_FEFO',
            allowExpiredLotOverride: false,
            negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [showIssueForm, issueLocationId]);

  useEffect(() => {
    const sku = skus.find((s) => s.id === issueSkuId);
    if (!showIssueForm || !issueLocationId || !issueSkuId || !sku?.trackLots) {
      setIssueLotBalances([]);
      return;
    }
    let active = true;
    const params = new URLSearchParams({ skuId: issueSkuId, locationId: issueLocationId });
    void apiFetch<StockLotBalance[]>(`/api/v1/lot-balances?${params.toString()}`)
      .then((res) => {
        if (active) setIssueLotBalances(res.data);
      })
      .catch(() => {
        if (active) setIssueLotBalances([]);
      });
    return () => {
      active = false;
    };
  }, [showIssueForm, issueLocationId, issueSkuId, skus]);

  async function submitManualIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueLocationId || !issueSkuId) {
      setError('Select a Location and SKU.');
      return;
    }
    const sku = skus.find((s) => s.id === issueSkuId);
    const pickingMode = issuePolicy?.pickingMode ?? 'AUTO_FEFO';
    const isManual =
      sku?.trackLots &&
      (pickingMode === 'MANUAL_REQUIRED' || (pickingMode === 'MANUAL_OPTIONAL' && !issueSkipLots));

    const lotAllocations = isManual
      ? Object.entries(issueLotAllocations)
          .filter(([, q]) => Number(q) > 0)
          .map(([lotId, q]) => ({ lotId, quantity: q.trim() }))
      : undefined;

    setError(null);
    setWarnings([]);
    setIssuing(true);
    try {
      const res = await apiFetch<StockMovement[]>('/api/v1/stock-movements/issues', {
        method: 'POST',
        body: JSON.stringify({
          skuId: issueSkuId,
          locationId: issueLocationId,
          quantity: issueQty.trim(),
          note: issueNote.trim().length > 0 ? issueNote.trim() : null,
          ...(lotAllocations !== undefined ? { lotAllocations } : {}),
          confirmExpiredLotOverride: issueConfirmExpired || undefined,
          overrideReason:
            issueConfirmExpired && issueOverrideReason.trim().length > 0
              ? issueOverrideReason.trim()
              : undefined,
        }),
      });
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      setShowIssueForm(false);
      setIssueLotAllocations({});
      setIssueConfirmExpired(false);
      setIssueOverrideReason('');
      await loadMovements(skuId, locationId, movementType);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to post manual issue');
    } finally {
      setIssuing(false);
    }
  }

  return (
    <AppShell>
      <div className="toolbar">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Stock Movement Ledger</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Immutable, append-only history of every Stock Movement across Locations.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setShowIssueForm((v) => !v);
            setError(null);
            setWarnings([]);
          }}
        >
          {showIssueForm ? 'Close Manual Issue' : 'Manual Issue'}
        </button>
      </div>

      {warnings.length > 0 && (
        <div
          className="card"
          style={{ borderColor: '#d97706', background: '#fffbeb', marginBottom: 16 }}
        >
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 13, color: '#92400e' }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      {showIssueForm && (
        <div className="card" style={{ borderColor: 'var(--primary)', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Manual Outbound Stock Issue</h2>
            {issuePolicy && (
              <span className="badge">
                Picking Mode: {issuePolicy.pickingMode.replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <form onSubmit={submitManualIssue} className="stack">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px', gap: 12 }}>
              <div className="form-group">
                <label htmlFor="issue-location">Location</label>
                <select
                  id="issue-location"
                  value={issueLocationId}
                  onChange={(e) => {
                    setIssueLocationId(e.target.value);
                    setIssueLotAllocations({});
                    setIssueConfirmExpired(false);
                  }}
                >
                  <option value="">Select Location</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="issue-sku">SKU</label>
                <select
                  id="issue-sku"
                  value={issueSkuId}
                  onChange={(e) => {
                    setIssueSkuId(e.target.value);
                    setIssueLotAllocations({});
                    setIssueConfirmExpired(false);
                  }}
                >
                  <option value="">Select SKU</option>
                  {skus.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="issue-qty">Quantity</label>
                <input
                  id="issue-qty"
                  type="text"
                  value={issueQty}
                  onChange={(e) => setIssueQty(e.target.value)}
                />
              </div>
            </div>

            {(() => {
              const sku = skus.find((s) => s.id === issueSkuId);
              const pickingMode = issuePolicy?.pickingMode ?? 'AUTO_FEFO';
              if (
                !sku?.trackLots ||
                (pickingMode !== 'MANUAL_REQUIRED' && pickingMode !== 'MANUAL_OPTIONAL')
              ) {
                return null;
              }
              const today = new Date().toISOString().slice(0, 10);
              const hasExpired = issueLotBalances.some(
                (lot) =>
                  lot.expDate !== null &&
                  lot.expDate < today &&
                  Number(issueLotAllocations[lot.lotId] ?? 0) > 0,
              );
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                  {pickingMode === 'MANUAL_OPTIONAL' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                      <input
                        type="checkbox"
                        checked={issueSkipLots}
                        onChange={(e) => setIssueSkipLots(e.target.checked)}
                      />
                      Skip lot selection (flag EOD reconciliation)
                    </label>
                  )}
                  {!issueSkipLots &&
                    (issueLotBalances.length === 0 ? (
                      <span style={{ color: 'var(--muted)' }}>No lot balances at this location</span>
                    ) : (
                      issueLotBalances.map((lot) => {
                        const isExpired = lot.expDate !== null && lot.expDate < today;
                        return (
                          <div key={lot.lotId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="badge">{lot.lotCode}</span>
                            <span style={{ color: 'var(--muted)' }}>
                              On-hand: {lot.onHand}
                              {lot.expDate ? ` · exp ${lot.expDate}` : ''}
                            </span>
                            {isExpired && (
                              <span
                                className="badge"
                                style={{ background: '#fee2e2', color: '#991b1b' }}
                              >
                                EXPIRED
                              </span>
                            )}
                            <input
                              type="text"
                              placeholder="0.0000"
                              value={issueLotAllocations[lot.lotId] ?? ''}
                              onChange={(e) =>
                                setIssueLotAllocations((prev) => ({
                                  ...prev,
                                  [lot.lotId]: e.target.value,
                                }))
                              }
                              style={{ width: 90 }}
                            />
                          </div>
                        );
                      })
                    ))}
                  {hasExpired && (
                    <div
                      style={{
                        padding: 10,
                        border: '1px solid #d97706',
                        borderRadius: 6,
                        background: '#fffbeb',
                      }}
                    >
                      <strong style={{ color: '#92400e' }}>Expired Stock Lot Selected</strong>
                      {!issuePolicy?.allowExpiredLotOverride ? (
                        <p style={{ margin: '4px 0 0', color: '#991b1b', fontSize: 12 }}>
                          Your policy does not permit issuing expired stock lots.
                        </p>
                      ) : (
                        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={issueConfirmExpired}
                              onChange={(e) => setIssueConfirmExpired(e.target.checked)}
                            />
                            Confirm expired-lot override
                          </label>
                          <input
                            type="text"
                            value={issueOverrideReason}
                            onChange={(e) => setIssueOverrideReason(e.target.value)}
                            placeholder="Override reason (optional)"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="form-group">
              <label htmlFor="issue-note">Note</label>
              <input
                id="issue-note"
                type="text"
                value={issueNote}
                onChange={(e) => setIssueNote(e.target.value)}
                placeholder="Reason / counter reference"
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={issuing}>
                {issuing ? 'Posting...' : 'Post Manual Issue'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setShowIssueForm(false)}
                disabled={issuing}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <select
              aria-label="Filter by SKU"
              value={skuId}
              onChange={(e) => setSkuId(e.target.value)}
              style={{
                padding: '7px 10px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <option value="">All SKUs</option>
              {skus.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>

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

            <select
              aria-label="Filter by Movement Type"
              value={movementType}
              onChange={(e) => setMovementType(e.target.value as '' | StockMovementType)}
              style={{
                padding: '7px 10px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <option value="">All Types</option>
              {MOVEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading stock movements...</p>
        ) : movements.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            No stock movements match the current filters.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Type</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th>Lot</th>
                  <th>Quantity Delta</th>
                  <th>Unit Cost</th>
                  <th>Reason</th>
                  <th>Reference</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((group) => {
                  if (group.slices.length === 1) {
                    const m = group.slices[0]!;
                    return (
                      <tr key={m.id}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                          {new Date(m.createdAt).toLocaleString()}
                        </td>
                        <td>
                          <span className="badge badge-archived">{m.type}</span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{m.skuCode ?? m.skuId}</div>
                          {m.skuName && (
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.skuName}</div>
                          )}
                        </td>
                        <td>{m.locationName ?? m.locationId}</td>
                        <td style={{ fontSize: 12 }}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {m.lotCode ? (
                              <span className="badge">{m.lotCode}</span>
                            ) : (
                              <span style={{ color: 'var(--muted)' }}>—</span>
                            )}
                            {m.eodReconciliationRequired && (
                              <span
                                className="badge"
                                style={{ background: '#fef3c7', color: '#92400e' }}
                              >
                                EOD Reconcile
                              </span>
                            )}
                            {m.expiredLotOverride && (
                              <span
                                className="badge"
                                title={m.overrideReason ?? 'Expired lot override'}
                                style={{ background: '#fee2e2', color: '#991b1b' }}
                              >
                                Expired Override
                              </span>
                            )}
                          </div>
                        </td>
                        <td
                          style={{
                            fontWeight: 600,
                            color: m.quantityDelta.startsWith('-')
                              ? 'var(--danger-text)'
                              : 'inherit',
                          }}
                        >
                          {m.quantityDelta.startsWith('-') ? m.quantityDelta : `+${m.quantityDelta}`}
                        </td>
                        <td>{m.unitCost !== undefined && m.unitCost !== null ? m.unitCost : '—'}</td>
                        <td>{m.reasonCategory ?? '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {m.referenceType ?? '—'}
                        </td>
                        <td style={{ fontSize: 13 }}>{m.note ?? '—'}</td>
                      </tr>
                    );
                  }

                  const first = group.slices[0]!;
                  const isExpanded = Boolean(expandedGroups[group.key]);
                  const totalDelta = group.slices
                    .reduce((acc, s) => acc + Number(s.quantityDelta), 0)
                    .toFixed(4);
                  const isNeg = totalDelta.startsWith('-');

                  return (
                    <Fragment key={group.key}>
                      <tr style={{ background: 'var(--bg-subtle, #f8fafc)' }}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={isExpanded}
                            style={{ padding: '2px 6px', fontSize: 11, marginRight: 6 }}
                          >
                            {isExpanded ? '▼' : '▶'}
                          </button>
                          {new Date(first.createdAt).toLocaleString()}
                        </td>
                        <td>
                          <span className="badge badge-archived">{first.type}</span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{first.skuCode ?? first.skuId}</div>
                          {first.skuName && (
                            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                              {first.skuName}
                            </div>
                          )}
                        </td>
                        <td>{first.locationName ?? first.locationId}</td>
                        <td>
                          <span className="badge badge-active">{group.slices.length} lots</span>
                        </td>
                        <td
                          style={{
                            fontWeight: 600,
                            color: isNeg ? 'var(--danger-text)' : 'inherit',
                          }}
                        >
                          {isNeg ? totalDelta : `+${totalDelta}`}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--muted)' }}>Multi-lot</td>
                        <td>{first.reasonCategory ?? '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                          {first.referenceType ?? '—'}
                        </td>
                        <td style={{ fontSize: 13 }}>{first.note ?? '—'}</td>
                      </tr>
                      {isExpanded &&
                        group.slices.map((slice) => (
                          <tr key={slice.id} style={{ fontSize: 12, background: '#fcfcfd' }}>
                            <td style={{ paddingLeft: 28, color: 'var(--muted)' }}>
                              Slice #{slice.sliceIndex ?? 0}
                            </td>
                            <td colSpan={3} />
                            <td>
                              {slice.lotCode ? (
                                <span className="badge">{slice.lotCode}</span>
                              ) : (
                                <span style={{ color: 'var(--muted)' }}>Unlotted</span>
                              )}
                            </td>
                            <td
                              style={{
                                fontWeight: 600,
                                color: slice.quantityDelta.startsWith('-')
                                  ? 'var(--danger-text)'
                                  : 'inherit',
                              }}
                            >
                              {slice.quantityDelta.startsWith('-')
                                ? slice.quantityDelta
                                : `+${slice.quantityDelta}`}
                            </td>
                            <td>
                              {slice.unitCost !== undefined && slice.unitCost !== null
                                ? slice.unitCost
                                : '—'}
                            </td>
                            <td colSpan={3} style={{ color: 'var(--muted)' }}>
                              {slice.wacUnitCost ? `WAC: ${slice.wacUnitCost}` : ''}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
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
    </AppShell>
  );
}

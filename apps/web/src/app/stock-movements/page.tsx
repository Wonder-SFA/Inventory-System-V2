'use client';

import {
  type Location,
  SSE_TOPICS,
  type Sku,
  type StockMovement,
  type StockMovementType,
} from '@iv2/shared-domain';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { apiFetchPaginated } from '../../lib/api-client';

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

  return (
    <AppShell>
      <div className="toolbar">
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Stock Movement Ledger</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Immutable, append-only history of every Stock Movement across Locations.
          </p>
        </div>
      </div>

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
                  <th>Quantity Delta</th>
                  <th>Unit Cost</th>
                  <th>Reason</th>
                  <th>Reference</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
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
    </AppShell>
  );
}

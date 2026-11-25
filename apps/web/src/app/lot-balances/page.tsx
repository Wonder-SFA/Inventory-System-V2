'use client';

import {
  type ExpiryStatus,
  type ExpiryStatusFilter,
  type Location,
  type LotBalanceItem,
  SSE_TOPICS,
  type Sku,
} from '@iv2/shared-domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { apiFetchPaginated } from '../../lib/api-client';

function ExpiryStatusBadge({ status }: { status: ExpiryStatus }) {
  if (status === 'EXPIRED') {
    return (
      <span
        className="badge"
        style={{
          background: '#fee2e2',
          color: '#991b1b',
          border: '1px solid #fecaca',
        }}
      >
        Expired
      </span>
    );
  }
  if (status === 'EXPIRING_SOON') {
    return (
      <span
        className="badge"
        style={{
          background: 'var(--warn-bg)',
          color: 'var(--warn-text)',
          border: '1px solid var(--warn-border)',
        }}
      >
        Expiring Soon
      </span>
    );
  }
  if (status === 'ACTIVE') {
    return <span className="badge badge-active">Active</span>;
  }
  return <span className="badge badge-archived">No Expiry</span>;
}

export default function LotBalancesPage() {
  const [items, setItems] = useState<LotBalanceItem[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [locationId, setLocationId] = useState<string>('');
  const [skuId, setSkuId] = useState<string>('');
  const [expiryStatus, setExpiryStatus] = useState<ExpiryStatusFilter | ''>('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLotBalances = useCallback(
    async (
      currentLocId: string,
      currentSkuId: string,
      currentExpiryStatus: ExpiryStatusFilter | '',
      cursor?: string,
    ) => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (currentLocId) params.set('locationId', currentLocId);
      if (currentSkuId) params.set('skuId', currentSkuId);
      if (currentExpiryStatus) params.set('expiryStatus', currentExpiryStatus);
      if (cursor) params.set('cursor', cursor);

      const res = await apiFetchPaginated<LotBalanceItem>(
        `/api/v1/lot-balances?${params.toString()}`,
      );
      if (cursor) {
        setItems((prev) => [...prev, ...res.data]);
      } else {
        setItems(res.data);
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
        setSkus(skuRes.data.filter((s) => s.trackLots));
      })
      .catch(() => {
        // Handled when lot balances load
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadLotBalances(locationId, skuId, expiryStatus)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load lot balances');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [locationId, skuId, expiryStatus, loadLotBalances]);

  useLiveRefresh(
    [SSE_TOPICS.STOCK_BALANCES, SSE_TOPICS.LOCATIONS, SSE_TOPICS.CATALOG],
    () => loadLotBalances(locationId, skuId, expiryStatus),
  );

  const summary = useMemo(() => {
    let expiringSoonCount = 0;
    let expiredCount = 0;
    for (const row of items) {
      if (row.expiryStatus === 'EXPIRING_SOON') expiringSoonCount += 1;
      if (row.expiryStatus === 'EXPIRED') expiredCount += 1;
    }
    return {
      totalCount: items.length,
      expiringSoonCount,
      expiredCount,
    };
  }, [items]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await loadLotBalances(locationId, skuId, expiryStatus, nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more lot balances');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div className="page-header">
        <div>
          <h1 className="page-title">Lot Balances & Expiry</h1>
          <p className="page-subtitle">
            Batch-level On-Hand Stock, manufacturing and expiry dates, and FIFO unit costs
          </p>
        </div>
      </div>

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
            DISPLAYED LOT BALANCES
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{summary.totalCount}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
            EXPIRING SOON (30 DAYS)
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginTop: 4,
              color: summary.expiringSoonCount > 0 ? 'var(--warn-text)' : 'inherit',
            }}
          >
            {summary.expiringSoonCount}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>EXPIRED LOTS</div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginTop: 4,
              color: summary.expiredCount > 0 ? '#991b1b' : 'inherit',
            }}
          >
            {summary.expiredCount}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
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
              <option value="">All Lot-Tracked SKUs</option>
              {skus.map((sku) => (
                <option key={sku.id} value={sku.id}>
                  {sku.code} — {sku.name}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by Expiry Status"
              value={expiryStatus}
              onChange={(e) => setExpiryStatus(e.target.value as ExpiryStatusFilter | '')}
              style={{
                padding: '7px 10px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <option value="">All Expiry Statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="EXPIRING_SOON">Expiring Soon</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading lot balances...</p>
        ) : items.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            No lot balances match the current filters.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Lot Code</th>
                  <th>SKU</th>
                  <th>Location</th>
                  <th>Mfg Date</th>
                  <th>Expiry Date</th>
                  <th>Status</th>
                  <th>On-Hand</th>
                  <th>In-Transit</th>
                  <th>Unit Cost (FIFO)</th>
                  <th>Total Value</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={`${row.lotId}:${row.locationId}`}>
                    <td style={{ fontWeight: 600 }}>{row.lotCode}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.skuCode}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{row.skuName}</div>
                    </td>
                    <td>{row.locationName}</td>
                    <td>{row.mfgDate ?? '—'}</td>
                    <td>{row.expDate ?? 'No Expiry'}</td>
                    <td>
                      <ExpiryStatusBadge status={row.expiryStatus} />
                    </td>
                    <td>{row.onHand}</td>
                    <td>{row.inTransit}</td>
                    <td>{row.unitCost !== undefined ? row.unitCost : '—'}</td>
                    <td>{row.totalValue !== undefined ? row.totalValue : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
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

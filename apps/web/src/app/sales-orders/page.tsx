'use client';

import {
  type Customer,
  type FefoAllocationSlice,
  type Location,
  type PlanFefoAllocationResult,
  type ReturnSalesOrderResult,
  SSE_TOPICS,
  type SalesOrder,
  type SalesOrderStatus,
  type ShipSalesOrderResult,
  type Sku,
} from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | SalesOrderStatus;

interface DraftLineState {
  skuId: string;
  orderedQty: string;
  unitPrice: string;
  currency: string;
}

interface ShipLineState {
  orderLineId: string;
  skuId: string;
  skuLabel: string;
  orderedQty: string;
  fulfilledQty: string;
  quantity: string;
}

interface ReturnLineState {
  orderLineId: string;
  skuLabel: string;
  fulfilledQty: string;
  returnedQty: string;
  quantity: string;
}

const STATUS_FILTERS: readonly StatusFilter[] = [
  'ALL',
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
];

export default function SalesOrdersPage() {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create / Edit Draft state
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [orderNumber, setOrderNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLineState[]>([
    { skuId: '', orderedQty: '1.0000', unitPrice: '0.0000', currency: 'USD' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  // Ship state
  const [shippingOrder, setShippingOrder] = useState<SalesOrder | null>(null);
  const [shipNote, setShipNote] = useState('');
  const [shipLines, setShipLines] = useState<ShipLineState[]>([]);
  const [fefoPreviews, setFefoPreviews] = useState<Record<string, FefoAllocationSlice[]>>({});
  const [lastAllocatedSummary, setLastAllocatedSummary] = useState<string | null>(null);
  const [shipping, setShipping] = useState(false);

  // Return state
  const [returningOrder, setReturningOrder] = useState<SalesOrder | null>(null);
  const [returnNote, setReturnNote] = useState('');
  const [returnLines, setReturnLines] = useState<ReturnLineState[]>([]);
  const [returning, setReturning] = useState(false);

  const loadReferenceData = useCallback(async () => {
    const [custRes, locRes, skuRes] = await Promise.all([
      apiFetchPaginated<Customer>('/api/v1/customers?status=ACTIVE&limit=100'),
      apiFetchPaginated<Location>('/api/v1/locations?status=ACTIVE&limit=100'),
      apiFetchPaginated<Sku>('/api/v1/skus?status=ACTIVE&limit=100'),
    ]);
    setCustomers(custRes.data);
    setLocations(locRes.data);
    setSkus(skuRes.data);
  }, []);

  const loadOrders = useCallback(async (filter: StatusFilter, cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (filter !== 'ALL') {
      params.set('status', filter);
    }
    if (cursor) {
      params.set('cursor', cursor);
    }

    const res = await apiFetchPaginated<SalesOrder>(`/api/v1/sales-orders?${params.toString()}`);
    if (cursor) {
      setOrders((prev) => [...prev, ...res.data]);
    } else {
      setOrders(res.data);
    }
    setNextCursor(res.page.nextCursor);
    setHasMore(res.page.hasMore);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([loadReferenceData(), loadOrders(statusFilter)])
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load sales orders');
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
  }, [statusFilter, loadReferenceData, loadOrders]);

  useLiveRefresh([SSE_TOPICS.SALES_ORDERS, 'orders'], () =>
    Promise.all([loadReferenceData(), loadOrders(statusFilter)]).then(() => undefined),
  );

  function resetDraftForm() {
    setEditingOrder(null);
    setOrderNumber('');
    setCustomerId('');
    setLocationId('');
    setNote('');
    setDraftLines([{ skuId: '', orderedQty: '1.0000', unitPrice: '0.0000', currency: 'USD' }]);
  }

  function startEditDraft(so: SalesOrder) {
    setEditingOrder(so);
    setOrderNumber(so.orderNumber);
    setCustomerId(so.customerId);
    setLocationId(so.locationId);
    setNote(so.note ?? '');
    setDraftLines(
      so.lines.map((line) => ({
        skuId: line.skuId,
        orderedQty: line.orderedQty,
        unitPrice: line.unitPrice,
        currency: line.currency,
      })),
    );
    setError(null);
  }

  function addDraftLine() {
    setDraftLines((prev) => [
      ...prev,
      { skuId: '', orderedQty: '1.0000', unitPrice: '0.0000', currency: 'USD' },
    ]);
  }

  function removeDraftLine(index: number) {
    setDraftLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function updateDraftLine(index: number, patch: Partial<DraftLineState>) {
    setDraftLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function handleSaveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setWarnings([]);
    setSubmitting(true);

    try {
      if (editingOrder) {
        await apiFetch<SalesOrder>(`/api/v1/sales-orders/${editingOrder.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            expectedVersion: editingOrder.version,
            customerId,
            locationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: draftLines,
          }),
        });
      } else {
        await apiFetch<SalesOrder>('/api/v1/sales-orders', {
          method: 'POST',
          body: JSON.stringify({
            ...(orderNumber.trim().length > 0 ? { orderNumber: orderNumber.trim() } : {}),
            customerId,
            locationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: draftLines,
          }),
        });
      }

      resetDraftForm();
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save Sales Order');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(so: SalesOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(so.id);
    try {
      const res = await apiFetch<SalesOrder>(`/api/v1/sales-orders/${so.id}/confirm`, {
        method: 'POST',
      });
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to confirm Sales Order');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeliver(so: SalesOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(so.id);
    try {
      await apiFetch<SalesOrder>(`/api/v1/sales-orders/${so.id}/deliver`, {
        method: 'POST',
      });
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to mark Delivered');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(so: SalesOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(so.id);
    try {
      await apiFetch<SalesOrder>(`/api/v1/sales-orders/${so.id}/cancel`, {
        method: 'POST',
      });
      if (editingOrder?.id === so.id) {
        resetDraftForm();
      }
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to cancel Sales Order');
    } finally {
      setBusyId(null);
    }
  }

  const loadFefoPreviewForLine = useCallback(
    async (orderLineId: string, skuId: string, locId: string, quantity: string) => {
      const sku = skus.find((s) => s.id === skuId);
      if (!sku?.trackLots || Number(quantity) <= 0) {
        setFefoPreviews((prev) => ({ ...prev, [orderLineId]: [] }));
        return;
      }
      try {
        const params = new URLSearchParams({
          skuId,
          locationId: locId,
          quantity: quantity.trim(),
        });
        const res = await apiFetch<PlanFefoAllocationResult>(
          `/api/v1/stock-lots/fefo-preview?${params.toString()}`,
        );
        setFefoPreviews((prev) => ({ ...prev, [orderLineId]: res.data.slices }));
      } catch {
        setFefoPreviews((prev) => ({ ...prev, [orderLineId]: [] }));
      }
    },
    [skus],
  );

  function openShipModal(so: SalesOrder) {
    setReturningOrder(null);
    setShippingOrder(so);
    setShipNote('');
    setLastAllocatedSummary(null);
    const initialLines = so.lines.map((line) => {
      const remaining = Math.max(0, Number(line.orderedQty) - Number(line.fulfilledQty));
      return {
        orderLineId: line.id,
        skuId: line.skuId,
        skuLabel: line.skuCode ? `${line.skuCode} — ${line.skuName ?? ''}` : line.skuId,
        orderedQty: line.orderedQty,
        fulfilledQty: line.fulfilledQty,
        quantity: remaining > 0 ? remaining.toFixed(4) : '0.0000',
      };
    });
    setShipLines(initialLines);
    setFefoPreviews({});
    for (const line of initialLines) {
      void loadFefoPreviewForLine(line.orderLineId, line.skuId, so.locationId, line.quantity);
    }
    setError(null);
    setWarnings([]);
  }

  async function submitShipment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shippingOrder) return;

    const activeLines = shipLines
      .filter((l) => Number(l.quantity) > 0)
      .map((l) => ({
        orderLineId: l.orderLineId,
        quantity: l.quantity.trim(),
      }));

    if (activeLines.length === 0) {
      setError('Enter a positive ship quantity on at least one line.');
      return;
    }

    setError(null);
    setShipping(true);
    try {
      const res = await apiFetch<ShipSalesOrderResult>(
        `/api/v1/sales-orders/${shippingOrder.id}/shipments`,
        {
          method: 'POST',
          body: JSON.stringify({
            note: shipNote.trim().length > 0 ? shipNote.trim() : null,
            lines: activeLines,
          }),
        },
      );
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      const lotSlices = res.data.movements.filter((m) => m.lotCode || m.movementGroupId);
      if (lotSlices.length > 0) {
        setLastAllocatedSummary(
          lotSlices
            .map((m) => `${m.lotCode ?? 'Unlotted'} (${m.quantityDelta})`)
            .join(', '),
        );
      }
      setShippingOrder(null);
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to ship Sales Order');
    } finally {
      setShipping(false);
    }
  }

  function openReturnModal(so: SalesOrder) {
    setShippingOrder(null);
    setReturningOrder(so);
    setReturnNote('');
    setReturnLines(
      so.lines.map((line) => {
        const returnable = Math.max(0, Number(line.fulfilledQty) - Number(line.returnedQty));
        return {
          orderLineId: line.id,
          skuLabel: line.skuCode ? `${line.skuCode} — ${line.skuName ?? ''}` : line.skuId,
          fulfilledQty: line.fulfilledQty,
          returnedQty: line.returnedQty,
          quantity: returnable > 0 ? returnable.toFixed(4) : '0.0000',
        };
      }),
    );
    setError(null);
    setWarnings([]);
  }

  async function submitReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!returningOrder) return;

    const activeLines = returnLines
      .filter((l) => Number(l.quantity) > 0)
      .map((l) => ({
        orderLineId: l.orderLineId,
        quantity: l.quantity.trim(),
      }));

    if (activeLines.length === 0) {
      setError('Enter a positive return quantity on at least one line.');
      return;
    }

    setError(null);
    setReturning(true);
    try {
      const res = await apiFetch<ReturnSalesOrderResult>(
        `/api/v1/sales-orders/${returningOrder.id}/returns`,
        {
          method: 'POST',
          body: JSON.stringify({
            note: returnNote.trim().length > 0 ? returnNote.trim() : null,
            lines: activeLines,
          }),
        },
      );
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      setReturningOrder(null);
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to record return');
    } finally {
      setReturning(false);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadOrders(statusFilter, nextCursor);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load more sales orders');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div className="stack">
        <div className="page-header">
          <div>
            <h1>Sales Orders</h1>
            <p className="subtitle">
              Reserve stock, ship partial or full orders, mark delivered, and process customer
              returns.
            </p>
          </div>
        </div>

        {error && (
          <div className="alert-error" role="alert">
            {error}
          </div>
        )}

        {warnings.length > 0 && (
          <div
            role="status"
            style={{
              background: '#fffbeb',
              border: '1px solid #f59e0b',
              color: '#92400e',
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <strong>Reservation / Stock Warnings:</strong>
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              {warnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {lastAllocatedSummary && (
          <div
            role="status"
            style={{
              background: '#ecfdf5',
              border: '1px solid #10b981',
              color: '#065f46',
              padding: '10px 14px',
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            <strong>Dispatched Lot Allocations:</strong> {lastAllocatedSummary}
          </div>
        )}

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            {editingOrder
              ? `Edit Draft ${editingOrder.orderNumber} (v${editingOrder.version})`
              : 'New Draft Sales Order'}
          </h2>
          <form onSubmit={handleSaveDraft} className="stack">
            <div className="form-row">
              {!editingOrder && (
                <div className="form-group">
                  <label htmlFor="so-number">Order Number (optional)</label>
                  <input
                    id="so-number"
                    type="text"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    placeholder="Auto-generated if blank"
                  />
                </div>
              )}
              <div className="form-group">
                <label htmlFor="so-customer">Customer</label>
                <select
                  id="so-customer"
                  required
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">Select Customer...</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="so-location">Fulfillment Location</label>
                <select
                  id="so-location"
                  required
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  <option value="">Select Location...</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="so-note">Note</label>
                <input
                  id="so-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional delivery note"
                />
              </div>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>Line Items</strong>
                <button type="button" className="btn" onClick={addDraftLine}>
                  + Add Line
                </button>
              </div>
              {draftLines.map((line, idx) => (
                <div key={idx} className="form-row" style={{ alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ flex: 2 }}>
                    <label>SKU</label>
                    <select
                      required
                      value={line.skuId}
                      onChange={(e) => updateDraftLine(idx, { skuId: e.target.value })}
                    >
                      <option value="">Select SKU...</option>
                      {skus.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} — {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Ordered Qty</label>
                    <input
                      type="text"
                      required
                      value={line.orderedQty}
                      onChange={(e) => updateDraftLine(idx, { orderedQty: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label>Unit Price</label>
                    <input
                      type="text"
                      required
                      value={line.unitPrice}
                      onChange={(e) => updateDraftLine(idx, { unitPrice: e.target.value })}
                    />
                  </div>
                  <div className="form-group" style={{ maxWidth: 90 }}>
                    <label>Currency</label>
                    <input
                      type="text"
                      required
                      maxLength={3}
                      value={line.currency}
                      onChange={(e) =>
                        updateDraftLine(idx, { currency: e.target.value.toUpperCase() })
                      }
                    />
                  </div>
                  {draftLines.length > 1 && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => removeDraftLine(idx)}
                      style={{ marginBottom: 2 }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? 'Saving...'
                  : editingOrder
                    ? 'Save Draft Changes'
                    : 'Create Draft Sales Order'}
              </button>
              {editingOrder && (
                <button type="button" className="btn" onClick={resetDraftForm} disabled={submitting}>
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>

        {shippingOrder && (
          <div className="card" style={{ borderColor: 'var(--primary)' }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>
              Ship Items — {shippingOrder.orderNumber}
            </h2>
            <form onSubmit={submitShipment} className="stack">
              <div className="form-group">
                <label htmlFor="ship-note">Shipment Note</label>
                <input
                  id="ship-note"
                  type="text"
                  value={shipNote}
                  onChange={(e) => setShipNote(e.target.value)}
                  placeholder="Carrier / tracking reference"
                />
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Ordered</th>
                    <th>Fulfilled</th>
                    <th>Ship Qty</th>
                    <th>FEFO Lot Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {shipLines.map((line, idx) => {
                    const previewSlices = fefoPreviews[line.orderLineId] ?? [];
                    return (
                      <tr key={line.orderLineId}>
                        <td>{line.skuLabel}</td>
                        <td>{line.orderedQty}</td>
                        <td>{line.fulfilledQty}</td>
                        <td>
                          <input
                            type="text"
                            value={line.quantity}
                            onChange={(e) => {
                              const nextQty = e.target.value;
                              setShipLines((prev) =>
                                prev.map((l, i) =>
                                  i === idx ? { ...l, quantity: nextQty } : l,
                                ),
                              );
                              if (shippingOrder) {
                                void loadFefoPreviewForLine(
                                  line.orderLineId,
                                  line.skuId,
                                  shippingOrder.locationId,
                                  nextQty,
                                );
                              }
                            }}
                          />
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {previewSlices.length === 0 ? (
                            <span style={{ color: 'var(--muted)' }}>—</span>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {previewSlices.map((s, sIdx) => (
                                <div key={sIdx}>
                                  <span className="badge">
                                    {s.lotCode ?? (s.negativeStockWarning ? 'Shortfall' : 'Unlotted')}
                                  </span>{' '}
                                  × {s.quantity}
                                  {s.expDate ? ` (exp ${s.expDate})` : ''}
                                  {s.negativeStockWarning ? ' ⚠ Negative stock' : ''}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={shipping}>
                  {shipping ? 'Shipping...' : 'Confirm Shipment'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShippingOrder(null)}
                  disabled={shipping}
                >
                  Close
                </button>
              </div>
            </form>
          </div>
        )}

        {returningOrder && (
          <div className="card" style={{ borderColor: '#d97706' }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>
              Customer Return — {returningOrder.orderNumber}
            </h2>
            <form onSubmit={submitReturn} className="stack">
              <div className="form-group">
                <label htmlFor="return-note">Return Note</label>
                <input
                  id="return-note"
                  type="text"
                  value={returnNote}
                  onChange={(e) => setReturnNote(e.target.value)}
                  placeholder="Reason for return / rejected delivery"
                />
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Fulfilled</th>
                    <th>Already Returned</th>
                    <th>Return Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {returnLines.map((line, idx) => (
                    <tr key={line.orderLineId}>
                      <td>{line.skuLabel}</td>
                      <td>{line.fulfilledQty}</td>
                      <td>{line.returnedQty}</td>
                      <td>
                        <input
                          type="text"
                          value={line.quantity}
                          onChange={(e) =>
                            setReturnLines((prev) =>
                              prev.map((l, i) =>
                                i === idx ? { ...l, quantity: e.target.value } : l,
                              ),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={returning}>
                  {returning ? 'Recording Return...' : 'Record Customer Return'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setReturningOrder(null)}
                  disabled={returning}
                >
                  Close
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="card">
          <div className="tabs" role="tablist" aria-label="Sales order status filter">
            {STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                role="tab"
                aria-selected={statusFilter === status}
                className={`tab-btn${statusFilter === status ? ' active' : ''}`}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'ALL' ? 'All' : status.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          {loading ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading sales orders...</p>
          ) : orders.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No sales orders found.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Lines</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((so) => {
                  const canEdit = so.status === 'DRAFT';
                  const canConfirm = so.status === 'DRAFT';
                  const canShip = so.status === 'CONFIRMED' || so.status === 'PARTIALLY_SHIPPED';
                  const canDeliver = so.status === 'SHIPPED';
                  const canReturn =
                    so.status === 'PARTIALLY_SHIPPED' ||
                    so.status === 'SHIPPED' ||
                    so.status === 'DELIVERED';
                  const canCancel =
                    so.status === 'DRAFT' ||
                    so.status === 'CONFIRMED' ||
                    so.status === 'PARTIALLY_SHIPPED';

                  return (
                    <tr key={so.id}>
                      <td>
                        <strong>{so.orderNumber}</strong>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>v{so.version}</div>
                      </td>
                      <td>{so.customerName ?? so.customerId}</td>
                      <td>{so.locationName ?? so.locationId}</td>
                      <td>
                        <span
                          className={`badge ${
                            so.status === 'CANCELLED'
                              ? 'badge-archived'
                              : so.status === 'DELIVERED' || so.status === 'SHIPPED'
                                ? 'badge-active'
                                : ''
                          }`}
                        >
                          {so.status}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontSize: 12 }}>
                          {so.lines.map((line) => (
                            <div key={line.id}>
                              {line.skuCode ?? line.skuId}: {line.fulfilledQty}/{line.orderedQty}
                              {Number(line.returnedQty) > 0
                                ? ` (returned ${line.returnedQty})`
                                : ''}{' '}
                              @ {line.unitPrice} {line.currency}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {canEdit && (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => startEditDraft(so)}
                              disabled={busyId === so.id}
                            >
                              Edit
                            </button>
                          )}
                          {canConfirm && (
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => handleConfirm(so)}
                              disabled={busyId === so.id}
                            >
                              Confirm
                            </button>
                          )}
                          {canShip && (
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => openShipModal(so)}
                              disabled={busyId === so.id}
                            >
                              Ship
                            </button>
                          )}
                          {canDeliver && (
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => handleDeliver(so)}
                              disabled={busyId === so.id}
                            >
                              Mark Delivered
                            </button>
                          )}
                          {canReturn && (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => openReturnModal(so)}
                              disabled={busyId === so.id}
                            >
                              Return
                            </button>
                          )}
                          {canCancel && (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => handleCancel(so)}
                              disabled={busyId === so.id}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {hasMore && (
            <div style={{ marginTop: 14 }}>
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
      </div>
    </AppShell>
  );
}

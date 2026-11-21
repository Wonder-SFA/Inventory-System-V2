'use client';

import type {
  Location,
  PurchaseOrder,
  PurchaseOrderStatus,
  ReceivePurchaseOrderResult,
  Sku,
  Supplier,
} from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | PurchaseOrderStatus;

interface DraftLineState {
  skuId: string;
  orderedQty: string;
  unitCost: string;
  currency: string;
}

interface ReceiveLineState {
  orderLineId: string;
  skuLabel: string;
  orderedQty: string;
  fulfilledQty: string;
  quantity: string;
  unitCost: string;
  currency: string;
}

const STATUS_FILTERS: readonly StatusFilter[] = [
  'ALL',
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
];

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
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
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [orderNumber, setOrderNumber] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLineState[]>([
    { skuId: '', orderedQty: '1.0000', unitCost: '0.0000', currency: 'USD' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  // Receive state
  const [receivingOrder, setReceivingOrder] = useState<PurchaseOrder | null>(null);
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveLines, setReceiveLines] = useState<ReceiveLineState[]>([]);
  const [receiving, setReceiving] = useState(false);
  const [overReceiveModalOpen, setOverReceiveModalOpen] = useState(false);
  const [overReceiveMessage, setOverReceiveMessage] = useState('');

  const loadReferenceData = useCallback(async () => {
    const [supRes, locRes, skuRes] = await Promise.all([
      apiFetchPaginated<Supplier>('/api/v1/suppliers?status=ACTIVE&limit=100'),
      apiFetchPaginated<Location>('/api/v1/locations?status=ACTIVE&limit=100'),
      apiFetchPaginated<Sku>('/api/v1/skus?status=ACTIVE&limit=100'),
    ]);
    setSuppliers(supRes.data);
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

    const res = await apiFetchPaginated<PurchaseOrder>(
      `/api/v1/purchase-orders?${params.toString()}`,
    );
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
          setError(err instanceof Error ? err.message : 'Failed to load purchase orders');
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

  function resetDraftForm() {
    setEditingOrder(null);
    setOrderNumber('');
    setSupplierId('');
    setLocationId('');
    setNote('');
    setDraftLines([{ skuId: '', orderedQty: '1.0000', unitCost: '0.0000', currency: 'USD' }]);
  }

  function startEditDraft(po: PurchaseOrder) {
    setEditingOrder(po);
    setOrderNumber(po.orderNumber);
    setSupplierId(po.supplierId);
    setLocationId(po.locationId);
    setNote(po.note ?? '');
    setDraftLines(
      po.lines.map((line) => ({
        skuId: line.skuId,
        orderedQty: line.orderedQty,
        unitCost: line.unitCost ?? '0.0000',
        currency: line.currency,
      })),
    );
    setError(null);
  }

  function updateDraftLine(index: number, patch: Partial<DraftLineState>) {
    setDraftLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  function addDraftLine() {
    setDraftLines((prev) => [
      ...prev,
      { skuId: '', orderedQty: '1.0000', unitCost: '0.0000', currency: 'USD' },
    ]);
  }

  function removeDraftLine(index: number) {
    setDraftLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSaveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setWarnings([]);
    setSubmitting(true);

    try {
      const normalizedLines = draftLines.map((line) => ({
        skuId: line.skuId,
        orderedQty: line.orderedQty.trim(),
        unitCost: line.unitCost.trim(),
        currency: line.currency.trim().toUpperCase() || 'USD',
      }));

      if (editingOrder) {
        await apiFetch<PurchaseOrder>(`/api/v1/purchase-orders/${editingOrder.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            expectedVersion: editingOrder.version,
            supplierId,
            locationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: normalizedLines,
          }),
        });
      } else {
        await apiFetch<PurchaseOrder>('/api/v1/purchase-orders', {
          method: 'POST',
          body: JSON.stringify({
            ...(orderNumber.trim().length > 0 ? { orderNumber: orderNumber.trim() } : {}),
            supplierId,
            locationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: normalizedLines,
          }),
        });
      }

      resetDraftForm();
      await loadOrders(statusFilter);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'STALE_VERSION') {
        setError(
          'This Draft was modified on another PC (stale version). Please reload and re-apply your edits.',
        );
      } else {
        setError(err instanceof ApiClientError ? err.message : 'Failed to save purchase order');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(po: PurchaseOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(po.id);
    try {
      await apiFetch<PurchaseOrder>(`/api/v1/purchase-orders/${po.id}/confirm`, {
        method: 'POST',
      });
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to confirm purchase order');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(po: PurchaseOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(po.id);
    try {
      await apiFetch<PurchaseOrder>(`/api/v1/purchase-orders/${po.id}/cancel`, {
        method: 'POST',
      });
      if (receivingOrder?.id === po.id) {
        setReceivingOrder(null);
      }
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to cancel purchase order');
    } finally {
      setBusyId(null);
    }
  }

  function openReceivePanel(po: PurchaseOrder) {
    setReceivingOrder(po);
    setReceiveNote('');
    setReceiveLines(
      po.lines.map((line) => {
        const remaining = Math.max(0, Number(line.orderedQty) - Number(line.fulfilledQty));
        return {
          orderLineId: line.id,
          skuLabel: line.skuCode ? `${line.skuCode} — ${line.skuName ?? ''}` : line.skuId,
          orderedQty: line.orderedQty,
          fulfilledQty: line.fulfilledQty,
          quantity: remaining > 0 ? remaining.toFixed(4) : '0.0000',
          unitCost: line.unitCost ?? '0.0000',
          currency: line.currency,
        };
      }),
    );
    setError(null);
    setWarnings([]);
  }

  function updateReceiveLine(index: number, patch: Partial<ReceiveLineState>) {
    setReceiveLines((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  async function submitReceipt(allowOverReceive: boolean) {
    if (!receivingOrder) {
      return;
    }
    setError(null);
    setWarnings([]);
    setReceiving(true);

    try {
      const linesToPost = receiveLines
        .filter((l) => Number(l.quantity) > 0)
        .map((l) => ({
          orderLineId: l.orderLineId,
          quantity: l.quantity.trim(),
          unitCost: l.unitCost.trim(),
          currency: l.currency.trim().toUpperCase() || 'USD',
        }));

      const res = await apiFetch<ReceivePurchaseOrderResult>(
        `/api/v1/purchase-orders/${receivingOrder.id}/receipts`,
        {
          method: 'POST',
          body: JSON.stringify({
            allowOverReceive,
            note: receiveNote.trim().length > 0 ? receiveNote.trim() : null,
            lines: linesToPost,
          }),
        },
      );

      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => `${w.code}: ${w.message}`));
      }

      setOverReceiveModalOpen(false);
      setReceivingOrder(null);
      await loadOrders(statusFilter);
    } catch (err) {
      if (
        err instanceof ApiClientError &&
        err.code === 'OVER_RECEIVE_CONFIRMATION_REQUIRED'
      ) {
        setOverReceiveMessage(err.message);
        setOverReceiveModalOpen(true);
      } else {
        setOverReceiveModalOpen(false);
        setError(err instanceof ApiClientError ? err.message : 'Failed to post receipt');
      }
    } finally {
      setReceiving(false);
    }
  }

  async function handleReceiveSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitReceipt(false);
  }

  async function handleLoadMore() {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      await loadOrders(statusFilter, nextCursor);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Failed to load more purchase orders',
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="card">
          <div style={{ marginBottom: 16 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>
              {editingOrder
                ? `Edit Draft Purchase Order (${editingOrder.orderNumber}, v${editingOrder.version})`
                : 'Purchase Orders'}
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' }}>
              Create Draft Purchase Orders, confirm with Suppliers, and receive Stock Movements
              into Locations.
            </p>
          </div>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="access-banner read-only" role="status" style={{ marginBottom: 14 }}>
              {warnings.join(' | ')}
            </div>
          )}

          <form onSubmit={handleSaveDraft}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 12,
              }}
            >
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="po-supplier">Supplier</label>
                <select
                  id="po-supplier"
                  required
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                >
                  <option value="">Select Supplier...</option>
                  {suppliers.map((sup) => (
                    <option key={sup.id} value={sup.id}>
                      {sup.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="po-location">Destination Location</label>
                <select
                  id="po-location"
                  required
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  <option value="">Select Location...</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>

              {!editingOrder && (
                <div className="form-field" style={{ marginBottom: 0 }}>
                  <label htmlFor="po-number">Order Number (Optional)</label>
                  <input
                    id="po-number"
                    type="text"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    placeholder="Auto-generated if blank"
                  />
                </div>
              )}

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="po-note">Note</label>
                <input
                  id="po-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional reference note"
                />
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 13 }}>Line Items</strong>
                <button type="button" className="btn" onClick={addDraftLine}>
                  + Add Line
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {draftLines.map((line, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '2fr 1fr 1fr 100px auto',
                      gap: 8,
                      alignItems: 'end',
                    }}
                  >
                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label htmlFor={`line-sku-${index}`}>SKU</label>
                      <select
                        id={`line-sku-${index}`}
                        required
                        value={line.skuId}
                        onChange={(e) => updateDraftLine(index, { skuId: e.target.value })}
                      >
                        <option value="">Select SKU...</option>
                        {skus.map((sku) => (
                          <option key={sku.id} value={sku.id}>
                            {sku.code} — {sku.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label htmlFor={`line-qty-${index}`}>Ordered Qty</label>
                      <input
                        id={`line-qty-${index}`}
                        type="text"
                        required
                        value={line.orderedQty}
                        onChange={(e) => updateDraftLine(index, { orderedQty: e.target.value })}
                      />
                    </div>

                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label htmlFor={`line-cost-${index}`}>Unit Cost</label>
                      <input
                        id={`line-cost-${index}`}
                        type="text"
                        required
                        value={line.unitCost}
                        onChange={(e) => updateDraftLine(index, { unitCost: e.target.value })}
                      />
                    </div>

                    <div className="form-field" style={{ marginBottom: 0 }}>
                      <label htmlFor={`line-currency-${index}`}>Currency</label>
                      <input
                        id={`line-currency-${index}`}
                        type="text"
                        maxLength={3}
                        required
                        value={line.currency}
                        onChange={(e) => updateDraftLine(index, { currency: e.target.value })}
                      />
                    </div>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => removeDraftLine(index)}
                      disabled={draftLines.length <= 1}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? 'Saving...'
                  : editingOrder
                    ? 'Save Draft Changes'
                    : 'Create Draft Purchase Order'}
              </button>
              {editingOrder && (
                <button type="button" className="btn" onClick={resetDraftForm} disabled={submitting}>
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>

        {receivingOrder && (
          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  Receive Purchase Order {receivingOrder.orderNumber}
                </h2>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
                  Destination: {receivingOrder.locationName ?? receivingOrder.locationId}
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setReceivingOrder(null)}>
                Close
              </button>
            </div>

            <form onSubmit={handleReceiveSubmit}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Ordered</th>
                    <th>Already Received</th>
                    <th>Receive Qty</th>
                    <th>Unit Cost</th>
                    <th>Currency</th>
                  </tr>
                </thead>
                <tbody>
                  {receiveLines.map((line, index) => (
                    <tr key={line.orderLineId}>
                      <td>{line.skuLabel}</td>
                      <td>{line.orderedQty}</td>
                      <td>{line.fulfilledQty}</td>
                      <td>
                        <input
                          type="text"
                          value={line.quantity}
                          onChange={(e) =>
                            updateReceiveLine(index, { quantity: e.target.value })
                          }
                          style={{ width: 110, padding: '6px 8px' }}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={line.unitCost}
                          onChange={(e) =>
                            updateReceiveLine(index, { unitCost: e.target.value })
                          }
                          style={{ width: 110, padding: '6px 8px' }}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          maxLength={3}
                          value={line.currency}
                          onChange={(e) =>
                            updateReceiveLine(index, { currency: e.target.value })
                          }
                          style={{ width: 70, padding: '6px 8px' }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'end',
                  marginTop: 12,
                }}
              >
                <div className="form-field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="receive-note">Receipt Note</label>
                  <input
                    id="receive-note"
                    type="text"
                    value={receiveNote}
                    onChange={(e) => setReceiveNote(e.target.value)}
                    placeholder="Delivery docket or pallet note"
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={receiving}>
                  {receiving ? 'Posting Receipt...' : 'Post Receipt'}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="card">
          <div className="tabs" role="tablist" aria-label="Purchase order status filter">
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
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading purchase orders...</p>
          ) : orders.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No purchase orders found.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Supplier</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Lines</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((po) => (
                  <tr key={po.id}>
                    <td>
                      <strong>{po.orderNumber}</strong>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>v{po.version}</div>
                    </td>
                    <td>{po.supplierName ?? po.supplierId}</td>
                    <td>{po.locationName ?? po.locationId}</td>
                    <td>
                      <span
                        className={`badge ${
                          po.status === 'CANCELLED' || po.status === 'DRAFT'
                            ? 'badge-archived'
                            : 'badge-active'
                        }`}
                      >
                        {po.status}
                      </span>
                    </td>
                    <td>
                      {po.lines.map((line) => (
                        <div key={line.id} style={{ fontSize: 13 }}>
                          {line.skuCode ?? line.skuId}: {line.fulfilledQty} / {line.orderedQty}
                          {line.unitCost !== undefined
                            ? ` @ ${line.unitCost} ${line.currency}`
                            : ''}
                        </div>
                      ))}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {po.status === 'DRAFT' && (
                          <>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => startEditDraft(po)}
                              disabled={busyId === po.id}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              onClick={() => handleConfirm(po)}
                              disabled={busyId === po.id}
                            >
                              Confirm
                            </button>
                          </>
                        )}
                        {(po.status === 'CONFIRMED' || po.status === 'PARTIALLY_RECEIVED') && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => openReceivePanel(po)}
                            disabled={busyId === po.id}
                          >
                            Receive
                          </button>
                        )}
                        {(po.status === 'DRAFT' ||
                          po.status === 'CONFIRMED' ||
                          po.status === 'PARTIALLY_RECEIVED') && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleCancel(po)}
                            disabled={busyId === po.id}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
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

      {overReceiveModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="over-receive-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 50,
          }}
        >
          <div className="card" style={{ maxWidth: 460, width: '100%' }}>
            <h2 id="over-receive-title" style={{ marginTop: 0, fontSize: 18 }}>
              Confirm Over-Receiving
            </h2>
            <p style={{ fontSize: 14, color: 'var(--text)' }}>{overReceiveMessage}</p>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              Do you want to proceed and record the over-received quantity?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                onClick={() => setOverReceiveModalOpen(false)}
                disabled={receiving}
              >
                Go Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => submitReceipt(true)}
                disabled={receiving}
              >
                {receiving ? 'Confirming...' : 'Confirm Over-Receive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

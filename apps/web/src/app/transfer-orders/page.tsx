'use client';

import {
  type DiscrepancyReason,
  type Location,
  type ReceiveTransferOrderResult,
  SSE_TOPICS,
  type Sku,
  type TransferOrder,
  type TransferOrderStatus,
} from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | TransferOrderStatus;

interface DraftLineState {
  skuId: string;
  orderedQty: string;
}

interface ReceiveLotState {
  lotId: string | null;
  lotCode: string;
  expDate: string | null;
  dispatchedQty: string;
  receivedQty: string;
  discrepancyQty: string;
  dispatchUnitCost?: string | undefined;
  currency: string;
  quantity: string;
}

interface ReceiveLineState {
  orderLineId: string;
  skuLabel: string;
  dispatchedQty: string;
  receivedQty: string;
  dispatchUnitCost: string | null;
  currency: string;
  quantity: string;
  lots: ReceiveLotState[];
}

interface DiscrepancyLotState {
  lotId: string | null;
  lotCode: string;
  expDate: string | null;
  openQty: string;
  quantity: string;
}

interface DiscrepancyLineState {
  orderLineId: string;
  skuLabel: string;
  remainingQty: string;
  lots: DiscrepancyLotState[];
}

const STATUS_FILTERS: readonly StatusFilter[] = [
  'ALL',
  'DRAFT',
  'CONFIRMED',
  'IN_TRANSIT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED_WITH_DISCREPANCY',
  'CANCELLED',
];

const DISCREPANCY_REASONS: readonly DiscrepancyReason[] = ['LOST', 'DAMAGED', 'OTHER'];

export default function TransferOrdersPage() {
  const [orders, setOrders] = useState<TransferOrder[]>([]);
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
  const [editingOrder, setEditingOrder] = useState<TransferOrder | null>(null);
  const [orderNumber, setOrderNumber] = useState('');
  const [sourceLocationId, setSourceLocationId] = useState('');
  const [destinationLocationId, setDestinationLocationId] = useState('');
  const [note, setNote] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLineState[]>([
    { skuId: '', orderedQty: '1.0000' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  // Receive modal state
  const [receivingOrder, setReceivingOrder] = useState<TransferOrder | null>(null);
  const [receiveNote, setReceiveNote] = useState('');
  const [receiveLines, setReceiveLines] = useState<ReceiveLineState[]>([]);
  const [receiving, setReceiving] = useState(false);

  // Discrepancy close-out modal state
  const [closingOrder, setClosingOrder] = useState<TransferOrder | null>(null);
  const [discrepancyReason, setDiscrepancyReason] = useState<DiscrepancyReason>('LOST');
  const [discrepancyNote, setDiscrepancyNote] = useState('');
  const [discrepancyLines, setDiscrepancyLines] = useState<DiscrepancyLineState[]>([]);
  const [closingDiscrepancy, setClosingDiscrepancy] = useState(false);

  const loadReferenceData = useCallback(async () => {
    const [locRes, skuRes] = await Promise.all([
      apiFetchPaginated<Location>('/api/v1/locations?status=ACTIVE&limit=100'),
      apiFetchPaginated<Sku>('/api/v1/skus?status=ACTIVE&limit=100'),
    ]);
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

    const res = await apiFetchPaginated<TransferOrder>(
      `/api/v1/transfer-orders?${params.toString()}`,
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
          setError(err instanceof Error ? err.message : 'Failed to load transfer orders');
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

  useLiveRefresh([SSE_TOPICS.TRANSFER_ORDERS, 'orders'], () =>
    Promise.all([loadReferenceData(), loadOrders(statusFilter)]).then(() => undefined),
  );

  function resetDraftForm() {
    setEditingOrder(null);
    setOrderNumber('');
    setSourceLocationId('');
    setDestinationLocationId('');
    setNote('');
    setDraftLines([{ skuId: '', orderedQty: '1.0000' }]);
  }

  function startEditDraft(to: TransferOrder) {
    setEditingOrder(to);
    setOrderNumber(to.orderNumber);
    setSourceLocationId(to.sourceLocationId);
    setDestinationLocationId(to.destinationLocationId);
    setNote(to.note ?? '');
    setDraftLines(
      to.lines.map((line) => ({
        skuId: line.skuId,
        orderedQty: line.orderedQty,
      })),
    );
    setError(null);
  }

  function addDraftLine() {
    setDraftLines((prev) => [...prev, { skuId: '', orderedQty: '1.0000' }]);
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
        await apiFetch<TransferOrder>(`/api/v1/transfer-orders/${editingOrder.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            expectedVersion: editingOrder.version,
            sourceLocationId,
            destinationLocationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: draftLines,
          }),
        });
      } else {
        await apiFetch<TransferOrder>('/api/v1/transfer-orders', {
          method: 'POST',
          body: JSON.stringify({
            ...(orderNumber.trim().length > 0 ? { orderNumber: orderNumber.trim() } : {}),
            sourceLocationId,
            destinationLocationId,
            note: note.trim().length > 0 ? note.trim() : null,
            lines: draftLines,
          }),
        });
      }

      resetDraftForm();
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save Transfer Order');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(to: TransferOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(to.id);
    try {
      await apiFetch<TransferOrder>(`/api/v1/transfer-orders/${to.id}/confirm`, {
        method: 'POST',
      });
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to confirm Transfer Order');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDispatch(to: TransferOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(to.id);
    try {
      const res = await apiFetch<TransferOrder>(`/api/v1/transfer-orders/${to.id}/dispatch`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to dispatch Transfer Order');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(to: TransferOrder) {
    setError(null);
    setWarnings([]);
    setBusyId(to.id);
    try {
      await apiFetch<TransferOrder>(`/api/v1/transfer-orders/${to.id}/cancel`, {
        method: 'POST',
      });
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to cancel Transfer Order');
    } finally {
      setBusyId(null);
    }
  }

  function openReceiveModal(to: TransferOrder) {
    setReceivingOrder(to);
    setReceiveNote('');
    setReceiveLines(
      to.lines.map((line) => {
        const remaining = Math.max(0, Number(line.dispatchedQty) - Number(line.receivedQty));
        const lots: ReceiveLotState[] = (line.lots ?? []).map((lot) => {
          const lotOpen = Math.max(
            0,
            Number(lot.dispatchedQty) - Number(lot.receivedQty) - Number(lot.discrepancyQty),
          );
          return {
            lotId: lot.lotId,
            lotCode: lot.lotCode ?? (lot.lotId ? lot.lotId : 'Unlotted'),
            expDate: lot.expDate,
            dispatchedQty: lot.dispatchedQty,
            receivedQty: lot.receivedQty,
            discrepancyQty: lot.discrepancyQty,
            dispatchUnitCost: lot.dispatchUnitCost,
            currency: lot.currency,
            quantity: lotOpen > 0 ? lotOpen.toFixed(4) : '0.0000',
          };
        });
        return {
          orderLineId: line.id,
          skuLabel: line.skuCode ? `${line.skuCode} — ${line.skuName}` : line.skuId,
          dispatchedQty: line.dispatchedQty,
          receivedQty: line.receivedQty,
          dispatchUnitCost: line.dispatchUnitCost ?? null,
          currency: line.currency,
          quantity: remaining > 0 ? remaining.toFixed(4) : '0.0000',
          lots,
        };
      }),
    );
    setError(null);
  }

  async function handleSubmitReceive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!receivingOrder) {
      return;
    }

    const linesToReceive = receiveLines
      .map((l) => {
        if (l.lots.length > 0) {
          const lotAllocs = l.lots
            .filter((lot) => Number(lot.quantity) > 0)
            .map((lot) => ({ lotId: lot.lotId, quantity: lot.quantity }));
          const sum = lotAllocs.reduce((acc, a) => acc + Number(a.quantity), 0);
          return {
            orderLineId: l.orderLineId,
            quantity: sum.toFixed(4),
            lotAllocations: lotAllocs,
          };
        }
        return { orderLineId: l.orderLineId, quantity: l.quantity };
      })
      .filter((l) => Number(l.quantity) > 0);

    if (linesToReceive.length === 0) {
      setError('Enter a positive quantity on at least one line to receive.');
      return;
    }

    setError(null);
    setWarnings([]);
    setReceiving(true);
    try {
      const res = await apiFetch<ReceiveTransferOrderResult>(
        `/api/v1/transfer-orders/${receivingOrder.id}/receipts`,
        {
          method: 'POST',
          body: JSON.stringify({
            note: receiveNote.trim().length > 0 ? receiveNote.trim() : null,
            lines: linesToReceive,
          }),
        },
      );
      if (res.warnings && res.warnings.length > 0) {
        setWarnings(res.warnings.map((w) => w.message));
      }
      setReceivingOrder(null);
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to receive Transfer Order');
    } finally {
      setReceiving(false);
    }
  }

  function openCloseDiscrepancyModal(to: TransferOrder) {
    setClosingOrder(to);
    setDiscrepancyReason('LOST');
    setDiscrepancyNote('');
    const dLines: DiscrepancyLineState[] = [];
    for (const line of to.lines) {
      const remaining = Math.max(0, Number(line.dispatchedQty) - Number(line.receivedQty));
      if (remaining <= 0) continue;
      const openLots = (line.lots ?? [])
        .map((lot) => ({
          lotId: lot.lotId,
          lotCode: lot.lotCode ?? (lot.lotId ? lot.lotId : 'Unlotted'),
          expDate: lot.expDate,
          openQty: Math.max(
            0,
            Number(lot.dispatchedQty) - Number(lot.receivedQty) - Number(lot.discrepancyQty),
          ),
        }))
        .filter((l) => l.openQty > 0)
        .sort((a, b) => {
          if (a.expDate && b.expDate) return b.expDate.localeCompare(a.expDate);
          if (a.expDate && !b.expDate) return -1;
          if (!a.expDate && b.expDate) return 1;
          return 0;
        });

      let toAttr = remaining;
      const lots: DiscrepancyLotState[] = openLots.map((l) => {
        const take = Math.min(toAttr, l.openQty);
        toAttr = Math.max(0, toAttr - take);
        return {
          lotId: l.lotId,
          lotCode: l.lotCode,
          expDate: l.expDate,
          openQty: l.openQty.toFixed(4),
          quantity: take.toFixed(4),
        };
      });

      dLines.push({
        orderLineId: line.id,
        skuLabel: line.skuCode ? `${line.skuCode} — ${line.skuName}` : line.skuId,
        remainingQty: remaining.toFixed(4),
        lots,
      });
    }
    setDiscrepancyLines(dLines);
    setError(null);
  }

  async function handleSubmitCloseDiscrepancy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!closingOrder) {
      return;
    }

    const linesPayload = discrepancyLines
      .filter((dl) => dl.lots.length > 0)
      .map((dl) => ({
        orderLineId: dl.orderLineId,
        lotAllocations: dl.lots
          .filter((l) => Number(l.quantity) > 0)
          .map((l) => ({ lotId: l.lotId, quantity: l.quantity })),
      }));

    setError(null);
    setWarnings([]);
    setClosingDiscrepancy(true);
    try {
      await apiFetch<TransferOrder>(
        `/api/v1/transfer-orders/${closingOrder.id}/close-discrepancy`,
        {
          method: 'POST',
          body: JSON.stringify({
            reason: discrepancyReason,
            note: discrepancyNote.trim(),
            ...(linesPayload.length > 0 ? { lines: linesPayload } : {}),
          }),
        },
      );
      setClosingOrder(null);
      await loadOrders(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to close discrepancy');
    } finally {
      setClosingDiscrepancy(false);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    try {
      await loadOrders(statusFilter, nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more transfer orders');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div className="page-header">
        <div>
          <h1 className="page-title">Transfer Orders</h1>
          <p className="page-subtitle">
            Move stock between Locations with dispatch cost snapshotting, In-Transit Stock
            tracking, and discrepancy close-out.
          </p>
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {warnings.length > 0 && (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fffbeb',
            border: '1px solid #f59e0b',
            color: '#92400e',
            fontSize: 13,
          }}
        >
          <strong>Warnings:</strong> {warnings.join(' | ')}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 20 }}>
        <div className="card">
          <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>
            {editingOrder ? `Edit Draft ${editingOrder.orderNumber}` : 'Create Transfer Order'}
          </h2>
          <form onSubmit={handleSaveDraft}>
            {!editingOrder && (
              <div className="form-field">
                <label className="form-label" htmlFor="to-number">
                  Order Number (optional)
                </label>
                <input
                  id="to-number"
                  className="form-input"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  placeholder="Auto-generated if empty"
                />
              </div>
            )}

            <div className="form-field">
              <label className="form-label" htmlFor="to-source-location">
                Source Location
              </label>
              <select
                id="to-source-location"
                className="form-input"
                value={sourceLocationId}
                onChange={(e) => setSourceLocationId(e.target.value)}
                required
              >
                <option value="">Select source Location...</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="to-dest-location">
                Destination Location
              </label>
              <select
                id="to-dest-location"
                className="form-input"
                value={destinationLocationId}
                onChange={(e) => setDestinationLocationId(e.target.value)}
                required
              >
                <option value="">Select destination Location...</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="to-note">
                Note
              </label>
              <input
                id="to-note"
                className="form-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional transfer note"
              />
            </div>

            <div style={{ marginTop: 12, marginBottom: 8 }}>
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

              {draftLines.map((line, index) => (
                <div
                  key={index}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: 10,
                    marginBottom: 8,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <select
                    className="form-input"
                    aria-label={`Line ${index + 1} SKU`}
                    value={line.skuId}
                    onChange={(e) => updateDraftLine(index, { skuId: e.target.value })}
                    required
                  >
                    <option value="">Select SKU...</option>
                    {skus.map((sku) => (
                      <option key={sku.id} value={sku.id}>
                        {sku.code} — {sku.name}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
                    <input
                      className="form-input"
                      aria-label={`Line ${index + 1} Quantity`}
                      value={line.orderedQty}
                      onChange={(e) => updateDraftLine(index, { orderedQty: e.target.value })}
                      placeholder="Qty"
                      required
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => removeDraftLine(index)}
                      disabled={draftLines.length <= 1}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving...' : editingOrder ? 'Save Draft' : 'Create Draft'}
              </button>
              {editingOrder && (
                <button type="button" className="btn" onClick={resetDraftForm}>
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          {receivingOrder && (
            <div className="card">
              <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>
                Receive Transfer {receivingOrder.orderNumber} (at{' '}
                {receivingOrder.destinationLocationName ?? receivingOrder.destinationLocationId})
              </h2>
              <form onSubmit={handleSubmitReceive}>
                <div className="form-field">
                  <label className="form-label" htmlFor="to-receive-note">
                    Receipt Note
                  </label>
                  <input
                    id="to-receive-note"
                    className="form-input"
                    value={receiveNote}
                    onChange={(e) => setReceiveNote(e.target.value)}
                    placeholder="Optional receipt reference"
                  />
                </div>

                {receiveLines.map((line, index) => (
                  <div
                    key={line.orderLineId}
                    style={{
                      padding: '8px 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: line.lots.length > 0 ? '1fr' : '2fr 1fr',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{line.skuLabel}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          Dispatched: {line.dispatchedQty} | Received: {line.receivedQty}
                          {line.dispatchUnitCost
                            ? ` | Snapshot Cost: ${line.dispatchUnitCost} ${line.currency}`
                            : ''}
                        </div>
                      </div>
                      {line.lots.length === 0 && (
                        <input
                          className="form-input"
                          aria-label={`Receive quantity for ${line.skuLabel}`}
                          value={line.quantity}
                          onChange={(e) =>
                            setReceiveLines((prev) =>
                              prev.map((item, i) =>
                                i === index ? { ...item, quantity: e.target.value } : item,
                              ),
                            )
                          }
                        />
                      )}
                    </div>
                    {line.lots.length > 0 && (
                      <div style={{ marginTop: 8, paddingLeft: 12, display: 'grid', gap: 6 }}>
                        {line.lots.map((lot, lotIdx) => (
                          <div
                            key={`${line.orderLineId}-${lot.lotId ?? 'unlotted'}-${lotIdx}`}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '2fr 1fr',
                              gap: 8,
                              alignItems: 'center',
                            }}
                          >
                            <div style={{ fontSize: 12 }}>
                              <strong>{lot.lotCode}</strong>
                              {lot.expDate ? ` (exp ${lot.expDate})` : ''} — disp {lot.dispatchedQty} /
                              rec {lot.receivedQty}
                              {lot.dispatchUnitCost
                                ? ` @ ${lot.dispatchUnitCost} ${lot.currency}`
                                : ''}
                            </div>
                            <input
                              className="form-input"
                              aria-label={`Receive quantity for lot ${lot.lotCode}`}
                              value={lot.quantity}
                              onChange={(e) =>
                                setReceiveLines((prev) =>
                                  prev.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          lots: item.lots.map((l, li) =>
                                            li === lotIdx ? { ...l, quantity: e.target.value } : l,
                                          ),
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="submit" className="btn btn-primary" disabled={receiving}>
                    {receiving ? 'Posting...' : 'Post Receipt'}
                  </button>
                  <button type="button" className="btn" onClick={() => setReceivingOrder(null)}>
                    Close
                  </button>
                </div>
              </form>
            </div>
          )}

          {closingOrder && (
            <div className="card">
              <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>
                Close Discrepancy — {closingOrder.orderNumber}
              </h2>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' }}>
                Clears any unreceived In-Transit Stock remainder and transitions the Transfer Order
                to Closed with Discrepancy.
              </p>
              <form onSubmit={handleSubmitCloseDiscrepancy}>
                <div className="form-field">
                  <label className="form-label" htmlFor="to-discrepancy-reason">
                    Discrepancy Reason
                  </label>
                  <select
                    id="to-discrepancy-reason"
                    className="form-input"
                    value={discrepancyReason}
                    onChange={(e) => setDiscrepancyReason(e.target.value as DiscrepancyReason)}
                    required
                  >
                    {DISCREPANCY_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {reason}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label className="form-label" htmlFor="to-discrepancy-note">
                    Discrepancy Note
                  </label>
                  <input
                    id="to-discrepancy-note"
                    className="form-input"
                    value={discrepancyNote}
                    onChange={(e) => setDiscrepancyNote(e.target.value)}
                    placeholder="Explain lost or damaged units"
                    required
                  />
                </div>

                {discrepancyLines.some((dl) => dl.lots.length > 0) && (
                  <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                    <div className="form-label" style={{ marginBottom: 0 }}>
                      Short-Lot Attribution (defaults to latest-expiring lot)
                    </div>
                    {discrepancyLines
                      .filter((dl) => dl.lots.length > 0)
                      .map((dl, dlIdx) => (
                        <div
                          key={dl.orderLineId}
                          style={{
                            padding: 8,
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                          }}
                        >
                          <div style={{ fontWeight: 500, fontSize: 12, marginBottom: 6 }}>
                            {dl.skuLabel} — Short Remainder: {dl.remainingQty}
                          </div>
                          <div style={{ display: 'grid', gap: 6 }}>
                            {dl.lots.map((lot, lotIdx) => (
                              <div
                                key={`${dl.orderLineId}-${lot.lotId ?? 'unlotted'}-${lotIdx}`}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '2fr 1fr',
                                  gap: 8,
                                  alignItems: 'center',
                                }}
                              >
                                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                                  <strong>{lot.lotCode}</strong>
                                  {lot.expDate ? ` (exp ${lot.expDate})` : ''} — In-Transit:{' '}
                                  {lot.openQty}
                                </div>
                                <input
                                  className="form-input"
                                  aria-label={`Short quantity for lot ${lot.lotCode}`}
                                  value={lot.quantity}
                                  onChange={(e) =>
                                    setDiscrepancyLines((prev) =>
                                      prev.map((item, i) =>
                                        i === dlIdx
                                          ? {
                                              ...item,
                                              lots: item.lots.map((l, li) =>
                                                li === lotIdx
                                                  ? { ...l, quantity: e.target.value }
                                                  : l,
                                              ),
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={closingDiscrepancy}
                  >
                    {closingDiscrepancy ? 'Closing...' : 'Confirm Discrepancy Close-Out'}
                  </button>
                  <button type="button" className="btn" onClick={() => setClosingOrder(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            <div className="toolbar">
              <div className="filter-group" style={{ flexWrap: 'wrap' }}>
                {STATUS_FILTERS.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`filter-pill${statusFilter === status ? ' active' : ''}`}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading transfer orders...</p>
            ) : orders.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 14 }}>No transfer orders found.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Route</th>
                    <th>Status</th>
                    <th>Lines</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((to) => {
                    const canEdit = to.status === 'DRAFT';
                    const canConfirm = to.status === 'DRAFT';
                    const canDispatch = to.status === 'CONFIRMED';
                    const canReceive =
                      to.status === 'IN_TRANSIT' || to.status === 'PARTIALLY_RECEIVED';
                    const canCloseDiscrepancy =
                      to.status === 'IN_TRANSIT' || to.status === 'PARTIALLY_RECEIVED';
                    const canCancel = to.status === 'DRAFT' || to.status === 'CONFIRMED';

                    return (
                      <tr key={to.id}>
                        <td>
                          <strong>{to.orderNumber}</strong>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>v{to.version}</div>
                        </td>
                        <td>
                          <div style={{ fontSize: 13 }}>
                            {to.sourceLocationName ?? to.sourceLocationId} &rarr;{' '}
                            {to.destinationLocationName ?? to.destinationLocationId}
                          </div>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              to.status === 'CANCELLED' || to.status === 'CLOSED_WITH_DISCREPANCY'
                                ? 'badge-archived'
                                : to.status === 'RECEIVED'
                                  ? 'badge-active'
                                  : ''
                            }`}
                          >
                            {to.status}
                          </span>
                          {to.discrepancyReason && (
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                              {to.discrepancyReason}: {to.discrepancyNote}
                            </div>
                          )}
                        </td>
                        <td>
                          <div style={{ fontSize: 12 }}>
                            {to.lines.map((line) => (
                              <div key={line.id} style={{ marginBottom: 4 }}>
                                <div>
                                  {line.skuCode ?? line.skuId}: ord {line.orderedQty} / disp{' '}
                                  {line.dispatchedQty} / rec {line.receivedQty}
                                  {line.dispatchUnitCost
                                    ? ` @ ${line.dispatchUnitCost} ${line.currency}`
                                    : ''}
                                </div>
                                {line.lots && line.lots.length > 0 && (
                                  <div style={{ paddingLeft: 10, fontSize: 11, color: 'var(--muted)' }}>
                                    {line.lots.map((lot) => (
                                      <div key={lot.id}>
                                        &bull; {lot.lotCode ?? (lot.lotId ? lot.lotId : 'Unlotted')}
                                        {lot.expDate ? ` (exp ${lot.expDate})` : ''}: disp{' '}
                                        {lot.dispatchedQty} / rec {lot.receivedQty}
                                        {Number(lot.discrepancyQty) > 0
                                          ? ` / short ${lot.discrepancyQty}`
                                          : ''}
                                        {lot.dispatchUnitCost
                                          ? ` @ ${lot.dispatchUnitCost} ${lot.currency}`
                                          : ''}
                                      </div>
                                    ))}
                                  </div>
                                )}
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
                                onClick={() => startEditDraft(to)}
                                disabled={busyId === to.id}
                              >
                                Edit
                              </button>
                            )}
                            {canConfirm && (
                              <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => handleConfirm(to)}
                                disabled={busyId === to.id}
                              >
                                Confirm
                              </button>
                            )}
                            {canDispatch && (
                              <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => handleDispatch(to)}
                                disabled={busyId === to.id}
                              >
                                Dispatch
                              </button>
                            )}
                            {canReceive && (
                              <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => openReceiveModal(to)}
                                disabled={busyId === to.id}
                              >
                                Receive
                              </button>
                            )}
                            {canCloseDiscrepancy && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => openCloseDiscrepancyModal(to)}
                                disabled={busyId === to.id}
                              >
                                Close Discrepancy
                              </button>
                            )}
                            {canCancel && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => handleCancel(to)}
                                disabled={busyId === to.id}
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
      </div>
    </AppShell>
  );
}

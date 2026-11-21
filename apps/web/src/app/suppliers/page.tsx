'use client';

import type { Supplier, SupplierStatus } from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | SupplierStatus;

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadSuppliers = useCallback(async (filter: StatusFilter, cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (filter !== 'ALL') {
      params.set('status', filter);
    }
    if (cursor) {
      params.set('cursor', cursor);
    }

    const res = await apiFetchPaginated<Supplier>(`/api/v1/suppliers?${params.toString()}`);
    if (cursor) {
      setSuppliers((prev) => [...prev, ...res.data]);
    } else {
      setSuppliers(res.data);
    }
    setNextCursor(res.page.nextCursor);
    setHasMore(res.page.hasMore);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadSuppliers(statusFilter)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load suppliers');
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
  }, [statusFilter, loadSuppliers]);

  function resetForm() {
    setEditingId(null);
    setName('');
    setEmail('');
    setPhone('');
    setAddress('');
  }

  function startEdit(sup: Supplier) {
    setEditingId(sup.id);
    setName(sup.name);
    setEmail(sup.email ?? '');
    setPhone(sup.phone ?? '');
    setAddress(sup.address ?? '');
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        name: name.trim(),
        email: email.trim().length > 0 ? email.trim() : null,
        phone: phone.trim().length > 0 ? phone.trim() : null,
        address: address.trim().length > 0 ? address.trim() : null,
      };

      if (editingId) {
        await apiFetch<Supplier>(`/api/v1/suppliers/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Supplier>('/api/v1/suppliers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      resetForm();
      await loadSuppliers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save supplier');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchiveToggle(sup: Supplier) {
    setError(null);
    setBusyId(sup.id);
    const action = sup.status === 'ACTIVE' ? 'archive' : 'unarchive';
    try {
      await apiFetch<Supplier>(`/api/v1/suppliers/${sup.id}/${action}`, {
        method: 'POST',
      });
      await loadSuppliers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : `Failed to ${action} supplier`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(sup: Supplier) {
    setError(null);
    setBusyId(sup.id);
    try {
      await apiFetch<{ id: string; deleted: boolean }>(`/api/v1/suppliers/${sup.id}`, {
        method: 'DELETE',
      });
      if (editingId === sup.id) {
        resetForm();
      }
      await loadSuppliers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to delete supplier');
    } finally {
      setBusyId(null);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      await loadSuppliers(statusFilter, nextCursor);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load more suppliers');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="card">
          <div style={{ marginBottom: 16 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>Suppliers</h1>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' }}>
              Manage external Suppliers for Purchase Orders.
            </p>
          </div>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 12,
              }}
            >
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="supplier-name">Supplier Name</label>
                <input
                  id="supplier-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Metals"
                />
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="supplier-email">Email</label>
                <input
                  id="supplier-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="orders@supplier.com"
                />
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="supplier-phone">Phone</label>
                <input
                  id="supplier-phone"
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1-555-0100"
                />
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="supplier-address">Address</label>
                <input
                  id="supplier-address"
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="100 Foundry Way"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? 'Saving...'
                  : editingId
                    ? 'Save Supplier'
                    : 'Create Supplier'}
              </button>
              {editingId && (
                <button type="button" className="btn" onClick={resetForm} disabled={submitting}>
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="card">
          <div className="tabs" role="tablist" aria-label="Supplier status filter">
            {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((status) => (
              <button
                key={status}
                type="button"
                role="tab"
                aria-selected={statusFilter === status}
                className={`tab-btn${statusFilter === status ? ' active' : ''}`}
                onClick={() => setStatusFilter(status)}
              >
                {status === 'ALL' ? 'All' : status === 'ACTIVE' ? 'Active' : 'Archived'}
              </button>
            ))}
          </div>

          {loading ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading suppliers...</p>
          ) : suppliers.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No suppliers found.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Address</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((sup) => (
                  <tr key={sup.id}>
                    <td>
                      <strong>{sup.name}</strong>
                    </td>
                    <td>{sup.email ?? '—'}</td>
                    <td>{sup.phone ?? '—'}</td>
                    <td>{sup.address ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${sup.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'}`}
                      >
                        {sup.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => startEdit(sup)}
                          disabled={busyId === sup.id}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleArchiveToggle(sup)}
                          disabled={busyId === sup.id}
                        >
                          {sup.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleDelete(sup)}
                          disabled={busyId === sup.id}
                        >
                          Delete
                        </button>
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
    </AppShell>
  );
}

'use client';

import { type Customer, type CustomerStatus, SSE_TOPICS } from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | CustomerStatus;

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
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

  const loadCustomers = useCallback(async (filter: StatusFilter, cursor?: string) => {
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (filter !== 'ALL') {
      params.set('status', filter);
    }
    if (cursor) {
      params.set('cursor', cursor);
    }

    const res = await apiFetchPaginated<Customer>(`/api/v1/customers?${params.toString()}`);
    if (cursor) {
      setCustomers((prev) => [...prev, ...res.data]);
    } else {
      setCustomers(res.data);
    }
    setNextCursor(res.page.nextCursor);
    setHasMore(res.page.hasMore);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadCustomers(statusFilter)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load customers');
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
  }, [statusFilter, loadCustomers]);

  useLiveRefresh([SSE_TOPICS.CUSTOMERS], () => loadCustomers(statusFilter));

  function resetForm() {
    setEditingId(null);
    setName('');
    setEmail('');
    setPhone('');
    setAddress('');
  }

  function startEdit(cust: Customer) {
    setEditingId(cust.id);
    setName(cust.name);
    setEmail(cust.email ?? '');
    setPhone(cust.phone ?? '');
    setAddress(cust.address ?? '');
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
        await apiFetch<Customer>(`/api/v1/customers/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Customer>('/api/v1/customers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      resetForm();
      await loadCustomers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save customer');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchiveToggle(cust: Customer) {
    setError(null);
    setBusyId(cust.id);
    try {
      const action = cust.status === 'ACTIVE' ? 'archive' : 'unarchive';
      await apiFetch<Customer>(`/api/v1/customers/${cust.id}/${action}`, {
        method: 'POST',
      });
      await loadCustomers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to update customer status');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(cust: Customer) {
    setError(null);
    setBusyId(cust.id);
    try {
      await apiFetch<{ id: string; deleted: boolean }>(`/api/v1/customers/${cust.id}`, {
        method: 'DELETE',
      });
      if (editingId === cust.id) {
        resetForm();
      }
      await loadCustomers(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to delete customer');
    } finally {
      setBusyId(null);
    }
  }

  async function handleLoadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadCustomers(statusFilter, nextCursor);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load more customers');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell>
      <div className="stack">
        <div className="page-header">
          <div>
            <h1>Customers</h1>
            <p className="subtitle">Manage external customers for Sales Orders.</p>
          </div>
        </div>

        {error && (
          <div className="alert-error" role="alert">
            {error}
          </div>
        )}

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            {editingId ? 'Edit Customer' : 'New Customer'}
          </h2>
          <form onSubmit={handleSubmit} className="stack">
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="customer-name">Name</label>
                <input
                  id="customer-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Retail Co."
                />
              </div>
              <div className="form-group">
                <label htmlFor="customer-email">Email</label>
                <input
                  id="customer-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="orders@acmeretail.example"
                />
              </div>
              <div className="form-group">
                <label htmlFor="customer-phone">Phone</label>
                <input
                  id="customer-phone"
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1-555-0200"
                />
              </div>
              <div className="form-group">
                <label htmlFor="customer-address">Address</label>
                <input
                  id="customer-address"
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="456 Commerce Ave"
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving...' : editingId ? 'Save Changes' : 'Create Customer'}
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
          <div className="tabs" role="tablist" aria-label="Customer status filter">
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
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading customers...</p>
          ) : customers.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No customers found.</p>
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
                {customers.map((cust) => (
                  <tr key={cust.id}>
                    <td>
                      <strong>{cust.name}</strong>
                    </td>
                    <td>{cust.email ?? '—'}</td>
                    <td>{cust.phone ?? '—'}</td>
                    <td>{cust.address ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${cust.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'}`}
                      >
                        {cust.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => startEdit(cust)}
                          disabled={busyId === cust.id}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleArchiveToggle(cust)}
                          disabled={busyId === cust.id}
                        >
                          {cust.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleDelete(cust)}
                          disabled={busyId === cust.id}
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

'use client';

import type { Location, LocationStatus } from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type StatusFilter = 'ALL' | LocationStatus;

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [parentLocationId, setParentLocationId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const locationMap = useMemo(() => {
    const map = new Map<string, Location>();
    for (const loc of locations) {
      map.set(loc.id, loc);
    }
    return map;
  }, [locations]);

  const loadLocations = useCallback(
    async (filter: StatusFilter, cursor?: string) => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (filter !== 'ALL') {
        params.set('status', filter);
      }
      if (cursor) {
        params.set('cursor', cursor);
      }

      const res = await apiFetchPaginated<Location>(`/api/v1/locations?${params.toString()}`);
      if (cursor) {
        setLocations((prev) => [...prev, ...res.data]);
      } else {
        setLocations(res.data);
      }
      setNextCursor(res.page.nextCursor);
      setHasMore(res.page.hasMore);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loadLocations(statusFilter)
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load locations');
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
  }, [statusFilter, loadLocations]);

  function resetForm() {
    setEditingId(null);
    setName('');
    setAddress('');
    setDescription('');
    setParentLocationId('');
  }

  function startEdit(loc: Location) {
    setEditingId(loc.id);
    setName(loc.name);
    setAddress(loc.address ?? '');
    setDescription(loc.description ?? '');
    setParentLocationId(loc.parentLocationId ?? '');
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        name: name.trim(),
        address: address.trim().length > 0 ? address.trim() : null,
        description: description.trim().length > 0 ? description.trim() : null,
        parentLocationId: parentLocationId.length > 0 ? parentLocationId : null,
      };

      if (editingId) {
        await apiFetch<Location>(`/api/v1/locations/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Location>('/api/v1/locations', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      resetForm();
      await loadLocations(statusFilter);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Unable to save location');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchiveToggle(loc: Location) {
    setError(null);
    setBusyId(loc.id);
    try {
      const action = loc.status === 'ACTIVE' ? 'archive' : 'unarchive';
      await apiFetch<Location>(`/api/v1/locations/${loc.id}/${action}`, {
        method: 'POST',
      });
      await loadLocations(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to update location status');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(loc: Location) {
    setError(null);
    setBusyId(loc.id);
    try {
      await apiFetch<{ id: string; deleted: boolean }>(`/api/v1/locations/${loc.id}`, {
        method: 'DELETE',
      });
      if (editingId === loc.id) {
        resetForm();
      }
      await loadLocations(statusFilter);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Unable to delete location');
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
      await loadLocations(statusFilter, nextCursor);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load more locations');
    } finally {
      setLoadingMore(false);
    }
  }

  const parentOptions = locations.filter((loc) => loc.id !== editingId);

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <div>
              <h1 style={{ margin: 0, fontSize: 22 }}>Locations</h1>
              <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--muted)' }}>
                Manage physical Locations and optional parent Location hierarchy.
              </p>
            </div>
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
                <label htmlFor="location-name">Location Name</label>
                <input
                  id="location-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Main Warehouse"
                />
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="location-parent">Parent Location (Optional)</label>
                <select
                  id="location-parent"
                  value={parentLocationId}
                  onChange={(e) => setParentLocationId(e.target.value)}
                >
                  <option value="">None (Top-Level Location)</option>
                  {parentOptions.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="location-address">Address</label>
                <input
                  id="location-address"
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="100 Industrial Way"
                />
              </div>

              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="location-description">Description</label>
                <input
                  id="location-description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Primary distribution hub"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting
                  ? 'Saving...'
                  : editingId
                    ? 'Update Location'
                    : 'Create Location'}
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
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>Location Directory</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  className={`btn${statusFilter === status ? ' btn-primary' : ''}`}
                  onClick={() => setStatusFilter(status)}
                >
                  {status === 'ACTIVE' ? 'Active' : status === 'ARCHIVED' ? 'Archived' : 'All'}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading locations...</p>
          ) : locations.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>No locations found.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Parent Location</th>
                  <th>Address</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((loc) => {
                  const parent = loc.parentLocationId
                    ? locationMap.get(loc.parentLocationId)
                    : null;
                  const isBusy = busyId === loc.id;
                  return (
                    <tr key={loc.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{loc.name}</div>
                        {loc.description && (
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                            {loc.description}
                          </div>
                        )}
                      </td>
                      <td>{parent ? parent.name : loc.parentLocationId ?? '—'}</td>
                      <td>{loc.address ?? '—'}</td>
                      <td>
                        <span
                          className={`badge ${
                            loc.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'
                          }`}
                        >
                          {loc.status === 'ACTIVE' ? 'Active' : 'Archived'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => startEdit(loc)}
                            disabled={isBusy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleArchiveToggle(loc)}
                            disabled={isBusy}
                          >
                            {loc.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleDelete(loc)}
                            disabled={isBusy}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
      </div>
    </AppShell>
  );
}

'use client';

import {
  type CatalogStatus,
  type Product,
  SSE_TOPICS,
  type Sku,
  type UnitOfMeasure,
} from '@iv2/shared-domain';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLiveRefresh } from '../../components/LiveInvalidationProvider';
import { ApiClientError, apiFetch, apiFetchPaginated } from '../../lib/api-client';

type CatalogTab = 'skus' | 'products' | 'units';
type StatusFilter = 'ALL' | CatalogStatus;

function getErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    return `${err.message} (${err.code})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unexpected error occurred';
}

export default function CatalogPage() {
  const [activeTab, setActiveTab] = useState<CatalogTab>('skus');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Units of Measure state
  const [units, setUnits] = useState<UnitOfMeasure[]>([]);
  const [unitStatusFilter, setUnitStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [unitCode, setUnitCode] = useState('');
  const [unitName, setUnitName] = useState('');

  // Products state
  const [products, setProducts] = useState<Product[]>([]);
  const [productStatusFilter, setProductStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productName, setProductName] = useState('');
  const [productDescription, setProductDescription] = useState('');

  // SKUs state
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuStatusFilter, setSkuStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [skuProductFilter, setSkuProductFilter] = useState<string>('');
  const [lookupCode, setLookupCode] = useState('');
  const [lookupResult, setLookupResult] = useState<Sku | null>(null);
  const [editingSkuId, setEditingSkuId] = useState<string | null>(null);
  const [skuProductId, setSkuProductId] = useState('');
  const [skuUnitId, setSkuUnitId] = useState('');
  const [skuCode, setSkuCode] = useState('');
  const [skuName, setSkuName] = useState('');
  const [skuPrice, setSkuPrice] = useState('');

  const productMap = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products) {
      map.set(p.id, p);
    }
    return map;
  }, [products]);

  const unitMap = useMemo(() => {
    const map = new Map<string, UnitOfMeasure>();
    for (const u of units) {
      map.set(u.id, u);
    }
    return map;
  }, [units]);

  const loadUnits = useCallback(async (status: StatusFilter) => {
    const params = new URLSearchParams({ limit: '100' });
    if (status !== 'ALL') {
      params.set('status', status);
    }
    const res = await apiFetchPaginated<UnitOfMeasure>(`/api/v1/units-of-measure?${params.toString()}`);
    setUnits(res.data);
  }, []);

  const loadProducts = useCallback(async (status: StatusFilter) => {
    const params = new URLSearchParams({ limit: '100' });
    if (status !== 'ALL') {
      params.set('status', status);
    }
    const res = await apiFetchPaginated<Product>(`/api/v1/products?${params.toString()}`);
    setProducts(res.data);
  }, []);

  const loadSkus = useCallback(async (status: StatusFilter, productId: string) => {
    const params = new URLSearchParams({ limit: '100' });
    if (status !== 'ALL') {
      params.set('status', status);
    }
    if (productId) {
      params.set('productId', productId);
    }
    const res = await apiFetchPaginated<Sku>(`/api/v1/skus?${params.toString()}`);
    setSkus(res.data);
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([
        loadUnits(unitStatusFilter),
        loadProducts(productStatusFilter),
        loadSkus(skuStatusFilter, skuProductFilter),
      ]);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [
    loadUnits,
    loadProducts,
    loadSkus,
    unitStatusFilter,
    productStatusFilter,
    skuStatusFilter,
    skuProductFilter,
  ]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useLiveRefresh([SSE_TOPICS.CATALOG], refreshAll);

  // Unit of Measure handlers
  function startEditUnit(unit: UnitOfMeasure) {
    setEditingUnitId(unit.id);
    setUnitCode(unit.code);
    setUnitName(unit.name);
  }

  function resetUnitForm() {
    setEditingUnitId(null);
    setUnitCode('');
    setUnitName('');
  }

  async function handleSaveUnit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editingUnitId) {
        await apiFetch<UnitOfMeasure>(`/api/v1/units-of-measure/${editingUnitId}`, {
          method: 'PATCH',
          body: JSON.stringify({ code: unitCode, name: unitName }),
        });
      } else {
        await apiFetch<UnitOfMeasure>('/api/v1/units-of-measure', {
          method: 'POST',
          body: JSON.stringify({ code: unitCode, name: unitName }),
        });
      }
      resetUnitForm();
      await loadUnits(unitStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleUnitArchive(unit: UnitOfMeasure) {
    setError(null);
    setBusy(true);
    try {
      const action = unit.status === 'ACTIVE' ? 'archive' : 'unarchive';
      await apiFetch<UnitOfMeasure>(`/api/v1/units-of-measure/${unit.id}/${action}`, {
        method: 'POST',
      });
      await loadUnits(unitStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteUnit(id: string) {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/units-of-measure/${id}`, { method: 'DELETE' });
      await loadUnits(unitStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Product handlers
  function startEditProduct(product: Product) {
    setEditingProductId(product.id);
    setProductName(product.name);
    setProductDescription(product.description ?? '');
  }

  function resetProductForm() {
    setEditingProductId(null);
    setProductName('');
    setProductDescription('');
  }

  async function handleSaveProduct(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        name: productName,
        description: productDescription.trim() === '' ? null : productDescription,
      };
      if (editingProductId) {
        await apiFetch<Product>(`/api/v1/products/${editingProductId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Product>('/api/v1/products', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      resetProductForm();
      await loadProducts(productStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleProductArchive(product: Product) {
    setError(null);
    setBusy(true);
    try {
      const action = product.status === 'ACTIVE' ? 'archive' : 'unarchive';
      await apiFetch<Product>(`/api/v1/products/${product.id}/${action}`, {
        method: 'POST',
      });
      await loadProducts(productStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProduct(id: string) {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/products/${id}`, { method: 'DELETE' });
      await loadProducts(productStatusFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // SKU handlers
  function startEditSku(sku: Sku) {
    setEditingSkuId(sku.id);
    setSkuProductId(sku.productId);
    setSkuUnitId(sku.unitOfMeasureId);
    setSkuCode(sku.code);
    setSkuName(sku.name);
    setSkuPrice(sku.defaultSellingPrice ?? '');
  }

  function resetSkuForm() {
    setEditingSkuId(null);
    setSkuProductId('');
    setSkuUnitId('');
    setSkuCode('');
    setSkuName('');
    setSkuPrice('');
  }

  async function handleSaveSku(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        productId: skuProductId,
        unitOfMeasureId: skuUnitId,
        code: skuCode,
        name: skuName,
        defaultSellingPrice: skuPrice.trim() === '' ? null : skuPrice.trim(),
      };
      if (editingSkuId) {
        await apiFetch<Sku>(`/api/v1/skus/${editingSkuId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Sku>('/api/v1/skus', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      resetSkuForm();
      await loadSkus(skuStatusFilter, skuProductFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleSkuArchive(sku: Sku) {
    setError(null);
    setBusy(true);
    try {
      const action = sku.status === 'ACTIVE' ? 'archive' : 'unarchive';
      await apiFetch<Sku>(`/api/v1/skus/${sku.id}/${action}`, { method: 'POST' });
      await loadSkus(skuStatusFilter, skuProductFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSku(id: string) {
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/api/v1/skus/${id}`, { method: 'DELETE' });
      await loadSkus(skuStatusFilter, skuProductFilter);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLookupSku(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLookupResult(null);
    if (lookupCode.trim() === '') {
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<Sku>(
        `/api/v1/skus/lookup?code=${encodeURIComponent(lookupCode.trim())}`,
      );
      setLookupResult(res.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Catalog Management</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
              Manage Units of Measure, Products, and SKUs with case-insensitive code lookup.
            </p>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Catalog sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'skus'}
            className={`tab-btn${activeTab === 'skus' ? ' active' : ''}`}
            onClick={() => setActiveTab('skus')}
          >
            SKUs ({skus.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'products'}
            className={`tab-btn${activeTab === 'products' ? ' active' : ''}`}
            onClick={() => setActiveTab('products')}
          >
            Products ({products.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'units'}
            className={`tab-btn${activeTab === 'units' ? ' active' : ''}`}
            onClick={() => setActiveTab('units')}
          >
            Units of Measure ({units.length})
          </button>
        </div>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {activeTab === 'units' && (
          <div>
            <form
              onSubmit={handleSaveUnit}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr auto auto',
                gap: 12,
                alignItems: 'end',
                marginBottom: 20,
              }}
            >
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="unit-of-measure-code">Code</label>
                <input
                  id="unit-of-measure-code"
                  value={unitCode}
                  onChange={(e) => setUnitCode(e.target.value)}
                  placeholder="e.g. pcs, kg, L"
                  required
                />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="unit-of-measure-name">Name</label>
                <input
                  id="unit-of-measure-name"
                  value={unitName}
                  onChange={(e) => setUnitName(e.target.value)}
                  placeholder="e.g. Pieces"
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {editingUnitId ? 'Save Unit of Measure' : 'Add Unit of Measure'}
              </button>
              {editingUnitId && (
                <button type="button" className="btn" onClick={resetUnitForm} disabled={busy}>
                  Cancel
                </button>
              )}
            </form>

            <div className="toolbar">
              <div style={{ display: 'flex', gap: 8 }}>
                {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`btn btn-sm${unitStatusFilter === status ? ' btn-primary' : ''}`}
                    onClick={() => setUnitStatusFilter(status)}
                  >
                    {status === 'ALL' ? 'All' : status === 'ACTIVE' ? 'Active' : 'Archived'}
                  </button>
                ))}
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th style={{ width: 240 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <code>{u.code}</code>
                    </td>
                    <td>{u.name}</td>
                    <td>
                      <span
                        className={`badge ${
                          u.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => startEditUnit(u)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleToggleUnitArchive(u)}
                        >
                          {u.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteUnit(u.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {units.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--muted)', textAlign: 'center' }}>
                      No Units of Measure match the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'products' && (
          <div>
            <form
              onSubmit={handleSaveProduct}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr auto auto',
                gap: 12,
                alignItems: 'end',
                marginBottom: 20,
              }}
            >
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="product-name">Product Name</label>
                <input
                  id="product-name"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="e.g. Cotton T-Shirt"
                  required
                />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="product-description">Description</label>
                <input
                  id="product-description"
                  value={productDescription}
                  onChange={(e) => setProductDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {editingProductId ? 'Save Product' : 'Add Product'}
              </button>
              {editingProductId && (
                <button type="button" className="btn" onClick={resetProductForm} disabled={busy}>
                  Cancel
                </button>
              )}
            </form>

            <div className="toolbar">
              <div style={{ display: 'flex', gap: 8 }}>
                {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`btn btn-sm${productStatusFilter === status ? ' btn-primary' : ''}`}
                    onClick={() => setProductStatusFilter(status)}
                  >
                    {status === 'ALL' ? 'All' : status === 'ACTIVE' ? 'Active' : 'Archived'}
                  </button>
                ))}
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th style={{ width: 240 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 500 }}>{p.name}</td>
                    <td style={{ color: 'var(--muted)' }}>{p.description ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${
                          p.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => startEditProduct(p)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleToggleProductArchive(p)}
                        >
                          {p.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteProduct(p.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--muted)', textAlign: 'center' }}>
                      No Products match the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'skus' && (
          <div>
            <form
              onSubmit={handleLookupSku}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'end',
                marginBottom: 20,
                padding: 12,
                background: 'var(--bg)',
                borderRadius: 6,
                border: '1px solid var(--border)',
              }}
            >
              <div className="form-field" style={{ marginBottom: 0, flex: 1, maxWidth: 320 }}>
                <label htmlFor="sku-lookup">Lookup SKU by Code (Case-Insensitive)</label>
                <input
                  id="sku-lookup"
                  value={lookupCode}
                  onChange={(e) => setLookupCode(e.target.value)}
                  placeholder="Scan or enter SKU code"
                />
              </div>
              <button type="submit" className="btn" disabled={busy}>
                Lookup
              </button>
              {lookupResult && (
                <div style={{ fontSize: 13 }}>
                  Found: <code>{lookupResult.code}</code> — <strong>{lookupResult.name}</strong> (
                  {lookupResult.status})
                </div>
              )}
            </form>

            <form
              onSubmit={handleSaveSku}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1fr 1.4fr 1fr auto auto',
                gap: 10,
                alignItems: 'end',
                marginBottom: 20,
              }}
            >
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="sku-product">Product</label>
                <select
                  id="sku-product"
                  value={skuProductId}
                  onChange={(e) => setSkuProductId(e.target.value)}
                  required
                >
                  <option value="">Select Product...</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="sku-unit">Unit of Measure</label>
                <select
                  id="sku-unit"
                  value={skuUnitId}
                  onChange={(e) => setSkuUnitId(e.target.value)}
                  required
                >
                  <option value="">Select Unit...</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} ({u.name})
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="sku-code">SKU Code</label>
                <input
                  id="sku-code"
                  value={skuCode}
                  onChange={(e) => setSkuCode(e.target.value)}
                  placeholder="TSHIRT-RED-M"
                  required
                />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="sku-name">SKU Name</label>
                <input
                  id="sku-name"
                  value={skuName}
                  onChange={(e) => setSkuName(e.target.value)}
                  placeholder="Cotton T-Shirt — Red, Medium"
                  required
                />
              </div>
              <div className="form-field" style={{ marginBottom: 0 }}>
                <label htmlFor="sku-price">Default Selling Price</label>
                <input
                  id="sku-price"
                  value={skuPrice}
                  onChange={(e) => setSkuPrice(e.target.value)}
                  placeholder="0.0000"
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {editingSkuId ? 'Save SKU' : 'Add SKU'}
              </button>
              {editingSkuId && (
                <button type="button" className="btn" onClick={resetSkuForm} disabled={busy}>
                  Cancel
                </button>
              )}
            </form>

            <div className="toolbar">
              <div style={{ display: 'flex', gap: 8 }}>
                {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`btn btn-sm${skuStatusFilter === status ? ' btn-primary' : ''}`}
                    onClick={() => setSkuStatusFilter(status)}
                  >
                    {status === 'ALL' ? 'All' : status === 'ACTIVE' ? 'Active' : 'Archived'}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label htmlFor="sku-product-filter" style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Product:
                </label>
                <select
                  id="sku-product-filter"
                  value={skuProductFilter}
                  onChange={(e) => setSkuProductFilter(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <option value="">All Products</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Product</th>
                  <th>Unit</th>
                  <th>Default Price</th>
                  <th>Status</th>
                  <th style={{ width: 240 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {skus.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code>{s.code}</code>
                    </td>
                    <td style={{ fontWeight: 500 }}>{s.name}</td>
                    <td>{productMap.get(s.productId)?.name ?? s.productId}</td>
                    <td>{unitMap.get(s.unitOfMeasureId)?.code ?? s.unitOfMeasureId}</td>
                    <td>{s.defaultSellingPrice ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${
                          s.status === 'ACTIVE' ? 'badge-active' : 'badge-archived'
                        }`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => startEditSku(s)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => void handleToggleSkuArchive(s)}
                        >
                          {s.status === 'ACTIVE' ? 'Archive' : 'Unarchive'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void handleDeleteSku(s.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {skus.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ color: 'var(--muted)', textAlign: 'center' }}>
                      No SKUs match the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

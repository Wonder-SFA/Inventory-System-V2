import { ZERO_DECIMAL4 } from '@iv2/shared-domain';
import { AppShell } from '../components/AppShell';

export default function HomePage() {
  return (
    <AppShell>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Operations Workspace</h1>
        <p style={{ color: 'var(--muted)', marginBottom: 8 }}>
          Select a module from the sidebar to manage Catalog, Locations, Stock Balances, Stock
          Movements, and Orders.
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          Fixed-precision baseline: {ZERO_DECIMAL4}
        </p>
      </div>
    </AppShell>
  );
}

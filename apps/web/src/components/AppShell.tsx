'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { type SessionInfo, fetchSession } from '../lib/api-client';

const NAV_ITEMS = [
  { href: '/catalog', label: 'Catalog' },
  { href: '/locations', label: 'Locations' },
  { href: '/stock-balances', label: 'Stock Balances' },
  { href: '/stock-movements', label: 'Stock Movements' },
  { href: '/suppliers', label: 'Suppliers' },
  { href: '/purchase-orders', label: 'Purchase Orders' },
  { href: '/customers', label: 'Customers' },
  { href: '/sales-orders', label: 'Sales Orders' },
  { href: '/transfer-orders', label: 'Transfer Orders' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    fetchSession(() => {
      router.replace('/login');
    })
      .then((data) => {
        if (active) {
          setSession(data);
        }
      })
      .catch(() => {
        // 401 handled by onUnauthorized callback above
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [router]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  if (loading) {
    return (
      <div className="login-wrapper">
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading workspace...</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="sidebar-brand">
          Inventory System V2
        </Link>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`sidebar-link${isActive ? ' active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <span className="topbar-title">Multi-Location Operations</span>
          <div className="topbar-user">
            <span>
              <strong>{session.user.name}</strong> ({session.user.email})
            </span>
            <button
              type="button"
              className="btn"
              onClick={handleSignOut}
              disabled={signingOut}
            >
              {signingOut ? 'Signing out...' : 'Sign Out'}
            </button>
          </div>
        </header>

        {session.accessSwitch === 'READ_ONLY' && (
          <div className="access-banner read-only" role="status">
            Read-Only Mode Active — Viewing is permitted, but creating or modifying records is
            currently disabled.
          </div>
        )}

        {session.accessSwitch === 'SUSPENDED' && (
          <div className="access-banner suspended" role="alert">
            Instance Suspended — Operational access is currently suspended. Contact your
            administrator or sign out.
          </div>
        )}

        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

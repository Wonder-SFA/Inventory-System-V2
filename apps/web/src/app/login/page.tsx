'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const endpoint =
        mode === 'sign-in' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email';
      const payload = mode === 'sign-in' ? { email, password } : { name, email, password };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const errData = (await response.json().catch(() => null)) as {
          message?: string;
          error?: { message?: string };
        } | null;
        setError(
          errData?.error?.message ??
            errData?.message ??
            (mode === 'sign-in' ? 'Invalid email or password' : 'Unable to create account'),
        );
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('Unable to reach authentication service');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-wrapper">
      <div className="card login-card">
        <h1 style={{ marginTop: 0, marginBottom: 4, fontSize: 20 }}>Inventory System V2</h1>
        <p style={{ marginTop: 0, marginBottom: 20, fontSize: 14, color: 'var(--muted)' }}>
          {mode === 'sign-in'
            ? 'Sign in with your email and password'
            : 'Create a local user account'}
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {mode === 'sign-up' && (
            <div className="form-field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Office Clerk"
              />
            </div>
          )}

          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@inventory.local"
            />
          </div>

          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={submitting}
          >
            {submitting
              ? 'Please wait...'
              : mode === 'sign-in'
                ? 'Sign In'
                : 'Create Account'}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 13 }}>
          <button
            type="button"
            className="btn"
            style={{ border: 'none', background: 'transparent', color: 'var(--primary)' }}
            onClick={() => {
              setError(null);
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            }}
          >
            {mode === 'sign-in'
              ? 'First time? Create an account'
              : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}

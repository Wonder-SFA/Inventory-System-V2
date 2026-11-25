import { describe, expect, it } from 'vitest';
import { computeExpiryStatus, getExpiryCutoffDate } from './expiry.js';

describe('computeExpiryStatus', () => {
  it('returns NO_EXPIRY when expDate is null', () => {
    expect(computeExpiryStatus(null, { today: '2026-11-24' })).toBe('NO_EXPIRY');
  });

  it('returns EXPIRED when expDate is strictly before today', () => {
    expect(computeExpiryStatus('2026-11-23', { today: '2026-11-24' })).toBe('EXPIRED');
  });

  it('returns EXPIRING_SOON when expDate is today or within default 30-day window', () => {
    expect(computeExpiryStatus('2026-11-24', { today: '2026-11-24' })).toBe('EXPIRING_SOON');
    expect(computeExpiryStatus('2026-12-24', { today: '2026-11-24' })).toBe('EXPIRING_SOON');
  });

  it('returns ACTIVE when expDate is strictly after the 30-day window', () => {
    expect(computeExpiryStatus('2026-12-25', { today: '2026-11-24' })).toBe('ACTIVE');
  });

  it('respects custom expiringWithinDays window', () => {
    expect(
      computeExpiryStatus('2026-12-01', { today: '2026-11-24', expiringWithinDays: 7 }),
    ).toBe('EXPIRING_SOON');
    expect(
      computeExpiryStatus('2026-12-02', { today: '2026-11-24', expiringWithinDays: 7 }),
    ).toBe('ACTIVE');
  });

  it('computes UTC cutoff date accurately across month and year boundaries', () => {
    expect(getExpiryCutoffDate('2026-12-15', 30)).toBe('2027-01-14');
  });
});

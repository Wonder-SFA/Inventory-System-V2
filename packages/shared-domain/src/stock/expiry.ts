import { z } from 'zod';

export const DEFAULT_EXPIRING_SOON_DAYS = 30;

export const ExpiryStatusSchema = z.enum(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'NO_EXPIRY']);
export type ExpiryStatus = z.infer<typeof ExpiryStatusSchema>;

export const ExpiryStatusFilterSchema = z.enum(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED']);
export type ExpiryStatusFilter = z.infer<typeof ExpiryStatusFilterSchema>;

export function getTodayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getExpiryCutoffDate(today: string, expiringWithinDays: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + expiringWithinDays);
  return date.toISOString().slice(0, 10);
}

export interface ComputeExpiryStatusOptions {
  today?: string | undefined;
  expiringWithinDays?: number | undefined;
}

export function computeExpiryStatus(
  expDate: string | null | undefined,
  options: ComputeExpiryStatusOptions = {},
): ExpiryStatus {
  if (!expDate) {
    return 'NO_EXPIRY';
  }
  const today = options.today ?? getTodayUtcDate();
  if (expDate < today) {
    return 'EXPIRED';
  }
  const windowDays = options.expiringWithinDays ?? DEFAULT_EXPIRING_SOON_DAYS;
  const cutoff = getExpiryCutoffDate(today, windowDays);
  if (expDate <= cutoff) {
    return 'EXPIRING_SOON';
  }
  return 'ACTIVE';
}

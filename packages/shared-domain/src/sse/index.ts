import { z } from 'zod';

export const SSE_TOPICS = {
  CATALOG: 'catalog',
  LOCATIONS: 'locations',
  STOCK_BALANCES: 'stock-balances',
  STOCK_MOVEMENTS: 'stock-movements',
  PURCHASE_ORDERS: 'purchase-orders',
  SALES_ORDERS: 'sales-orders',
  TRANSFER_ORDERS: 'transfer-orders',
  SUPPLIERS: 'suppliers',
  CUSTOMERS: 'customers',
} as const;

export type SseTopic = (typeof SSE_TOPICS)[keyof typeof SSE_TOPICS] | (string & {});

export const SseInvalidateEventSchema = z.object({
  seqId: z.number().int().nonnegative(),
  topics: z.array(z.string()),
  locationIds: z.array(z.string()),
  skuIds: z.array(z.string()),
});

export type SseInvalidateEvent = z.infer<typeof SseInvalidateEventSchema>;

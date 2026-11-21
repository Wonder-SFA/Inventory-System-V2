import { describe, expect, it, vi } from 'vitest';
import {
  type EventSourceLike,
  createLiveInvalidationController,
} from './LiveInvalidationProvider';

class MockEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  public closed = false;

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('createLiveInvalidationController', () => {
  it('calls matching topic subscribers on invalidate events and ignores non-matching topics', () => {
    const source = new MockEventSource();
    const controller = createLiveInvalidationController({
      createEventSource: () => source,
    });

    const onCatalogRefresh = vi.fn();
    const onStockRefresh = vi.fn();

    const unsubCatalog = controller.subscribe(['catalog'], onCatalogRefresh);
    const unsubStock = controller.subscribe(['stock-balances', 'locations'], onStockRefresh);

    controller.connect();

    source.emit('invalidate', {
      data: JSON.stringify({
        seqId: 1,
        topics: ['stock-balances', 'stock-movements'],
        locationIds: ['loc-1'],
        skuIds: ['sku-1'],
      }),
    });

    expect(onStockRefresh).toHaveBeenCalledTimes(1);
    expect(onCatalogRefresh).not.toHaveBeenCalled();

    // Malformed payloads are ignored safely
    source.emit('invalidate', { data: 'not-json' });
    source.emit('invalidate', { data: JSON.stringify({ invalid: true }) });
    expect(onStockRefresh).toHaveBeenCalledTimes(1);

    unsubCatalog();
    unsubStock();
    controller.disconnect();
    expect(source.closed).toBe(true);
  });

  it('triggers one quiet refresh across active subscribers on reconnect (open after error)', () => {
    const source = new MockEventSource();
    const controller = createLiveInvalidationController({
      createEventSource: () => source,
    });

    const onCatalogRefresh = vi.fn();
    const onLocationsRefresh = vi.fn();

    controller.subscribe(['catalog'], onCatalogRefresh);
    controller.subscribe(['locations'], onLocationsRefresh);
    controller.connect();

    // Initial open does not trigger a reconnect refresh
    source.emit('open');
    expect(onCatalogRefresh).not.toHaveBeenCalled();
    expect(onLocationsRefresh).not.toHaveBeenCalled();

    // Simulate network drop -> reconnect
    source.emit('error');
    source.emit('open');
    expect(onCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(onLocationsRefresh).toHaveBeenCalledTimes(1);

    // Subsequent normal open without error does not double-trigger
    source.emit('open');
    expect(onCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(onLocationsRefresh).toHaveBeenCalledTimes(1);

    controller.disconnect();
  });
});

'use client';

import { SseInvalidateEventSchema } from '@iv2/shared-domain';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export type RefreshHandler = () => void | Promise<void>;

export interface LiveInvalidationController {
  connect(): void;
  disconnect(): void;
  subscribe(topics: readonly string[], onRefresh: RefreshHandler): () => void;
}

export interface CreateLiveInvalidationControllerOptions {
  url?: string | undefined;
  createEventSource?: ((url: string) => EventSourceLike) | undefined;
}

interface Subscriber {
  id: number;
  topics: Set<string>;
  onRefresh: RefreshHandler;
}

function invokeQuietly(handler: RefreshHandler): void {
  try {
    void Promise.resolve(handler()).catch(() => undefined);
  } catch {
    // Ignore synchronous errors from background refresh callbacks
  }
}

export function createLiveInvalidationController(
  options: CreateLiveInvalidationControllerOptions = {},
): LiveInvalidationController {
  const url = options.url ?? '/api/v1/events/stream';
  const createEventSource =
    options.createEventSource ??
    ((targetUrl: string) =>
      typeof EventSource !== 'undefined' ? new EventSource(targetUrl) : null);

  const subscribers = new Map<number, Subscriber>();
  let nextSubscriberId = 1;
  let source: EventSourceLike | null = null;
  let disconnectedSinceLastOpen = false;

  const handleOpen = () => {
    if (!disconnectedSinceLastOpen) {
      return;
    }
    disconnectedSinceLastOpen = false;
    for (const subscriber of [...subscribers.values()]) {
      invokeQuietly(subscriber.onRefresh);
    }
  };

  const handleError = () => {
    disconnectedSinceLastOpen = true;
  };

  const handleInvalidate = (event: { data?: string }) => {
    if (typeof event.data !== 'string') {
      return;
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = SseInvalidateEventSchema.safeParse(rawJson);
    if (!parsed.success) {
      return;
    }

    const incomingTopics = parsed.data.topics;
    for (const subscriber of [...subscribers.values()]) {
      const matches =
        subscriber.topics.has('*') ||
        incomingTopics.some((topic) => subscriber.topics.has(topic));
      if (matches) {
        invokeQuietly(subscriber.onRefresh);
      }
    }
  };

  return {
    connect() {
      if (source) {
        return;
      }
      const nextSource = createEventSource(url);
      if (!nextSource) {
        return;
      }
      source = nextSource;
      source.addEventListener('open', handleOpen);
      source.addEventListener('error', handleError);
      source.addEventListener('invalidate', handleInvalidate);
    },

    disconnect() {
      if (!source) {
        return;
      }
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('error', handleError);
      source.removeEventListener('invalidate', handleInvalidate);
      source.close();
      source = null;
      disconnectedSinceLastOpen = false;
    },

    subscribe(topics: readonly string[], onRefresh: RefreshHandler) {
      const id = nextSubscriberId++;
      subscribers.set(id, {
        id,
        topics: new Set(topics),
        onRefresh,
      });
      return () => {
        subscribers.delete(id);
      };
    },
  };
}

const LiveInvalidationContext = createContext<LiveInvalidationController | null>(null);

export function LiveInvalidationProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => createLiveInvalidationController(), []);

  useEffect(() => {
    controller.connect();
    return () => {
      controller.disconnect();
    };
  }, [controller]);

  return (
    <LiveInvalidationContext.Provider value={controller}>
      {children}
    </LiveInvalidationContext.Provider>
  );
}

export function useLiveRefresh(topics: readonly string[], onRefresh: RefreshHandler): void {
  const controller = useContext(LiveInvalidationContext);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const topicKey = topics.join('\0');

  useEffect(() => {
    if (!controller) {
      return;
    }
    const topicList = topicKey.length > 0 ? topicKey.split('\0') : [];
    return controller.subscribe(topicList, () => onRefreshRef.current());
  }, [controller, topicKey]);
}

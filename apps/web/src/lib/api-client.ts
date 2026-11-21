import type { ApiError, ApiPaginated, ApiSuccess } from '@iv2/shared-domain';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly requestId?: string | undefined;

  constructor(statusCode: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface ApiFetchOptions extends RequestInit {
  onUnauthorized?: (() => void) | undefined;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<ApiSuccess<T>> {
  const { onUnauthorized, headers: rawHeaders, method: rawMethod, body, ...rest } = options;
  const method = (rawMethod ?? 'GET').toUpperCase();
  const headers = new Headers(rawHeaders);

  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  if (MUTATING_METHODS.has(method) && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', crypto.randomUUID());
  }

  const response = await fetch(path, {
    ...rest,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    if (onUnauthorized) {
      onUnauthorized();
    } else if (typeof window !== 'undefined') {
      window.location.assign('/login');
    }
    throw new ApiClientError(401, 'UNAUTHENTICATED', 'Authentication required');
  }

  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as ApiSuccess<T> | ApiError) : null;

  if (!response.ok) {
    const errBody = parsed as ApiError | null;
    const code = errBody?.error?.code ?? 'API_ERROR';
    const message = errBody?.error?.message ?? `Request failed with status ${response.status}`;
    const requestId = errBody?.error?.requestId;
    throw new ApiClientError(response.status, code, message, requestId);
  }

  return parsed as ApiSuccess<T>;
}

export async function apiFetchPaginated<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<ApiPaginated<T>> {
  return (await apiFetch<T[]>(path, options)) as unknown as ApiPaginated<T>;
}

export interface SessionInfo {
  user: {
    id: string;
    email: string;
    name: string;
  };
  accessSwitch: 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED';
  permissions: {
    allLocations: boolean;
    canViewCosts: boolean;
  };
}

export async function fetchSession(onUnauthorized?: () => void): Promise<SessionInfo> {
  const res = await apiFetch<SessionInfo>('/api/v1/session', { onUnauthorized });
  return res.data;
}

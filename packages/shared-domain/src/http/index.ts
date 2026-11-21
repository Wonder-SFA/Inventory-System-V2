import { z } from 'zod';

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DECIMAL_PRECISION_EXCEEDED: 'DECIMAL_PRECISION_EXCEEDED',
  DECIMAL_OVERFLOW: 'DECIMAL_OVERFLOW',
  INVALID_DECIMAL_FORMAT: 'INVALID_DECIMAL_FORMAT',
  MISSING_IDEMPOTENCY_KEY: 'MISSING_IDEMPOTENCY_KEY',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  INVALID_CURSOR: 'INVALID_CURSOR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  ACCESS_READ_ONLY: 'ACCESS_READ_ONLY',
  ACCESS_SUSPENDED: 'ACCESS_SUSPENDED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  STALE_VERSION: 'STALE_VERSION',
  INVALID_ORDER_STATE: 'INVALID_ORDER_STATE',
  OVER_RECEIVE_CONFIRMATION_REQUIRED: 'OVER_RECEIVE_CONFIRMATION_REQUIRED',
  OVER_SHIP_NOT_ALLOWED: 'OVER_SHIP_NOT_ALLOWED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | (string & {});

export const ApiWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .catchall(z.unknown());

export type ApiWarning = z.infer<typeof ApiWarningSchema>;

export const ApiMetaSchema = z.object({
  requestId: z.string(),
});

export type ApiMeta = z.infer<typeof ApiMetaSchema>;

export const ApiPageSchema = z.object({
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type ApiPage = z.infer<typeof ApiPageSchema>;

export interface ApiSuccess<T> {
  data: T;
  warnings?: ApiWarning[] | undefined;
  meta: ApiMeta;
}

export function createApiSuccessSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    warnings: z.array(ApiWarningSchema).optional(),
    meta: ApiMetaSchema,
  });
}

export interface ApiPaginated<T> {
  data: T[];
  page: ApiPage;
  meta: ApiMeta;
}

export function createApiPaginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    page: ApiPageSchema,
    meta: ApiMetaSchema,
  });
}

export const ApiErrorDetailSchema = z.object({
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});

export type ApiErrorDetail = z.infer<typeof ApiErrorDetailSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(ApiErrorDetailSchema).optional(),
    requestId: z.string(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CursorPaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuerySchema>;

export class DomainError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: ApiErrorDetail[] | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: ApiErrorDetail[] | undefined,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class BadRequestError extends DomainError {
  constructor(code: ErrorCode, message: string, details?: ApiErrorDetail[] | undefined) {
    super(400, code, message, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(
    message = 'Authentication required',
    code: ErrorCode = ERROR_CODES.UNAUTHENTICATED,
  ) {
    super(401, code, message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(code: ErrorCode = ERROR_CODES.FORBIDDEN, message = 'Forbidden') {
    super(403, code, message);
  }
}

export class NotFoundError extends DomainError {
  constructor(code: ErrorCode, message: string) {
    super(404, code, message);
  }
}

export class ConflictError extends DomainError {
  constructor(code: ErrorCode, message: string, details?: ApiErrorDetail[] | undefined) {
    super(409, code, message, details);
  }
}

export class ValidationError extends DomainError {
  constructor(
    code: ErrorCode = ERROR_CODES.VALIDATION_ERROR,
    message = 'Validation failed',
    details?: ApiErrorDetail[] | undefined,
  ) {
    super(422, code, message, details);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message = 'Rate limit exceeded') {
    super(429, ERROR_CODES.RATE_LIMITED, message);
  }
}

import {
  type ApiError,
  type ApiErrorDetail,
  DECIMAL_PRECISION_EXCEEDED_CODE,
  DomainError,
  ERROR_CODES,
} from '@iv2/shared-domain';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

function formatFieldPath(instancePath: string): string | undefined {
  const cleaned = instancePath.replace(/^\//, '').replace(/\//g, '.');
  return cleaned.length > 0 ? cleaned : undefined;
}

function buildErrorEnvelope(
  requestId: string,
  code: string,
  message: string,
  details?: ApiErrorDetail[] | undefined,
): ApiError {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
      requestId,
    },
  };
}

export function apiErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const requestId = request.id;

  if (error instanceof DomainError) {
    return reply
      .status(error.statusCode)
      .send(buildErrorEnvelope(requestId, error.code, error.message, error.details));
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const details: ApiErrorDetail[] = error.validation.map((item) => {
      const issue = item.params?.issue as
        | { code?: string; params?: { code?: string }; message?: string }
        | undefined;
      const issueCode =
        typeof issue?.params?.code === 'string'
          ? issue.params.code
          : ERROR_CODES.VALIDATION_ERROR;
      const field = formatFieldPath(item.instancePath);
      return {
        ...(field !== undefined ? { field } : {}),
        code: issueCode,
        message: item.message ?? issue?.message ?? 'Validation error',
      };
    });

    const hasDecimalPrecisionExceeded = details.some(
      (d) => d.code === DECIMAL_PRECISION_EXCEEDED_CODE,
    );
    const topCode = hasDecimalPrecisionExceeded
      ? ERROR_CODES.DECIMAL_PRECISION_EXCEEDED
      : ERROR_CODES.VALIDATION_ERROR;
    const topMessage = hasDecimalPrecisionExceeded
      ? 'Input exceeds maximum 4 decimal places'
      : 'Request validation failed';

    return reply.status(422).send(buildErrorEnvelope(requestId, topCode, topMessage, details));
  }

  if (error instanceof ZodError) {
    const details: ApiErrorDetail[] = error.issues.map((issue) => {
      const customCode =
        issue.code === 'custom' && typeof issue.params?.code === 'string'
          ? issue.params.code
          : ERROR_CODES.VALIDATION_ERROR;
      const field = issue.path.length > 0 ? issue.path.join('.') : undefined;
      return {
        ...(field !== undefined ? { field } : {}),
        code: customCode,
        message: issue.message,
      };
    });

    const hasDecimalPrecisionExceeded = details.some(
      (d) => d.code === DECIMAL_PRECISION_EXCEEDED_CODE,
    );
    const topCode = hasDecimalPrecisionExceeded
      ? ERROR_CODES.DECIMAL_PRECISION_EXCEEDED
      : ERROR_CODES.VALIDATION_ERROR;

    return reply
      .status(422)
      .send(buildErrorEnvelope(requestId, topCode, 'Request validation failed', details));
  }

  const fastifyErr = error as FastifyError;

  if (fastifyErr.statusCode === 429) {
    return reply
      .status(429)
      .send(buildErrorEnvelope(requestId, ERROR_CODES.RATE_LIMITED, fastifyErr.message));
  }

  if (fastifyErr.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply
      .status(413)
      .send(buildErrorEnvelope(requestId, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB limit'));
  }

  if (fastifyErr.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply
      .status(400)
      .send(buildErrorEnvelope(requestId, 'INVALID_JSON', 'Malformed JSON request body'));
  }

  request.log.error(error, 'Unhandled API error');
  return reply
    .status(500)
    .send(
      buildErrorEnvelope(requestId, ERROR_CODES.INTERNAL_ERROR, 'An unexpected error occurred'),
    );
}

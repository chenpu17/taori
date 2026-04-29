/**
 * Error codes & classifications shared between sidecar and renderer.
 * Aligned with docs/architecture/08-api-contracts.md §11.
 */

export const ERROR_CODES = [
  'unauthorized',
  'validation_error',
  'not_found',
  'conflict',
  'provider_error',
  'keychain_error',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_CLASSIFICATIONS = [
  'quota',
  'rate_limit',
  'network',
  'content_filter',
  'auth',
  'config_error',
  'key_missing',
  'unknown',
] as const;
export type ErrorClassification = (typeof ERROR_CLASSIFICATIONS)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  provider_error: 502,
  keychain_error: 500,
  internal: 500,
};

export interface TaoriErrorBody {
  code: ErrorCode;
  message: string;
  classification?: ErrorClassification;
  can_retry?: boolean;
  /** Always sanitized: no API keys, no Authorization headers, no URL query strings. */
  details?: Record<string, unknown>;
}

export class TaoriError extends Error {
  readonly code: ErrorCode;
  readonly classification?: ErrorClassification;
  readonly canRetry: boolean;
  readonly details?: Record<string, unknown>;

  constructor(body: TaoriErrorBody) {
    super(body.message);
    this.code = body.code;
    this.classification = body.classification;
    this.canRetry = body.can_retry ?? false;
    this.details = body.details;
    this.name = 'TaoriError';
  }

  toBody(): TaoriErrorBody {
    return {
      code: this.code,
      message: this.message,
      classification: this.classification,
      can_retry: this.canRetry,
      details: this.details,
    };
  }
}

import type { ApiErrorCode } from '$lib/shared/contracts/api-error';

/** How an expected failure is presented to clients. Messages must not include paths, SQL, or process output. */
export type PublicError = {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export const requestInvalid: PublicError = { status: 400, code: 'request.invalid', message: 'The request is invalid.' };

export const requestCancelled: PublicError = {
  status: 499,
  code: 'request.cancelled',
  message: 'The request was cancelled.',
};

export const serviceUnavailable: PublicError = {
  status: 503,
  code: 'service.unavailable',
  message: 'Fern is shutting down. Try again shortly.',
};

export const databaseUnavailable: PublicError = {
  status: 503,
  code: 'database.unavailable',
  message: 'The library database is unavailable.',
};

export const internalError: PublicError = { status: 500, code: 'internal', message: 'Something went wrong.' };

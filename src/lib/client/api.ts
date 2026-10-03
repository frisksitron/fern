import { Option, Schema } from 'effect';
import { readApiError } from '$lib/shared/contracts/api-error';

/**
 * Calls one of Fern's API endpoints and returns the response body. A failed call throws the
 * server's public error message, or `failure` when the response carries none.
 */
export async function request(url: string, init: RequestInit, failure: string): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readApiError(body)?.message ?? failure);
  return body;
}

/**
 * `request`, decoding the body with the endpoint's contract. A body that does not match throws
 * `failure`, so users never see a validation message.
 */
export async function requestJson<S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  init: RequestInit,
  contract: S,
  failure: string,
): Promise<S['Type']> {
  const body = await request(url, init, failure);
  return Option.getOrThrowWith(Schema.decodeUnknownOption(contract)(body), () => new Error(failure));
}

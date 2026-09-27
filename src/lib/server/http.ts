import { randomUUID } from 'node:crypto';
import { error as kitError, redirect } from '@sveltejs/kit';
import { Cause, Data, Effect, Exit, type ManagedRuntime, Schema } from 'effect';
import type { ApiErrorBody } from '$lib/shared/contracts/api-error';
import { internalError, requestCancelled, serviceUnavailable, type PublicError } from './public-errors';
import { appRuntime, type AppServices } from './runtime';

/** The body was not JSON or did not match the endpoint's schema. */
export class RequestInvalid extends Data.TaggedError('RequestInvalid')<{ readonly cause: unknown }> {}

/** Decodes route parameters, query values, or a parsed body, failing with `RequestInvalid`. */
export function decodeInput<A, R>(
  input: unknown,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError, R>,
): Effect.Effect<A, RequestInvalid, R> {
  return Effect.mapError(decode(input), (cause) => new RequestInvalid({ cause }));
}

/** Parses and decodes a JSON body. */
export function readJsonBody<A, R>(
  request: Request,
  decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError, R>,
): Effect.Effect<A, RequestInvalid, R> {
  return Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: (cause) => new RequestInvalid({ cause }),
  }).pipe(Effect.flatMap((body) => decodeInput(body, decode)));
}

/**
 * Encodes a success body with its schema, so responses always match the published contract. A
 * mismatch is a defect: it is logged and the client receives a generic 500.
 */
export function jsonResponse<A, I>(schema: Schema.Codec<A, I>, value: A, init?: ResponseInit): Effect.Effect<Response> {
  return Schema.encodeEffect(schema)(value).pipe(
    Effect.orDie,
    Effect.map((body) => Response.json(body, init)),
  );
}

function errorResponse(error: PublicError): Response {
  const body: ApiErrorBody = { code: error.code, message: error.message };
  return Response.json(body, { status: error.status, headers: error.headers });
}

const requestIdPattern = /^[\w.-]{1,128}$/;

/** The caller's `x-request-id` when it is well formed, otherwise a new ID. */
function requestIdOf(request: Request) {
  const given = request.headers.get('x-request-id');
  return given && requestIdPattern.test(given) ? given : randomUUID();
}

type Outcome<A> =
  { readonly _tag: 'Success'; readonly value: A } | { readonly _tag: 'Unavailable'; readonly error: PublicError };

/**
 * Runs a request-bound program on the application runtime. The request's abort signal interrupts
 * it. Every log entry it writes carries the request ID, method, and path. Defects are logged with
 * their full cause and never reach the client; an interrupted request is not a server failure.
 */
async function execute<A, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  request: Request,
  requestId: string,
  program: Effect.Effect<A, never, R>,
): Promise<Outcome<A>> {
  const { pathname } = new URL(request.url);
  const exit = await runtime.runPromiseExit(
    program.pipe(
      Effect.tapCause((cause) =>
        Cause.hasDies(cause) ? Effect.logError('Unexpected failure handling a request', cause) : Effect.void,
      ),
      Effect.annotateLogs({ requestId, method: request.method, path: pathname }),
      Effect.withSpan('http.request', { attributes: { requestId, method: request.method, path: pathname } }),
    ),
    { signal: request.signal },
  );
  if (Exit.isSuccess(exit)) return { _tag: 'Success', value: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause))
    return { _tag: 'Unavailable', error: request.signal.aborted ? requestCancelled : serviceUnavailable };
  return { _tag: 'Unavailable', error: internalError };
}

/**
 * Maps a typed failure to its public error. Expected failures (4xx) are the client's business and
 * are not logged; failures the server should have handled (5xx) are logged as warnings.
 */
function mapFailure<E>(failure: (error: E) => PublicError) {
  return (error: E) => {
    const publicError = failure(error);
    const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : 'unknown';
    const log =
      publicError.status >= 500
        ? Effect.logWarning('Request failed').pipe(
            Effect.annotateLogs({ status: publicError.status, code: publicError.code, error: tag }),
          )
        : Effect.void;
    return Effect.as(log, publicError);
  };
}

function withRequestId(response: Response, requestId: string) {
  response.headers.set('x-request-id', requestId);
  return response;
}

type Handlers<A, E> = {
  readonly success: (value: A) => Response;
  readonly failure: (error: E) => PublicError;
};

/** `respond` on a given runtime, for tests. */
export async function respondOn<A, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  request: Request,
  program: Effect.Effect<A, E, R>,
  handlers: Handlers<A, E>,
): Promise<Response> {
  const requestId = requestIdOf(request);
  const outcome = await execute(
    runtime,
    request,
    requestId,
    program.pipe(
      Effect.map(handlers.success),
      Effect.catch((error) => Effect.map(mapFailure(handlers.failure)(error), errorResponse)),
    ),
  );
  return withRequestId(outcome._tag === 'Success' ? outcome.value : errorResponse(outcome.error), requestId);
}

/** Runs an API route program and maps its typed failures with an exhaustive `failure` mapping. */
export function respond<A, E>(
  request: Request,
  program: Effect.Effect<A, E, AppServices>,
  handlers: Handlers<A, E>,
): Promise<Response> {
  return respondOn(appRuntime, request, program, handlers);
}

/** How a page load presents a typed failure: a `303` redirect, or SvelteKit's error page. */
export type LoadFailure = { readonly redirect: string } | PublicError;

/**
 * Runs a page `load` program and returns its value. Typed failures are mapped with an exhaustive
 * `failure` mapping to a redirect or an error page; defects become a generic `500` error page.
 */
export async function runLoad<A, E>(
  request: Request,
  program: Effect.Effect<A, E, AppServices>,
  failure: (error: E) => LoadFailure,
): Promise<A> {
  const outcome = await execute(
    appRuntime,
    request,
    requestIdOf(request),
    program.pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => {
        const mapped = failure(error);
        const logged: Effect.Effect<LoadFailure> =
          'redirect' in mapped ? Effect.succeed(mapped) : mapFailure(() => mapped)(error);
        return Effect.map(logged, (presented) => ({ ok: false as const, failure: presented }));
      }),
    ),
  );
  if (outcome._tag === 'Unavailable') kitError(outcome.error.status, outcome.error.message);
  const result = outcome.value;
  if (result.ok) return result.value;
  if ('redirect' in result.failure) redirect(303, result.failure.redirect);
  kitError(result.failure.status, result.failure.message);
}

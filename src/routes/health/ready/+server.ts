import { Effect } from 'effect';
import { jsonResponse, respond } from '$lib/server/http';
import { Health } from '$lib/server/operations/health';
import { ReadinessResponse } from '$lib/shared/contracts/health';
import type { RequestHandler } from './$types';

/** Readiness: 200 when PostgreSQL answers, FFmpeg and ffprobe run, and the cache folders are writable, otherwise 503. */
export const GET: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const readiness = yield* Health.Service.use((health) => health.readiness());
      return yield* jsonResponse(ReadinessResponse, readiness, { status: readiness.status === 'ready' ? 200 : 503 });
    }),
    { success: (response) => response, failure: (error: never) => error },
  );

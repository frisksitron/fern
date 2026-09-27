import { Effect } from 'effect';
import { jsonResponse, respond } from '$lib/server/http';
import { Health } from '$lib/server/operations/health';
import { ReadinessResponse } from '$lib/shared/contracts/health';
import type { RequestHandler } from './$types';

/** Readiness: 200 when PostgreSQL answers and FFmpeg and ffprobe run, otherwise 503 with the failing checks. */
export const GET: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const readiness = yield* Health.use((health) => health.readiness);
      return yield* jsonResponse(ReadinessResponse, readiness, { status: readiness.status === 'ready' ? 200 : 503 });
    }),
    { success: (response) => response, failure: (error: never) => error },
  );

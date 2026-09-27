import { Effect } from 'effect';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import { jsonResponse, respond } from '$lib/server/http';
import { Health } from '$lib/server/operations/health';
import { databaseUnavailable } from '$lib/server/public-errors';
import { ScanDiagnostics } from '$lib/shared/contracts/health';
import type { RequestHandler } from './$types';

/** Why the active scan is queued, running, or retrying, and why recent scans failed. */
export const GET: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const diagnostics = yield* Health.use((health) => health.scanDiagnostics);
      return yield* jsonResponse(ScanDiagnostics, diagnostics, { headers: { 'cache-control': 'no-store' } });
    }),
    { success: (response) => response, failure: (_: DatabaseUnavailable) => databaseUnavailable },
  );

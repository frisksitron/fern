import { Effect, Schema } from 'effect';
import { jsonResponse, readJsonBody, respond } from '$lib/server/http';
import { scanFailure } from '$lib/server/scans/http';
import { Scans } from '$lib/server/scans/service';
import { ScanStatusResponse, StartScanRequest, StartScanResponse } from '$lib/shared/contracts/scans';
import type { RequestHandler } from './$types';

const decodeBody = Schema.decodeUnknownEffect(StartScanRequest);

export const GET: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const status = yield* Scans.Service.use((scans) => scans.status());
      return yield* jsonResponse(ScanStatusResponse, status);
    }),
    { success: (response) => response, failure: scanFailure },
  );

/** Starts scanning one media root, or every root without `rootId`. The scan continues in the background. */
export const POST: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const body = yield* readJsonBody(request, decodeBody);
      const scanId = yield* Scans.Service.use((scans) => scans.start(body.rootId ?? null));
      return yield* jsonResponse(StartScanResponse, { scanId }, { status: 202 });
    }),
    { success: (response) => response, failure: scanFailure },
  );

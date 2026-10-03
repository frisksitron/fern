import { Effect, Schema } from 'effect';
import { decodeInput, jsonResponse, respond } from '$lib/server/http';
import { scanFailure } from '$lib/server/scans/http';
import { Scans } from '$lib/server/scans/service';
import { ScanId } from '$lib/shared/contracts/ids';
import { ScanRun } from '$lib/shared/contracts/scans';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: ScanId }));

export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      const scan = yield* Scans.Service.use((scans) => scans.get(id));
      return yield* jsonResponse(ScanRun, scan);
    }),
    { success: (response) => response, failure: scanFailure },
  );

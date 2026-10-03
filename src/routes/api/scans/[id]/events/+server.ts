import { Effect, Schema, Stream } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { ScanEvents } from '$lib/server/scans/events';
import { scanFailure } from '$lib/server/scans/http';
import { Scans } from '$lib/server/scans/service';
import { isTerminalScanState } from '$lib/server/scans/state';
import { ScanId } from '$lib/shared/contracts/ids';
import { ScanRun, type ScanEvent } from '$lib/shared/contracts/scans';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: ScanId }));
const encodeScanRun = Schema.encodeSync(ScanRun);

const serverSentEvent = (type: string, data: unknown) => `event: ${type}
data: ${JSON.stringify(data)}

`;
const isTerminalEvent = (event: ScanEvent) => event.type === 'scan.completed' || event.type === 'scan.failed';

/** How often an open stream rereads the scan, in case it finished in another process. */
const RECHECK_INTERVAL = '5 seconds';

/** The event for a scan that has finished, built from its stored row. */
function terminalEvent(scan: ScanRun): ScanEvent {
  if (scan.state === 'failed')
    return { type: 'scan.failed', data: { state: 'failed', message: scan.errorSummary ?? 'The scan failed.' } };
  const { directoriesSeen, filesSeen, videosSeen, audioSeen, filesProbed, errorsCount } = scan;
  return {
    type: 'scan.completed',
    data: { state: 'completed', directoriesSeen, filesSeen, videosSeen, audioSeen, filesProbed, errorsCount },
  };
}

/**
 * Sends the scan's stored run as a `scan.snapshot` event, then its live events until it completes
 * or fails, and then closes. The subscription starts before the stored state is read, so a scan
 * that finishes in between is still reported. Live events come from the process running the scan;
 * rereading the row also ends the stream when another process ran it.
 */
function scanEventStream(id: ScanId) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* ScanEvents.Service.use((events) => events.subscribe(id));
      const scan = yield* Scans.Service.use((scans) => scans.get(id));
      const replay = Stream.make(serverSentEvent('scan.snapshot', encodeScanRun(scan)));
      if (isTerminalScanState(scan.state)) return replay;
      const finished = Stream.tick(RECHECK_INTERVAL).pipe(
        Stream.mapEffect(() => Scans.Service.use((scans) => scans.get(id))),
        Stream.filter((row) => isTerminalScanState(row.state)),
        Stream.map(terminalEvent),
      );
      return Stream.concat(
        replay,
        Stream.merge(live, finished).pipe(
          Stream.takeUntil(isTerminalEvent),
          Stream.map((event) => serverSentEvent(event.type, event.data)),
        ),
      );
    }),
  ).pipe(
    // If the database fails mid-stream, end the stream; EventSource reconnects on its own.
    Stream.catchCause(() => Stream.empty),
    Stream.encodeText,
  );
}

export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      yield* Scans.Service.use((scans) => scans.get(id));
      const body = yield* Stream.toReadableStreamEffect(scanEventStream(id));
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }),
    { success: (response) => response, failure: scanFailure },
  );

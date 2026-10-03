import { Schema } from 'effect';
import { MediaRootId, ScanId } from './ids';

/** `retrying`: an attempt failed and the scan waits for its next attempt. */
export const ScanState = Schema.Literals(['queued', 'running', 'retrying', 'completed', 'failed']);
export type ScanState = typeof ScanState.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ScanCounts = Schema.Struct({
  directoriesSeen: Count,
  filesSeen: Count,
  videosSeen: Count,
  audioSeen: Count,
  filesProbed: Count,
  errorsCount: Count,
});
export interface ScanCounts extends Schema.Schema.Type<typeof ScanCounts> {}

/** A `scan_runs` row as served by `GET /api/scans/:id`. */
export const ScanRun = Schema.Struct({
  id: ScanId,
  state: ScanState,
  /** The root being scanned, or null for every root. */
  rootId: Schema.NullOr(MediaRootId),
  requestedAt: Schema.DateFromString,
  startedAt: Schema.NullOr(Schema.DateFromString),
  completedAt: Schema.NullOr(Schema.DateFromString),
  currentRootId: Schema.NullOr(MediaRootId),
  currentPath: Schema.NullOr(Schema.String),
  ...ScanCounts.fields,
  errorSummary: Schema.NullOr(Schema.String),
  /** Delivery attempts started; more than one means the scan was retried. */
  attempts: Count,
});
export interface ScanRun extends Schema.Schema.Type<typeof ScanRun> {}

/** `POST /api/scans` body. Without `rootId`, every media root is scanned. */
export const StartScanRequest = Schema.Struct({ rootId: Schema.optionalKey(MediaRootId) });
export interface StartScanRequest extends Schema.Schema.Type<typeof StartScanRequest> {}

export const StartScanResponse = Schema.Struct({ scanId: ScanId });

/** `GET /api/scans`: the active scan, if any. */
export const ScanStatusResponse = Schema.Struct({ scan: Schema.NullOr(ScanRun) });
export interface ScanStatusResponse extends Schema.Schema.Type<typeof ScanStatusResponse> {}

/**
 * Live server-sent events from `GET /api/scans/:id/events`; `type` is the SSE event name. The stream
 * first sends `scan.snapshot` with the stored `ScanRun`, then these.
 */
export const ScanEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('scan.started'), data: Schema.Struct({ state: Schema.Literal('running') }) }),
  Schema.Struct({
    type: Schema.Literal('scan.progress'),
    data: Schema.Struct({
      state: Schema.Literal('running'),
      rootId: MediaRootId,
      currentDisplayPath: Schema.String,
      ...ScanCounts.fields,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('scan.warning'),
    data: Schema.Struct({ rootId: MediaRootId, message: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal('scan.completed'),
    data: Schema.Struct({ state: Schema.Literal('completed'), ...ScanCounts.fields }),
  }),
  Schema.Struct({
    type: Schema.Literal('scan.retrying'),
    data: Schema.Struct({ state: Schema.Literal('retrying'), message: Schema.String, attempts: Count }),
  }),
  Schema.Struct({
    type: Schema.Literal('scan.failed'),
    data: Schema.Struct({ state: Schema.Literal('failed'), message: Schema.String }),
  }),
]);
export type ScanEvent = typeof ScanEvent.Type;

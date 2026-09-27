import { Schema } from 'effect';
import { ScanRun } from './scans';

const CheckStatus = Schema.Literals(['ok', 'unavailable']);

/** `GET /health/ready`: 200 when every check passes, otherwise 503. */
export const ReadinessResponse = Schema.Struct({
  status: Schema.Literals(['ready', 'unavailable']),
  checks: Schema.Struct({ database: CheckStatus, ffmpeg: CheckStatus, ffprobe: CheckStatus }),
});
export type ReadinessResponse = typeof ReadinessResponse.Type;

/** A scan's delivery job, as stored in `scan_jobs`. */
export const ScanJobStatus = Schema.Struct({
  state: Schema.Literals(['pending', 'running', 'completed', 'failed']),
  attempts: Schema.Int,
  maxAttempts: Schema.Int,
  availableAt: Schema.DateFromString,
  lockedBy: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.DateFromString),
  lastError: Schema.NullOr(Schema.String),
});
export type ScanJobStatus = typeof ScanJobStatus.Type;

const DiagnosedScan = Schema.Struct({
  scan: ScanRun,
  job: Schema.NullOr(ScanJobStatus),
  /** Why the scan is in its state, in words. */
  explanation: Schema.String,
});
type DiagnosedScan = typeof DiagnosedScan.Type;

/** `GET /health/scans`: why the active scan is waiting or retrying, and why recent scans failed. */
export const ScanDiagnostics = Schema.Struct({
  /** Whether any process holds the scan worker lock, so queued scans will run. */
  workerLockHeld: Schema.Boolean,
  /** This process's scan worker. */
  worker: Schema.Struct({
    workerId: Schema.String,
    leader: Schema.Boolean,
    currentScanId: Schema.NullOr(Schema.String),
  }),
  activeScan: Schema.NullOr(DiagnosedScan),
  recentFailures: Schema.Array(DiagnosedScan),
});
export type ScanDiagnostics = typeof ScanDiagnostics.Type;

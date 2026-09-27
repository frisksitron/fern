import type { ScanJobStatus } from '$lib/shared/contracts/health';
import type { ScanRun } from '$lib/shared/contracts/scans';

/** The first line of a stored error, which names the failure without its stack. */
function headline(error: string | null) {
  return (
    error
      ?.split('\n')
      .find((line) => line.trim())
      ?.trim() ?? null
  );
}

/**
 * Why a scan is in its current state, from its row and its delivery job, for operators reading
 * `GET /health/scans`.
 */
export function explainScan(scan: ScanRun, job: ScanJobStatus | null, now: Date, workerLockHeld: boolean): string {
  if (scan.state === 'completed') return 'The scan completed.';
  if (scan.state === 'failed') {
    const detail = headline(job?.lastError ?? null);
    const attempts = job ? ` after ${job.attempts} of ${job.maxAttempts} attempts` : '';
    return `The scan failed${attempts}: ${scan.errorSummary ?? 'no reason was recorded.'}${detail ? ` (${detail})` : ''}`;
  }
  if (!job) return 'The scan has no delivery job.';
  if (job.state === 'running') {
    if (job.lockedUntil && job.lockedUntil.getTime() < now.getTime())
      return `The scan worker ${job.lockedBy} stopped renewing its lease at ${job.lockedUntil.toISOString()}; the next worker retries the scan.`;
    return `Running on ${job.lockedBy}, attempt ${job.attempts} of ${job.maxAttempts}.`;
  }
  if (job.state === 'pending') {
    const noWorker = workerLockHeld ? '' : ' No process holds the scan worker lock, so nothing will run it yet.';
    if (job.availableAt.getTime() > now.getTime()) {
      const reason = headline(job.lastError);
      return `Retrying at ${job.availableAt.toISOString()} (attempt ${job.attempts + 1} of ${job.maxAttempts})${reason ? ` after: ${reason}` : ''}.${noWorker}`;
    }
    return `Waiting for the scan worker to pick it up.${noWorker}`;
  }
  return `The scan is ${scan.state}, but its job already ${job.state}.`;
}

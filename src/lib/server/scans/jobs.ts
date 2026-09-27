import { Context, Duration } from 'effect';

/** How the scan queue retries, leases, polls, and cleans up. */
export type ScanQueuePolicy = {
  /** Attempts per scan, including the first. */
  readonly maxAttempts: number;
  /** Delay before the second attempt; each later retry waits twice as long, up to `retryMaxDelay`. */
  readonly retryBaseDelay: Duration.Input;
  readonly retryMaxDelay: Duration.Input;
  /** How often the worker looks for due jobs when nothing wakes it sooner. */
  readonly pollInterval: Duration.Input;
  /** How long a lease lasts without renewal. A crashed worker's scan is redelivered after this. */
  readonly lockExpiration: Duration.Input;
  /** How often a running scan renews its lease. Must be well under `lockExpiration`. */
  readonly lockRefreshInterval: Duration.Input;
  /** How often a process that is not the worker checks whether it can become the worker. */
  readonly leadershipRetryInterval: Duration.Input;
  /** How often the worker recovers jobs whose lease expired. */
  readonly maintenanceInterval: Duration.Input;
  /** How long finished jobs are kept. Scan history in `scan_runs` is kept regardless. */
  readonly completedRetention: Duration.Input;
  readonly failedRetention: Duration.Input;
  readonly cleanupInterval: Duration.Input;
};

export const defaultScanQueuePolicy: ScanQueuePolicy = {
  maxAttempts: 3,
  retryBaseDelay: '15 seconds',
  retryMaxDelay: '5 minutes',
  pollInterval: '2 seconds',
  lockExpiration: '1 minute',
  lockRefreshInterval: '15 seconds',
  leadershipRetryInterval: '10 seconds',
  maintenanceInterval: '30 seconds',
  completedRetention: '7 days',
  failedRetention: '30 days',
  cleanupInterval: '1 hour',
};

/** The queue policy. Production uses the defaults; tests shorten the intervals. */
export const ScanQueuePolicy = Context.Reference<ScanQueuePolicy>('fern/ScanQueuePolicy', {
  defaultValue: () => defaultScanQueuePolicy,
});

/** Bounded exponential backoff: the delay after `attempt` (1-based) failed attempts. */
export function retryDelayMs(attempt: number, policy: Pick<ScanQueuePolicy, 'retryBaseDelay' | 'retryMaxDelay'>) {
  const base = Duration.toMillis(policy.retryBaseDelay);
  return Math.min(Duration.toMillis(policy.retryMaxDelay), base * 2 ** Math.max(0, attempt - 1));
}

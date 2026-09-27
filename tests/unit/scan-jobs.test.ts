import { describe, expect, it } from 'vitest';
import { defaultScanQueuePolicy, retryDelayMs } from '../../src/lib/server/scans/jobs';

describe('retryDelayMs', () => {
  const policy = { retryBaseDelay: '10 seconds', retryMaxDelay: '1 minute' } as const;

  it('doubles the delay after each failed attempt, up to the maximum', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, policy))).toEqual([
      10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });

  it('keeps the default policy within a few minutes of retrying', () => {
    const delays = [1, 2].map((attempt) => retryDelayMs(attempt, defaultScanQueuePolicy));
    expect(delays).toEqual([15_000, 30_000]);
  });
});

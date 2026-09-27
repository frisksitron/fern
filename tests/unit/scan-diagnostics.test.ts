import { describe, expect, it } from 'vitest';
import { explainScan } from '../../src/lib/server/scans/diagnostics';
import type { ScanJobStatus } from '../../src/lib/shared/contracts/health';
import { ScanId } from '../../src/lib/shared/contracts/ids';
import type { ScanRun } from '../../src/lib/shared/contracts/scans';

const now = new Date('2026-09-26T12:00:00Z');
const later = new Date('2026-09-26T12:00:30Z');
const earlier = new Date('2026-09-26T11:59:00Z');

function scan(overrides: Partial<ScanRun> = {}): ScanRun {
  return {
    id: ScanId.make('11111111-1111-4111-8111-111111111111'),
    state: 'queued',
    rootId: null,
    requestedAt: earlier,
    startedAt: null,
    completedAt: null,
    currentRootId: null,
    currentPath: null,
    directoriesSeen: 0,
    filesSeen: 0,
    videosSeen: 0,
    audioSeen: 0,
    filesProbed: 0,
    errorsCount: 0,
    errorSummary: null,
    attempts: 0,
    ...overrides,
  };
}

function job(overrides: Partial<ScanJobStatus> = {}): ScanJobStatus {
  return {
    state: 'pending',
    attempts: 0,
    maxAttempts: 3,
    availableAt: earlier,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    ...overrides,
  };
}

describe('explainScan', () => {
  it('explains a queued scan, and warns when no process can run it', () => {
    expect(explainScan(scan(), job(), now, true)).toBe('Waiting for the scan worker to pick it up.');
    expect(explainScan(scan(), job(), now, false)).toContain('No process holds the scan worker lock');
  });

  it('explains a retrying scan with the next attempt and the error that caused it', () => {
    const retrying = explainScan(
      scan({ state: 'retrying', attempts: 1 }),
      job({ attempts: 1, availableAt: later, lastError: 'DatabaseUnavailable: connection reset\n    at stack' }),
      now,
      true,
    );
    expect(retrying).toBe(
      'Retrying at 2026-09-26T12:00:30.000Z (attempt 2 of 3) after: DatabaseUnavailable: connection reset.',
    );
  });

  it('explains a running scan and one whose worker stopped renewing its lease', () => {
    const running = job({ state: 'running', attempts: 1, lockedBy: 'nas:42:abcd', lockedUntil: later });
    expect(explainScan(scan({ state: 'running' }), running, now, true)).toBe('Running on nas:42:abcd, attempt 1 of 3.');
    expect(explainScan(scan({ state: 'running' }), { ...running, lockedUntil: earlier }, now, true)).toContain(
      'stopped renewing its lease',
    );
  });

  it('explains a failed scan with its attempts, summary, and error', () => {
    expect(
      explainScan(
        scan({ state: 'failed', errorSummary: 'The scan stopped unexpectedly.' }),
        job({ state: 'failed', attempts: 3, lastError: 'Error: scanner bug' }),
        now,
        true,
      ),
    ).toBe('The scan failed after 3 of 3 attempts: The scan stopped unexpectedly. (Error: scanner bug)');
  });
});

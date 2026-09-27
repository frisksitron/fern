import { randomUUID } from 'node:crypto';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/lib/server/db/service';
import { MediaProcessRunner, ProcessSpawnFailed, type ProcessRequest } from '../../src/lib/server/media/process-runner';
import { Health } from '../../src/lib/server/operations/health';
import { ScanWorker } from '../../src/lib/server/scans/worker';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Health, never> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate scan_runs cascade');
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

/** Health with a fake process runner where `missing` programs are not installed. */
function health(missing: readonly string[] = [], leader = false) {
  const runner = Layer.succeed(MediaProcessRunner, {
    run: (request: ProcessRequest) =>
      missing.includes(request.program)
        ? Effect.fail(new ProcessSpawnFailed({ program: request.program, cause: new Error('ENOENT') }))
        : Effect.succeed({ stdout: Buffer.alloc(0), stderr: '', durationMs: 1 }),
  });
  const worker = Layer.succeed(ScanWorker, {
    wake: Effect.void,
    status: Effect.succeed({ workerId: 'test-worker', leader, currentScanId: null }),
  });
  runtime = ManagedRuntime.make(
    Health.layerWithoutDependencies.pipe(Layer.provide(Layer.mergeAll(database.layer, runner, worker))),
  );
  return <A, E>(use: (service: Health['Service']) => Effect.Effect<A, E>) => runtime!.runPromise(Health.use(use));
}

describe('Health', () => {
  it('is ready when the database answers and FFmpeg and ffprobe run', async () => {
    const run = health();
    expect(await run((service) => service.readiness)).toEqual({
      status: 'ready',
      checks: { database: 'ok', ffmpeg: 'ok', ffprobe: 'ok' },
    });
  });

  it('is not ready when a media executable is missing', async () => {
    const run = health(['ffprobe']);
    expect(await run((service) => service.readiness)).toEqual({
      status: 'unavailable',
      checks: { database: 'ok', ffmpeg: 'ok', ffprobe: 'unavailable' },
    });
  });

  it('explains why the active scan is retrying and why recent scans failed', async () => {
    const retrying = randomUUID();
    const failed = randomUUID();
    await database.pool.query(
      `insert into scan_runs (id, state, attempts, error_summary) values ($1, 'retrying', 1, 'The library database became unavailable.')`,
      [retrying],
    );
    await database.pool.query(
      `insert into scan_jobs (scan_run_id, attempts, max_attempts, available_at, last_error)
       values ($1, 1, 3, now() + interval '1 minute', 'DatabaseUnavailable: connection reset')`,
      [retrying],
    );
    await database.pool.query(
      `insert into scan_runs (id, state, attempts, completed_at, error_summary) values ($1, 'failed', 3, now(), 'The scan stopped unexpectedly.')`,
      [failed],
    );

    const run = health();
    const diagnostics = await run((service) => service.scanDiagnostics);
    expect(diagnostics.workerLockHeld).toBe(false);
    expect(diagnostics.worker).toEqual({ workerId: 'test-worker', leader: false, currentScanId: null });
    expect(diagnostics.activeScan?.scan.id).toBe(retrying);
    expect(diagnostics.activeScan?.job).toMatchObject({ state: 'pending', attempts: 1 });
    expect(diagnostics.activeScan?.explanation).toMatch(
      /^Retrying at .* \(attempt 2 of 3\) after: DatabaseUnavailable: connection reset\. No process holds the scan worker lock/,
    );
    expect(diagnostics.recentFailures.map((item) => item.explanation)).toEqual([
      'The scan failed: The scan stopped unexpectedly.',
    ]);
  });

  it('sees the scan worker lock held by another session', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [0x6665726e]);
      const run = health();
      expect((await run((service) => service.scanDiagnostics)).workerLockHeld).toBe(true);
      await client.query('select pg_advisory_unlock($1)', [0x6665726e]);
    } finally {
      client.release();
    }
  });
});

import { randomUUID } from 'node:crypto';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database, DatabaseUnavailable } from '../../src/lib/server/db/service';
import { MediaProcessRunner } from '../../src/lib/server/media/process-runner';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { ScanEvents, type ScanEventEnvelope } from '../../src/lib/server/scans/events';
import { offerJobStatement } from '../../src/lib/server/scans/job-store';
import { ScanQueuePolicy, type ScanQueuePolicy as Policy } from '../../src/lib/server/scans/jobs';
import { loadScan, transitionScan } from '../../src/lib/server/scans/persistence';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { Scans } from '../../src/lib/server/scans/service';
import { isTerminalScanState } from '../../src/lib/server/scans/state';
import { ScanWorker } from '../../src/lib/server/scans/worker';
import { ScanId } from '../../src/lib/shared/contracts/ids';
import type { ScanState } from '../../src/lib/shared/contracts/scans';
import { testConfig } from '../support/config';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
const runtimes: ManagedRuntime.ManagedRuntime<Scans | ScanWorker, never>[] = [];
let published: ScanEventEnvelope[] = [];

const fastPolicy: Policy = {
  maxAttempts: 3,
  retryBaseDelay: '40 millis',
  retryMaxDelay: '1 second',
  pollInterval: '20 millis',
  lockExpiration: '300 millis',
  lockRefreshInterval: '50 millis',
  leadershipRetryInterval: '50 millis',
  maintenanceInterval: '0 millis',
  completedRetention: '1 day',
  failedRetention: '30 days',
  cleanupInterval: '0 millis',
};

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  published = [];
  await database.pool.query('truncate scan_runs, media_roots cascade');
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

type Attempt = (call: number) => Effect.Effect<void, DatabaseUnavailable>;

/** A scanner that follows the real one's state handling but runs `attempt` in place of scanning. */
function fakeScanner(attempt: Attempt = () => Effect.void) {
  const stats = { calls: [] as { scanId: string; at: number }[], active: 0, maxActive: 0 };
  const layer = Layer.effect(
    Scanner,
    Effect.gen(function* () {
      const db = yield* Database;
      return {
        run: (scanId: ScanId) =>
          Effect.gen(function* () {
            const scan = yield* loadScan(db, scanId);
            if (!scan || isTerminalScanState(scan.state as ScanState)) return;
            stats.calls.push({ scanId, at: performance.now() });
            stats.active++;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            yield* transitionScan(db, scanId, 'running', { startedAt: new Date(), errorSummary: null });
            yield* attempt(stats.calls.length).pipe(Effect.ensuring(Effect.sync(() => stats.active--)));
            yield* transitionScan(db, scanId, 'completed', { completedAt: new Date() });
          }),
      };
    }),
  );
  return { stats, layer };
}

const recordingEvents = Layer.succeed(ScanEvents, {
  publish: (scanId, event) => Effect.sync(() => void published.push({ scanId, event })),
  subscribe: () => Effect.succeed(Stream.empty),
});

/** Starts one Fern process: the Scans service and its scan worker. */
async function startProcess(scanner: Layer.Layer<Scanner, never, Database>, policy: Policy = fastPolicy) {
  const infrastructure = Layer.mergeAll(database.layer, recordingEvents, Layer.succeed(ScanQueuePolicy, policy));
  const layer = Scans.layerWithoutDependencies.pipe(
    Layer.provideMerge(ScanWorker.layerWithoutDependencies),
    Layer.provide(scanner),
    Layer.provide(infrastructure),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  await runtime.context();
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Scans | ScanWorker>) => runtime.runPromise(effect),
    start: (rootId: null = null) => runtime.runPromise(Scans.use((scans) => scans.start(rootId))),
    status: () => runtime.runPromise(ScanWorker.use((worker) => worker.status)),
    stop: async () => {
      runtimes.splice(runtimes.indexOf(runtime), 1);
      await runtime.dispose();
    },
  };
}

async function waitFor<A>(read: () => Promise<A>, done: (value: A) => boolean, timeoutMs = 10_000): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function scanRow(id: string) {
  const { rows } = await database.pool.query<{ state: string; attempts: number; error_summary: string | null }>(
    'select state, attempts, error_summary from scan_runs where id = $1',
    [id],
  );
  return rows[0];
}

async function jobRow(scanId: string) {
  const { rows } = await database.pool.query<{
    state: string;
    attempts: number;
    last_error: string | null;
    locked_until: Date | null;
  }>('select state, attempts, last_error, locked_until from scan_jobs where scan_run_id = $1', [scanId]);
  return rows[0];
}

const finished = (scanId: string) =>
  waitFor(
    () => scanRow(scanId),
    (row) => isTerminalScanState(row.state as never),
  );

async function insertScan(state: ScanState, id = randomUUID()) {
  await database.pool.query(`insert into scan_runs (id, state) values ($1, $2)`, [id, state]);
  return ScanId.make(id);
}

describe('scan delivery', () => {
  it('delivers an accepted scan once and admits one active scan at a time', async () => {
    const gate = Promise.withResolvers<void>();
    const scanner = fakeScanner(() => Effect.promise(() => gate.promise));
    const fern = await startProcess(scanner.layer);
    const scanId = await fern.start();
    await expect(fern.run(Effect.flip(Scans.use((scans) => scans.start(null))))).resolves.toMatchObject({
      _tag: 'ScanAlreadyRunning',
      scanId,
    });
    gate.resolve();
    expect(await finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
    expect(
      await waitFor(
        () => jobRow(scanId),
        (job) => job.state === 'completed',
      ),
    ).toMatchObject({ attempts: 1 });
    expect(scanner.stats.calls).toHaveLength(1);
  });

  it('offers each scan once', async () => {
    const scanId = await insertScan('queued');
    await database.query((db) => offerJobStatement(db, scanId, 3));
    await database.query((db) => offerJobStatement(db, scanId, 3));
    const { rows } = await database.pool.query('select scan_run_id from scan_jobs');
    expect(rows).toEqual([{ scan_run_id: scanId }]);
  });

  it('hands a scan back on graceful shutdown without using an attempt, and resumes it after restart', async () => {
    const stuck = fakeScanner(() => Effect.never);
    const first = await startProcess(stuck.layer);
    const scanId = await first.start();
    await waitFor(
      async () => stuck.stats.calls.length,
      (calls) => calls === 1,
    );
    await first.stop();
    expect(await scanRow(scanId)).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await jobRow(scanId)).toMatchObject({ state: 'pending', attempts: 0 });

    await startProcess(fakeScanner().layer);
    expect(await finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
  });

  it('keeps renewing the lease of a scan that outlasts the lock expiration', async () => {
    const scanner = fakeScanner(() => Effect.sleep('1 second'));
    const fern = await startProcess(scanner.layer);
    const scanId = await fern.start();
    const firstLease = (
      await waitFor(
        () => jobRow(scanId),
        (job) => job.locked_until !== null,
      )
    ).locked_until!;
    const renewed = await waitFor(
      () => jobRow(scanId),
      (job) => job.locked_until !== null && job.locked_until > firstLease,
    );
    expect(renewed.state).toBe('running');
    expect(await finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
    expect(scanner.stats.calls).toHaveLength(1);
  });

  it('redelivers the scan of a worker that crashed once its lease expires', async () => {
    const scanId = await insertScan('running');
    await database.pool.query(
      `insert into scan_jobs (scan_run_id, state, attempts, max_attempts, locked_by, locked_until)
       values ($1, 'running', 1, 3, 'crashed-worker', now() - interval '1 second')`,
      [scanId],
    );
    await startProcess(fakeScanner().layer);
    expect(await finished(scanId)).toMatchObject({ state: 'completed', attempts: 2 });
    expect(published.map((envelope) => envelope.event.type)).toContain('scan.retrying');
  });

  it('runs scans in one worker at a time across processes, and hands over when the worker stops', async () => {
    const scanner = fakeScanner(() => Effect.sleep('50 millis'));
    const first = await startProcess(scanner.layer);
    const second = await startProcess(scanner.layer);
    const leaders = await waitFor(
      async () => [(await first.status()).leader, (await second.status()).leader],
      (flags) => flags.includes(true),
    );
    expect(leaders.filter(Boolean)).toHaveLength(1);

    await finished(await first.start());
    await finished(await second.start());
    expect(scanner.stats.maxActive).toBe(1);

    const [leader, follower] = leaders[0] ? [first, second] : [second, first];
    await leader.stop();
    await waitFor(
      async () => (await follower.status()).leader,
      (isLeader) => isLeader,
    );
    expect(await finished(await follower.start())).toMatchObject({ state: 'completed' });
    expect(scanner.stats.calls).toHaveLength(3);
  });

  it('retries failed attempts with growing delays', async () => {
    const scanner = fakeScanner((call) =>
      call < 3 ? Effect.fail(new DatabaseUnavailable({ cause: new Error('connection reset') })) : Effect.void,
    );
    const fern = await startProcess(scanner.layer);
    const scanId = await fern.start();
    expect(await finished(scanId)).toMatchObject({ state: 'completed', attempts: 3, error_summary: null });
    const [first, second, third] = scanner.stats.calls.map((call) => call.at);
    expect(second - first).toBeGreaterThanOrEqual(35);
    expect(third - second).toBeGreaterThanOrEqual(75);
    expect(
      published.filter((envelope) => envelope.event.type === 'scan.retrying').map((envelope) => envelope.event.data),
    ).toEqual([
      {
        state: 'retrying',
        attempts: 1,
        message: 'The library database became unavailable. Retrying (attempt 2 of 3).',
      },
      {
        state: 'retrying',
        attempts: 2,
        message: 'The library database became unavailable. Retrying (attempt 3 of 3).',
      },
    ]);
  });

  it('fails the scan after its final attempt and keeps the error for operators', async () => {
    const scanner = fakeScanner(() => Effect.die(new Error('scanner bug')));
    const fern = await startProcess(scanner.layer);
    const scanId = await fern.start();
    expect(await finished(scanId)).toMatchObject({
      state: 'failed',
      attempts: 3,
      error_summary: 'The scan stopped unexpectedly.',
    });
    const job = await jobRow(scanId);
    expect(job).toMatchObject({ state: 'failed', attempts: 3 });
    expect(job.last_error).toContain('scanner bug');
    expect(scanner.stats.calls).toHaveLength(3);
    expect(published.at(-1)?.event).toEqual({
      type: 'scan.failed',
      data: { state: 'failed', message: 'The scan stopped unexpectedly.' },
    });
  });

  it('completes a redelivered job for a scan that already finished without scanning again', async () => {
    const scanId = await insertScan('completed');
    await database.pool.query(`update scan_runs set completed_at = '2026-01-01' where id = $1`, [scanId]);
    await database.query((db) => offerJobStatement(db, scanId, 3));
    // The real scanner, with nothing it could scan.
    const scanner = Scanner.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.mergeAll(
          testConfig({}),
          recordingEvents,
          FileSystem.layer,
          Layer.succeed(MediaProcessRunner, { run: () => Effect.die('no process expected') }),
        ),
      ),
    );
    await startProcess(scanner);
    expect(
      await waitFor(
        () => jobRow(scanId),
        (job) => job.state === 'completed',
      ),
    ).toMatchObject({ attempts: 1 });
    const { rows } = await database.pool.query('select state, completed_at from scan_runs where id = $1', [scanId]);
    expect(rows[0]).toEqual({ state: 'completed', completed_at: new Date('2026-01-01') });
  });

  it('removes finished jobs after their retention but keeps the scan history', async () => {
    const jobs: [string, string][] = [
      ['completed', '2 days'],
      ['completed', '1 hour'],
      ['failed', '40 days'],
      ['failed', '10 days'],
    ];
    const ids: string[] = [];
    for (const [state, age] of jobs) {
      const scanId = await insertScan(state as ScanState);
      ids.push(scanId);
      await database.pool.query(
        `insert into scan_jobs (scan_run_id, state, attempts, max_attempts, finished_at)
         values ($1, $2, 1, 3, now() - $3::interval)`,
        [scanId, state, age],
      );
    }
    await startProcess(fakeScanner().layer);
    const remaining = await waitFor(
      async () => (await database.pool.query<{ scan_run_id: string }>('select scan_run_id from scan_jobs')).rows,
      (rows) => rows.length === 2,
    );
    expect(remaining.map((row) => row.scan_run_id).sort()).toEqual([ids[1], ids[3]].sort());
    expect((await database.pool.query('select id from scan_runs')).rowCount).toBe(4);
  });
});

import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Clock, Context, Deferred, Effect, Exit, Layer, Schedule, Scope, Stream } from 'effect';
import { SqlClient } from 'effect/sql';
import { Database, DatabaseUnavailable } from '../../src/lib/server/db/service';
import { MediaProbe } from '../../src/lib/server/media/probe';
import { Disk } from '../../src/lib/server/platform/disk';
import { ScanEvents, type ScanEventEnvelope } from '../../src/lib/server/scans/events';
import { offerJobStatement } from '../../src/lib/server/scans/job-store';
import { ScanQueuePolicy } from '../../src/lib/server/scans/jobs';
import { loadScan, transitionScan } from '../../src/lib/server/scans/persistence';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { Scans } from '../../src/lib/server/scans/service';
import { isTerminalScanState } from '../../src/lib/server/scans/state';
import { ScanWorker } from '../../src/lib/server/scans/worker';
import { ScanId } from '../../src/lib/shared/contracts/ids';
import type { ScanState } from '../../src/lib/shared/contracts/scans';
import { testConfig } from '../support/config';
import { TestDatabase } from './support/database';

const fastPolicy: ScanQueuePolicy = {
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

type Attempt = (call: number) => Effect.Effect<void, DatabaseUnavailable>;

/** A scanner that follows the real one's state handling but runs `attempt` in place of scanning. */
function fakeScanner(attempt: Attempt = () => Effect.void) {
  const stats = { calls: [] as { scanId: string; at: number }[], active: 0, maxActive: 0 };
  const layer = Layer.effect(
    Scanner.Service,
    Effect.gen(function* () {
      const db = yield* Database.Service;
      return Scanner.Service.of({
        run: Effect.fnUntraced(function* (scanId: ScanId) {
          const scan = yield* loadScan(db, scanId);
          if (!scan || isTerminalScanState(scan.state as ScanState)) return;
          stats.calls.push({ scanId, at: yield* Clock.currentTimeMillis });
          stats.active++;
          stats.maxActive = Math.max(stats.maxActive, stats.active);
          yield* transitionScan(db, scanId, 'running', { startedAt: new Date(), errorSummary: null });
          yield* attempt(stats.calls.length).pipe(Effect.ensuring(Effect.sync(() => stats.active--)));
          yield* transitionScan(db, scanId, 'completed', { completedAt: new Date() });
        }),
      });
    }),
  );
  return { stats, layer };
}

/** Scan events, recorded instead of delivered. */
function recordingEvents() {
  const published: ScanEventEnvelope[] = [];
  const layer = Layer.succeed(
    ScanEvents.Service,
    ScanEvents.Service.of({
      publish: (scanId, event) => Effect.sync(() => void published.push({ scanId, event })),
      subscribe: () => Effect.succeed(Stream.empty),
    }),
  );
  return { published, layer };
}

/**
 * Starts one Fern process on the block's database: the Scans service and its scan worker, each
 * process with its own instances. It stops with `stop`, or when the test ends.
 */
const startProcess = Effect.fnUntraced(function* (
  scanner: Layer.Layer<Scanner.Service, never, Database.Service>,
  events: Layer.Layer<ScanEvents.Service>,
  policy: ScanQueuePolicy = fastPolicy,
) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const process = Scans.layer.pipe(
    Layer.provideMerge(ScanWorker.layer),
    Layer.provide(scanner),
    Layer.provide(Layer.mergeAll(events, Layer.succeed(ScanQueuePolicy, policy))),
  );
  const context = yield* Layer.buildWithScope(Layer.fresh(process), scope);
  return {
    scans: Context.get(context, Scans.Service),
    worker: Context.get(context, ScanWorker.Service),
    stop: Scope.close(scope, Exit.void),
  };
});

/** Rereads `read` until `done` holds. */
const waitFor = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ schedule: Schedule.spaced('20 millis'), until: done }),
    Effect.timeoutOrElse({ duration: '10 seconds', orElse: () => Effect.die(new Error('Timed out waiting')) }),
  );

const scanRow = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
    attempts: number;
    error_summary: string | null;
  }>`select state, attempts, error_summary from scan_runs where id = ${id}`;
  return row;
});

const jobRow = Effect.fnUntraced(function* (scanId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
    attempts: number;
    last_error: string | null;
    locked_until: Date | null;
  }>`select state, attempts, last_error, locked_until from scan_jobs where scan_run_id = ${scanId}`;
  return row;
});

const finished = (scanId: string) => waitFor(scanRow(scanId), (row) => isTerminalScanState(row.state as ScanState));

const insertScan = Effect.fnUntraced(function* (state: ScanState) {
  const sql = yield* SqlClient.SqlClient;
  const id = ScanId.make(randomUUID());
  yield* sql`insert into scan_runs (id, state) values (${id}, ${state})`;
  return id;
});

const reset = TestDatabase.truncate('scan_runs', 'media_roots');

layer(TestDatabase.layer, { excludeTestServices: true })('scan delivery', (it) => {
  it.effect('delivers an accepted scan once and admits one active scan at a time', () =>
    Effect.gen(function* () {
      yield* reset;
      const gate = yield* Deferred.make<void>();
      const scanner = fakeScanner(() => Deferred.await(gate));
      const fern = yield* startProcess(scanner.layer, recordingEvents().layer);
      const scanId = yield* fern.scans.start(null);
      expect(yield* Effect.flip(fern.scans.start(null))).toMatchObject({ _tag: 'ScanAlreadyRunning', scanId });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
      expect(yield* waitFor(jobRow(scanId), (job) => job.state === 'completed')).toMatchObject({ attempts: 1 });
      expect(scanner.stats.calls).toHaveLength(1);
    }),
  );

  it.effect('offers each scan once', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const db = yield* Database.Service;
      const scanId = yield* insertScan('queued');
      yield* offerJobStatement(db, scanId, 3);
      yield* offerJobStatement(db, scanId, 3);
      expect(yield* sql`select scan_run_id from scan_jobs`).toEqual([{ scan_run_id: scanId }]);
    }),
  );

  it.effect('hands a scan back on graceful shutdown without using an attempt, and resumes it after restart', () =>
    Effect.gen(function* () {
      yield* reset;
      const events = recordingEvents();
      const stuck = fakeScanner(() => Effect.never);
      const first = yield* startProcess(stuck.layer, events.layer);
      const scanId = yield* first.scans.start(null);
      yield* waitFor(
        Effect.sync(() => stuck.stats.calls.length),
        (calls) => calls === 1,
      );
      yield* first.stop;
      expect(yield* scanRow(scanId)).toMatchObject({ state: 'queued', attempts: 0 });
      expect(yield* jobRow(scanId)).toMatchObject({ state: 'pending', attempts: 0 });

      yield* startProcess(fakeScanner().layer, events.layer);
      expect(yield* finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
    }),
  );

  it.effect('keeps renewing the lease of a scan that outlasts the lock expiration', () =>
    Effect.gen(function* () {
      yield* reset;
      const scanner = fakeScanner(() => Effect.sleep('1 second'));
      const fern = yield* startProcess(scanner.layer, recordingEvents().layer);
      const scanId = yield* fern.scans.start(null);
      const leased = yield* waitFor(jobRow(scanId), (job) => job.locked_until !== null);
      const firstLease = leased.locked_until!;
      const renewed = yield* waitFor(
        jobRow(scanId),
        (job) => job.locked_until !== null && job.locked_until > firstLease,
      );
      expect(renewed.state).toBe('running');
      expect(yield* finished(scanId)).toMatchObject({ state: 'completed', attempts: 1 });
      expect(scanner.stats.calls).toHaveLength(1);
    }),
  );

  it.effect('redelivers the scan of a worker that crashed once its lease expires', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const events = recordingEvents();
      const scanId = yield* insertScan('running');
      yield* sql`insert into scan_jobs (scan_run_id, state, attempts, max_attempts, locked_by, locked_until)
        values (${scanId}, 'running', 1, 3, 'crashed-worker', now() - interval '1 second')`;
      yield* startProcess(fakeScanner().layer, events.layer);
      expect(yield* finished(scanId)).toMatchObject({ state: 'completed', attempts: 2 });
      expect(events.published.map((envelope) => envelope.event.type)).toContain('scan.retrying');
    }),
  );

  it.effect('runs scans in one worker at a time across processes, and hands over when the worker stops', () =>
    Effect.gen(function* () {
      yield* reset;
      const events = recordingEvents();
      const scanner = fakeScanner(() => Effect.sleep('50 millis'));
      const first = yield* startProcess(scanner.layer, events.layer);
      const second = yield* startProcess(scanner.layer, events.layer);
      const leaders = yield* waitFor(
        Effect.all([first.worker.status(), second.worker.status()]).pipe(
          Effect.map((statuses) => statuses.map((status) => status.leader)),
        ),
        (flags) => flags.includes(true),
      );
      expect(leaders.filter(Boolean)).toHaveLength(1);

      yield* finished(yield* first.scans.start(null));
      yield* finished(yield* second.scans.start(null));
      expect(scanner.stats.maxActive).toBe(1);

      const [leader, follower] = leaders[0] ? [first, second] : [second, first];
      yield* leader.stop;
      yield* waitFor(
        Effect.map(follower.worker.status(), (status) => status.leader),
        (isLeader) => isLeader,
      );
      expect(yield* finished(yield* follower.scans.start(null))).toMatchObject({ state: 'completed' });
      expect(scanner.stats.calls).toHaveLength(3);
    }),
  );

  it.effect('retries failed attempts with growing delays', () =>
    Effect.gen(function* () {
      yield* reset;
      const events = recordingEvents();
      const scanner = fakeScanner((call) =>
        call < 3 ? Effect.fail(new DatabaseUnavailable({ cause: new Error('connection reset') })) : Effect.void,
      );
      const fern = yield* startProcess(scanner.layer, events.layer);
      const scanId = yield* fern.scans.start(null);
      expect(yield* finished(scanId)).toMatchObject({ state: 'completed', attempts: 3, error_summary: null });
      const [first, second, third] = scanner.stats.calls.map((call) => call.at);
      expect(second - first).toBeGreaterThanOrEqual(35);
      expect(third - second).toBeGreaterThanOrEqual(75);
      expect(
        events.published
          .filter((envelope) => envelope.event.type === 'scan.retrying')
          .map((envelope) => envelope.event.data),
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
    }),
  );

  it.effect('fails the scan after its final attempt and keeps the error for operators', () =>
    Effect.gen(function* () {
      yield* reset;
      const events = recordingEvents();
      const scanner = fakeScanner(() => Effect.die(new Error('scanner bug')));
      const fern = yield* startProcess(scanner.layer, events.layer);
      const scanId = yield* fern.scans.start(null);
      expect(yield* finished(scanId)).toMatchObject({
        state: 'failed',
        attempts: 3,
        error_summary: 'The scan stopped unexpectedly.',
      });
      const job = yield* jobRow(scanId);
      expect(job).toMatchObject({ state: 'failed', attempts: 3 });
      expect(job.last_error).toContain('scanner bug');
      expect(scanner.stats.calls).toHaveLength(3);
      expect(events.published.at(-1)?.event).toEqual({
        type: 'scan.failed',
        data: { state: 'failed', message: 'The scan stopped unexpectedly.' },
      });
    }),
  );

  it.effect('completes a redelivered job for a scan that already finished without scanning again', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const db = yield* Database.Service;
      const events = recordingEvents();
      const scanId = yield* insertScan('completed');
      yield* sql`update scan_runs set completed_at = '2026-01-01' where id = ${scanId}`;
      yield* offerJobStatement(db, scanId, 3);
      // The real scanner, with nothing it could scan.
      const scanner = Scanner.layer.pipe(
        Layer.provide(Layer.mergeAll(testConfig({}), events.layer, Disk.layer, Layer.mock(MediaProbe.Service, {}))),
      );
      yield* startProcess(scanner, events.layer);
      expect(yield* waitFor(jobRow(scanId), (job) => job.state === 'completed')).toMatchObject({ attempts: 1 });
      expect(yield* sql`select state, completed_at from scan_runs where id = ${scanId}`).toEqual([
        { state: 'completed', completed_at: new Date('2026-01-01') },
      ]);
    }),
  );

  it.effect('removes finished jobs after their retention but keeps the scan history', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const jobs: [ScanState, string][] = [
        ['completed', '2 days'],
        ['completed', '1 hour'],
        ['failed', '40 days'],
        ['failed', '10 days'],
      ];
      const ids: string[] = [];
      for (const [state, age] of jobs) {
        const scanId = yield* insertScan(state);
        ids.push(scanId);
        yield* sql`insert into scan_jobs (scan_run_id, state, attempts, max_attempts, finished_at)
          values (${scanId}, ${state}, 1, 3, now() - ${age}::interval)`;
      }
      yield* startProcess(fakeScanner().layer, recordingEvents().layer);
      const remaining = yield* waitFor(
        sql<{ scan_run_id: string }>`select scan_run_id from scan_jobs`,
        (rows) => rows.length === 2,
      );
      expect(remaining.map((row) => row.scan_run_id).sort()).toEqual([ids[1], ids[3]].sort());
      expect(yield* sql`select id from scan_runs`).toHaveLength(4);
    }),
  );
});

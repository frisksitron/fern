import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Context, Effect, Exit, Fiber, FileSystem, Layer, Schedule, Scope, Stream } from 'effect';
import { MediaProcess, type ProcessRequest } from '../../src/lib/server/media/process';

// Node stands in for FFmpeg: each test scripts the process behavior it needs.
const nodeProcess = MediaProcess.layerFor(
  { ffmpeg: process.execPath, ffprobe: process.execPath, 'yt-dlp': process.execPath },
  { killGrace: '300 millis' },
).pipe(Layer.provide(NodeServices.layer));

const script = (source: string, options: Partial<ProcessRequest> = {}): ProcessRequest => ({
  program: 'ffmpeg',
  args: ['-e', source],
  timeout: '10 seconds',
  ...options,
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A script that records its pid in a scoped temporary directory and then runs until killed. */
const longRunning = Effect.fnUntraced(function* (prelude = '') {
  const fs = yield* FileSystem.FileSystem;
  const pidFile = path.join(yield* fs.makeTempDirectoryScoped({ prefix: 'fern-process-' }), 'pid');
  const source = `${prelude}require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const pid = fs.readFileString(pidFile).pipe(
    Effect.filterOrFail((text) => text.length > 0),
    Effect.map(Number),
    Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 100 }),
    Effect.orDie,
  );
  return { source, pid };
});

layer(Layer.mergeAll(nodeProcess, NodeServices.layer), { excludeTestServices: true })('MediaProcess', (it) => {
  it.effect('collects stdout and the stderr tail from a successful run', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const output = yield* media.run(
        script('process.stdout.write("frames"); process.stderr.write("warning");', { maxStdoutBytes: 1024 }),
      );
      expect(output.stdout.toString()).toBe('frames');
      expect(output.stderr).toBe('warning');
      expect(output.durationMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect('streams stdout line by line', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const lines = yield* Stream.runCollect(
        media.lines(
          script('process.stdout.write("first\\nsec"); setTimeout(() => process.stdout.write("ond\\nlast"), 50);'),
        ),
      );
      expect(lines).toEqual(['first', 'second', 'last']);
    }),
  );

  it.effect('fails a line stream when the program exits with an error', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const error = yield* Stream.runDrain(
        media.lines(script('console.log("partial"); process.stderr.write("broken"); process.exit(2);')),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessExited', code: 2, stderr: 'broken' });
    }),
  );

  it.effect('terminates a line stream that exceeds its timeout', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const task = yield* longRunning();
      const error = yield* Stream.runDrain(media.lines(script(task.source, { timeout: '1 second' }))).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessTimedOut', timeoutMs: 1000 });
      expect(isAlive(yield* task.pid)).toBe(false);
    }),
  );

  it.effect('reports a non-zero exit with its code and stderr', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const error = yield* media
        .run(script('process.stderr.write("broken input"); process.exit(3);'))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessExited', program: 'ffmpeg', code: 3, stderr: 'broken input' });
    }),
  );

  it.effect('does not pass Fern�s secrets on to the process', () =>
    Effect.gen(function* () {
      process.env.FERN_TEST_SECRET = 'hunter2';
      const names = yield* MediaProcess.Service.use((media) =>
        media.run(
          script('process.stdout.write(JSON.stringify(Object.keys(process.env)));', { maxStdoutBytes: 65_536 }),
        ),
      ).pipe(
        Effect.provide(MediaProcess.layerFor({ ffmpeg: process.execPath, ffprobe: '', 'yt-dlp': '' })),
        Effect.map((output) => JSON.parse(output.stdout.toString()) as string[]),
        Effect.ensuring(Effect.sync(() => delete process.env.FERN_TEST_SECRET)),
      );
      expect(names).not.toContain('FERN_TEST_SECRET');
      expect(names.map((name) => name.toUpperCase())).toContain('PATH');
    }),
  );

  it.effect('reports a missing executable as a spawn failure', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-process-' });
      const missing = MediaProcess.layerFor({
        ffmpeg: path.join(directory, 'missing-ffmpeg'),
        ffprobe: path.join(directory, 'missing-ffprobe'),
        'yt-dlp': path.join(directory, 'missing-yt-dlp'),
      });
      const error = yield* MediaProcess.Service.use((media) => media.run(script(''))).pipe(
        Effect.provide(missing),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: 'ProcessSpawnFailed', program: 'ffmpeg' });
    }),
  );

  it.effect('terminates a process that exceeds its timeout', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const task = yield* longRunning();
      const error = yield* media.run(script(task.source, { timeout: '1 second' })).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessTimedOut', timeoutMs: 1000 });
      expect(isAlive(yield* task.pid)).toBe(false);
    }),
  );

  it.effect('terminates a process whose stdout exceeds the limit', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const error = yield* media
        .run(script('process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000);', { maxStdoutBytes: 1000 }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessOutputTooLarge', limitBytes: 1000 });
    }),
  );

  it.effect('terminates the process when the run is interrupted', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const task = yield* longRunning();
      const fiber = yield* Effect.forkChild(media.run(script(task.source)));
      const pid = yield* task.pid;
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(isAlive(pid)).toBe(false);
    }),
  );

  it.effect.skipIf(process.platform === 'win32')('escalates to SIGKILL when SIGTERM is ignored', () =>
    Effect.gen(function* () {
      const media = yield* MediaProcess.Service;
      const task = yield* longRunning("process.on('SIGTERM', () => {}); ");
      const error = yield* media.run(script(task.source, { timeout: '500 millis' })).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProcessTimedOut' });
      expect(isAlive(yield* task.pid)).toBe(false);
    }),
  );

  it.effect('terminates running processes when the layer is released', () =>
    Effect.gen(function* () {
      const task = yield* longRunning();
      const scope = yield* Scope.make();
      const media = Context.get(yield* Layer.buildWithScope(Layer.fresh(nodeProcess), scope), MediaProcess.Service);
      yield* Effect.forkDetach(media.run(script(task.source)));
      const pid = yield* task.pid;
      yield* Scope.close(scope, Exit.void);
      expect(isAlive(pid)).toBe(false);
    }),
  );
});

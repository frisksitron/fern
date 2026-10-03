import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaProcessRunner, type ProcessRequest } from '../../src/lib/server/media/process-runner';

// Node stands in for FFmpeg: each test scripts the process behavior it needs.
const nodeRunner = MediaProcessRunner.layerFor(
  { ffmpeg: process.execPath, ffprobe: process.execPath, 'yt-dlp': process.execPath },
  { killGrace: '300 millis' },
);

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'fern-process-'));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const script = (source: string, options: Partial<ProcessRequest> = {}): ProcessRequest => ({
  program: 'ffmpeg',
  args: ['-e', source],
  timeout: '10 seconds',
  ...options,
});

const run = (request: ProcessRequest, layer = nodeRunner) =>
  Effect.runPromise(
    Effect.result(
      Effect.provide(
        MediaProcessRunner.use((runner) => runner.run(request)),
        layer,
      ),
    ),
  );

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A script that records its pid and then runs until killed. */
function longRunning(name: string, prelude = '') {
  const pidFile = path.join(directory, `${name}.pid`);
  const source = `${prelude}require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const pid = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await readFile(pidFile, 'utf8').catch(() => '');
      if (value) return Number(value);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('process never started');
  };
  return { source, pid };
}

describe('MediaProcessRunner', () => {
  it('collects stdout and the stderr tail from a successful run', async () => {
    const result = await run(
      script('process.stdout.write("frames"); process.stderr.write("warning"); ', { maxStdoutBytes: 1024 }),
    );
    expect(result._tag).toBe('Success');
    if (result._tag !== 'Success') return;
    expect(result.success.stdout.toString()).toBe('frames');
    expect(result.success.stderr).toBe('warning');
    expect(result.success.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('streams stdout to onStdout as it arrives instead of collecting it', async () => {
    const chunks: Buffer[] = [];
    const result = await run(
      script('process.stdout.write("x".repeat(200000));', { onStdout: (chunk) => chunks.push(chunk) }),
    );
    expect(result._tag).toBe('Success');
    if (result._tag !== 'Success') return;
    expect(result.success.stdout.length).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('x'.repeat(200000));
  });

  it('dies and terminates the process when onStdout throws', async () => {
    const task = longRunning('stdout-throws');
    const result = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          MediaProcessRunner.use((runner) =>
            runner.run(
              script(`${task.source} process.stdout.write("frames");`, {
                onStdout: () => {
                  throw new Error('unreadable');
                },
              }),
            ),
          ),
          nodeRunner,
        ),
      ),
    );
    expect(Exit.isFailure(result) && Exit.hasDies(result)).toBe(true);
    expect(isAlive(await task.pid())).toBe(false);
  });

  it('reports a non-zero exit with its code and stderr', async () => {
    const result = await run(script('process.stderr.write("broken input"); process.exit(3);'));
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProcessExited', program: 'ffmpeg', code: 3, stderr: 'broken input' },
    });
  });

  it('reports a missing executable as a spawn failure', async () => {
    const missing = MediaProcessRunner.layerFor({
      ffmpeg: path.join(directory, 'missing-ffmpeg'),
      ffprobe: path.join(directory, 'missing-ffprobe'),
      'yt-dlp': path.join(directory, 'missing-yt-dlp'),
    });
    expect(await run(script(''), missing)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProcessSpawnFailed', program: 'ffmpeg' },
    });
  });

  it('terminates a process that exceeds its timeout', async () => {
    const task = longRunning('timeout');
    const result = await run(script(task.source, { timeout: '1 second' }));
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ProcessTimedOut', timeoutMs: 1000 } });
    expect(isAlive(await task.pid())).toBe(false);
  });

  it('terminates a process whose stdout exceeds the limit', async () => {
    const result = await run(
      script('process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000);', {
        maxStdoutBytes: 1000,
      }),
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ProcessOutputTooLarge', limitBytes: 1000 } });
  });

  it('terminates the process when the run is interrupted', async () => {
    const task = longRunning('interrupt');
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(MediaProcessRunner.use((runner) => runner.run(script(task.source))));
        yield* Effect.promise(() => task.pid());
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(nodeRunner)),
    );
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(isAlive(await task.pid())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const task = longRunning('stubborn', "process.on('SIGTERM', () => {}); ");
    const result = await run(script(task.source, { timeout: '500 millis' }));
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ProcessTimedOut' } });
    expect(isAlive(await task.pid())).toBe(false);
  });

  it('terminates running processes when the runner layer is released', async () => {
    const task = longRunning('shutdown');
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(nodeRunner, scope);
        const runner = Context.get(context, MediaProcessRunner);
        yield* Effect.forkDetach(runner.run(script(task.source)));
        yield* Effect.promise(() => task.pid());
        yield* Scope.close(scope, Exit.void);
      }),
    );
    expect(isAlive(await task.pid())).toBe(false);
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Cause, Clock, Context, Data, Duration, Effect, Exit, Layer, Option } from 'effect';
import { FernConfig } from '$lib/server/config';

/** The only programs Fern runs. Callers name a program; the runner owns the executable paths. */
export type MediaProgram = 'ffmpeg' | 'ffprobe';

export class ProcessSpawnFailed extends Data.TaggedError('ProcessSpawnFailed')<{
  readonly program: MediaProgram;
  readonly cause: unknown;
}> {}

export class ProcessExited extends Data.TaggedError('ProcessExited')<{
  readonly program: MediaProgram;
  readonly code: number | null;
  readonly signal: string | null;
  /** The end of stderr, for logs. Never return it to clients. */
  readonly stderr: string;
}> {}

export class ProcessTimedOut extends Data.TaggedError('ProcessTimedOut')<{
  readonly program: MediaProgram;
  readonly timeoutMs: number;
}> {}

export class ProcessOutputTooLarge extends Data.TaggedError('ProcessOutputTooLarge')<{
  readonly program: MediaProgram;
  readonly limitBytes: number;
}> {}

/** Interruption is not a failure value: an interrupted run's process is terminated by its finalizer. */
export type ProcessError = ProcessSpawnFailed | ProcessExited | ProcessTimedOut | ProcessOutputTooLarge;

export type ProcessRequest = {
  readonly program: MediaProgram;
  readonly args: ReadonlyArray<string>;
  /** After this long the process is terminated and the run fails with `ProcessTimedOut`. */
  readonly timeout: Duration.Input;
  /** Collects stdout up to this many bytes; more terminates the process. Omit to discard stdout. */
  readonly maxStdoutBytes?: number;
};

type ProcessOutput = {
  readonly stdout: Buffer;
  /** The last 16 KiB of stderr. */
  readonly stderr: string;
  readonly durationMs: number;
};

type RunnerOptions = {
  /** How long a process may take to exit after SIGTERM before it is sent SIGKILL. */
  readonly killGrace?: Duration.Input;
};

const stderrTailBytes = 16_384;

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

const awaitExit = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (hasExited(child)) return resume(Effect.void);
    const exited = () => resume(Effect.void);
    child.once('exit', exited);
    return Effect.sync(() => child.off('exit', exited));
  });

/** SIGTERM, then SIGKILL if the process is still running after the grace period. */
function terminate(child: ChildProcess, grace: Duration.Input) {
  return Effect.gen(function* () {
    if (child.pid === undefined || hasExited(child)) return;
    child.kill('SIGTERM');
    if (Option.isSome(yield* awaitExit(child).pipe(Effect.timeoutOption(grace)))) return;
    child.kill('SIGKILL');
    if (Option.isNone(yield* awaitExit(child).pipe(Effect.timeoutOption(grace))))
      yield* Effect.logWarning('Media process did not exit after SIGKILL').pipe(
        Effect.annotateLogs({ pid: child.pid }),
      );
  });
}

/** Resolves a program name to an executable, following Scoop shims on Windows so kills reach FFmpeg itself. */
function resolveExecutable(command: string) {
  if (process.platform !== 'win32') return command;
  const candidates =
    command.includes('/') || command.includes('\\')
      ? [command]
      : (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, `${command}.exe`));
  for (const executable of candidates) {
    if (!existsSync(executable)) continue;
    const shim = executable.replace(/\.exe$/i, '.shim');
    if (!existsSync(shim)) return executable;
    const target = /^path\s*=\s*"([^"]+)"/m.exec(readFileSync(shim, 'utf8'))?.[1];
    return target && existsSync(target) ? target : executable;
  }
  return command;
}

/** Runs FFmpeg and ffprobe. No other module spawns processes. */
export class MediaProcessRunner extends Context.Service<
  MediaProcessRunner,
  { readonly run: (request: ProcessRequest) => Effect.Effect<ProcessOutput, ProcessError> }
>()('fern/MediaProcessRunner') {
  /**
   * A runner for the given executables. Every process it starts is terminated when its run is
   * interrupted or times out, and any still running are terminated when the layer's scope closes.
   */
  static layerFor(executables: Readonly<Record<MediaProgram, string>>, options: RunnerOptions = {}) {
    return Layer.effect(this, makeRunner(executables, options));
  }

  /** Uses `FFMPEG_PATH` and `FFPROBE_PATH`. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* FernConfig;
      return MediaProcessRunner.layerFor({
        ffmpeg: resolveExecutable(config.FFMPEG_PATH),
        ffprobe: resolveExecutable(config.FFPROBE_PATH),
      });
    }),
  );
}

const makeRunner = (executables: Readonly<Record<MediaProgram, string>>, options: RunnerOptions) =>
  Effect.gen(function* () {
    const grace = options.killGrace ?? Duration.seconds(2);
    const live = new Set<ChildProcess>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...live], (child) => terminate(child, grace), { concurrency: 'unbounded', discard: true }),
    );

    const execute = (request: ProcessRequest) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const spawned = spawn(executables[request.program], [...request.args], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', request.maxStdoutBytes === undefined ? 'ignore' : 'pipe', 'pipe'],
              });
              live.add(spawned);
              spawned.once('exit', () => live.delete(spawned));
              return spawned;
            }),
            (spawned) => terminate(spawned, grace).pipe(Effect.ensuring(Effect.sync(() => live.delete(spawned)))),
          );

          return yield* Effect.callback<{ stdout: Buffer; stderr: string }, ProcessError>((resume) => {
            const stdout: Buffer[] = [];
            let stdoutBytes = 0;
            let stderr = '';
            child.stdout?.on('data', (chunk: Buffer) => {
              stdoutBytes += chunk.length;
              if (request.maxStdoutBytes !== undefined && stdoutBytes > request.maxStdoutBytes) {
                resume(
                  Effect.fail(
                    new ProcessOutputTooLarge({ program: request.program, limitBytes: request.maxStdoutBytes }),
                  ),
                );
                return;
              }
              stdout.push(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              stderr = `${stderr}${chunk.toString()}`.slice(-stderrTailBytes);
            });
            child.once('error', (cause) =>
              resume(Effect.fail(new ProcessSpawnFailed({ program: request.program, cause }))),
            );
            child.once('close', (code, signal) =>
              resume(
                code === 0
                  ? Effect.succeed({ stdout: Buffer.concat(stdout), stderr })
                  : Effect.fail(new ProcessExited({ program: request.program, code, signal, stderr: stderr.trim() })),
              ),
            );
          });
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: request.timeout,
          orElse: () =>
            Effect.fail(
              new ProcessTimedOut({ program: request.program, timeoutMs: Duration.toMillis(request.timeout) }),
            ),
        }),
      );

    const run = (request: ProcessRequest): Effect.Effect<ProcessOutput, ProcessError> =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const result = yield* Effect.exit(execute(request));
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        const exitCode = Exit.isFailure(result) ? exitCodeOf(result.cause) : 0;
        yield* Effect.logDebug('Media process finished').pipe(
          Effect.annotateLogs({ program: request.program, durationMs, outcome: describe(result), exitCode }),
        );
        return Exit.isSuccess(result) ? { ...result.value, durationMs } : yield* Effect.failCause(result.cause);
      }).pipe(Effect.withSpan('media.process', { attributes: { program: request.program } }));

    return { run };
  });

/** The process's exit code, when it exited on its own with one. */
function exitCodeOf(cause: Cause.Cause<ProcessError>) {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && failure.value._tag === 'ProcessExited' ? failure.value.code : null;
}

/** The exit category recorded for each process: `ok`, a failure tag, `interrupted`, or `defect`. */
function describe(result: Exit.Exit<unknown, ProcessError>) {
  if (Exit.isSuccess(result)) return 'ok';
  const failure = Cause.findErrorOption(result.cause);
  if (Option.isSome(failure)) return failure.value._tag;
  return Cause.hasInterruptsOnly(result.cause) ? 'interrupted' : 'defect';
}

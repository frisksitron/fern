import { NodeServices } from '@effect/platform-node';
import { Cause, Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { FernConfig } from '$lib/server/config';

/** The only programs Fern runs. Callers name a program; this module owns the executable paths. */
export const MediaProgram = Schema.Literals(['ffmpeg', 'ffprobe', 'yt-dlp']);
export type MediaProgram = typeof MediaProgram.Type;

export class ProcessSpawnFailed extends Schema.TaggedError<ProcessSpawnFailed>()('ProcessSpawnFailed', {
  program: MediaProgram,
  cause: Schema.Defect(),
}) {}

export class ProcessExited extends Schema.TaggedError<ProcessExited>()('ProcessExited', {
  program: MediaProgram,
  /** Null when a signal ended the process. */
  code: Schema.NullOr(Schema.Number),
  /** The end of stderr, for logs. Never return it to clients. */
  stderr: Schema.String,
}) {}

export class ProcessTimedOut extends Schema.TaggedError<ProcessTimedOut>()('ProcessTimedOut', {
  program: MediaProgram,
  timeoutMs: Schema.Number,
}) {}

export class ProcessOutputTooLarge extends Schema.TaggedError<ProcessOutputTooLarge>()('ProcessOutputTooLarge', {
  program: MediaProgram,
  limitBytes: Schema.Number,
}) {}

/** Interruption is not a failure value: an interrupted run's process is terminated by its finalizer. */
export const ProcessError = Schema.Union([ProcessSpawnFailed, ProcessExited, ProcessTimedOut, ProcessOutputTooLarge]);
export type ProcessError = typeof ProcessError.Type;

export type ProcessRequest = {
  readonly program: MediaProgram;
  readonly args: ReadonlyArray<string>;
  /** After this long the process is terminated and the run fails with `ProcessTimedOut`. */
  readonly timeout: Duration.Input;
  /** Collects stdout up to this many bytes; more terminates the process. Omit to discard stdout. */
  readonly maxStdoutBytes?: number;
};

export type ProcessOutput = {
  readonly stdout: Buffer;
  /** The last 16 KiB of stderr. */
  readonly stderr: string;
  readonly durationMs: number;
};

export interface Interface {
  /** Runs a program to completion. */
  readonly run: (request: ProcessRequest) => Effect.Effect<ProcessOutput, ProcessError>;
  /**
   * Runs a program and emits its stdout as it arrives, for output too big to hold. The stream fails
   * like `run` when the program fails or times out.
   */
  readonly stdout: (request: Omit<ProcessRequest, 'maxStdoutBytes'>) => Stream.Stream<Uint8Array, ProcessError>;
  /** `stdout` line by line, for progress to follow. */
  readonly lines: (request: Omit<ProcessRequest, 'maxStdoutBytes'>) => Stream.Stream<string, ProcessError>;
}

/** Runs FFmpeg, ffprobe, and yt-dlp. No other module spawns processes. */
export class Service extends Context.Service<Service, Interface>()('@fern/MediaProcess') {}

export type Executables = Readonly<Record<MediaProgram, string>>;

type Options = {
  /** How long a process may take to exit after SIGTERM before it is sent SIGKILL. */
  readonly killGrace?: Duration.Input;
  /** The environment every process gets. Defaults to `childEnvironment` of Fern's own. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

/** Variables these tools need, matched case-insensitively (Windows spells `Path` and `SystemRoot` its own way). */
const CHILD_ENVIRONMENT_NAMES = new Set([
  ...['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA'],
  ...['TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'LANG', 'TZ'],
  // yt-dlp reaches YouTube through these.
  ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'],
  // Hardware encoders look up drivers through the loader path.
  'LD_LIBRARY_PATH',
]);
const CHILD_ENVIRONMENT_PREFIXES = ['LC_', 'XDG_', 'LIBVA_', 'NVIDIA_', 'CUDA_', 'ONEVPL_', 'VPL_', 'MFX_'];

/**
 * The part of an environment that FFmpeg, ffprobe, and yt-dlp may see. Everything else, such as
 * `DATABASE_URL`, stays out: yt-dlp runs JavaScript it downloads from YouTube.
 */
export function childEnvironment(source: Readonly<Record<string, string | undefined>>) {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (CHILD_ENVIRONMENT_NAMES.has(key) || CHILD_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)))
      environment[name] = value;
  }
  return environment;
}

const STDERR_TAIL_CHARACTERS = 16_384;

/**
 * Runs the given executables. Requires a `ChildProcessSpawner`. Every process is terminated when
 * its run ends, is interrupted, or times out, and any still running when the layer is released.
 */
export const layerFor = (executables: Executables, options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const layerScope = yield* Effect.scope;
      const forceKillAfter = options.killGrace ?? Duration.seconds(2);
      const env = options.environment ?? childEnvironment(process.env);

      /**
       * Starts a program in a scope that closes with the caller's scope or the layer's, whichever
       * closes first, so releasing the runtime stops processes started by requests still running.
       */
      const spawn = Effect.fnUntraced(function* (program: MediaProgram, args: ReadonlyArray<string>, stdout: boolean) {
        const scope = yield* Scope.fork(layerScope);
        yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
        return yield* spawner
          .spawn(
            ChildProcess.make(executables[program], args, {
              stdin: 'ignore',
              stdout: stdout ? 'pipe' : 'ignore',
              stderr: 'pipe',
              windowsHide: true,
              env,
              forceKillAfter,
            }),
          )
          .pipe(
            Scope.provide(scope),
            Effect.mapError((cause) => new ProcessSpawnFailed({ program, cause })),
          );
      });

      const timedOut = (request: Omit<ProcessRequest, 'maxStdoutBytes'>) =>
        new ProcessTimedOut({ program: request.program, timeoutMs: Duration.toMillis(request.timeout) });

      const execute = Effect.fnUntraced(
        function* (request: ProcessRequest) {
          const handle = yield* spawn(request.program, request.args, request.maxStdoutBytes !== undefined);
          const [stdout, stderr, code] = yield* Effect.all(
            [collectStdout(request, handle), stderrTail(handle), exitCode(handle)],
            { concurrency: 'unbounded' },
          );
          if (code !== 0) return yield* new ProcessExited({ program: request.program, code, stderr: stderr.trim() });
          return { stdout, stderr };
        },
        Effect.scoped,
        (effect, request) =>
          Effect.timeoutOrElse(effect, { duration: request.timeout, orElse: () => Effect.fail(timedOut(request)) }),
      );

      const run = Effect.fn('MediaProcess.run')(function* (request: ProcessRequest) {
        yield* Effect.annotateCurrentSpan({ program: request.program });
        const started = yield* Clock.currentTimeMillis;
        const result = yield* Effect.exit(execute(request));
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        yield* Effect.logDebug('Media process finished').pipe(
          Effect.annotateLogs({
            program: request.program,
            durationMs,
            outcome: outcomeOf(result),
            exitCode: exitCodeOf(result),
          }),
        );
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        return { ...result.value, durationMs };
      });

      const stdout = (request: Omit<ProcessRequest, 'maxStdoutBytes'>): Stream.Stream<Uint8Array, ProcessError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const handle = yield* spawn(request.program, request.args, true);
            const stderr = yield* Effect.forkScoped(stderrTail(handle));
            const finished = Effect.gen(function* () {
              const code = yield* exitCode(handle);
              if (code !== 0)
                return yield* new ProcessExited({
                  program: request.program,
                  code,
                  stderr: (yield* Fiber.join(stderr)).trim(),
                });
            });
            return handle.stdout.pipe(Stream.orDie, Stream.concat(Stream.fromEffectDrain(finished)));
          }),
        ).pipe(
          Stream.merge(
            Stream.fromEffectDrain(Effect.sleep(request.timeout).pipe(Effect.andThen(Effect.fail(timedOut(request))))),
            {
              haltStrategy: 'left',
            },
          ),
        );

      const lines = (request: Omit<ProcessRequest, 'maxStdoutBytes'>) =>
        stdout(request).pipe(Stream.decodeText(), Stream.splitLines);

      return Service.of({ run, stdout, lines });
    }),
  );

/** Uses `FFMPEG_PATH`, `FFPROBE_PATH`, and `YTDLP_PATH`. Requires a `ChildProcessSpawner`. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    return layerFor({ ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH, 'yt-dlp': config.YTDLP_PATH });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(NodeServices.layer), Layer.provide(FernConfig.defaultLayer));

type Handle = ChildProcessSpawner.ChildProcessHandle;

/** Collects stdout, failing as soon as it exceeds the request's limit. */
function collectStdout(request: ProcessRequest, handle: Handle) {
  const limit = request.maxStdoutBytes;
  return handle.stdout.pipe(
    Stream.orDie,
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (collected, chunk) => {
        collected.bytes += chunk.length;
        if (limit !== undefined && collected.bytes > limit)
          return Effect.fail(new ProcessOutputTooLarge({ program: request.program, limitBytes: limit }));
        collected.chunks.push(chunk);
        return Effect.succeed(collected);
      },
    ),
    Effect.map((collected) => Buffer.concat(collected.chunks)),
  );
}

/** The last 16 KiB of stderr. Reading a pipe that breaks is a defect. */
function stderrTail(handle: Handle) {
  return handle.stderr.pipe(
    Stream.orDie,
    Stream.decodeText(),
    Stream.runFold(
      () => '',
      (tail, text) => `${tail}${text}`.slice(-STDERR_TAIL_CHARACTERS),
    ),
  );
}

/** The process's exit code, or null when a signal ended it. */
function exitCode(handle: Handle) {
  return handle.exitCode.pipe(
    Effect.map((code): number | null => code),
    Effect.orElseSucceed(() => null),
  );
}

/** The exit category recorded for each process: `ok`, a failure tag, `interrupted`, or `defect`. */
function outcomeOf(result: Exit.Exit<unknown, ProcessError>) {
  if (Exit.isSuccess(result)) return 'ok';
  const failure = Cause.findErrorOption(result.cause);
  if (Option.isSome(failure)) return failure.value._tag;
  return Cause.hasInterruptsOnly(result.cause) ? 'interrupted' : 'defect';
}

/** The process's exit code, when it exited on its own with one. */
function exitCodeOf(result: Exit.Exit<unknown, ProcessError>) {
  if (Exit.isSuccess(result)) return 0;
  const failure = Cause.findErrorOption(result.cause);
  return Option.isSome(failure) && failure.value._tag === 'ProcessExited' ? failure.value.code : null;
}

export * as MediaProcess from './process';

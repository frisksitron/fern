import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from 'effect';
import { FernConfig } from '$lib/server/config';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcessRunner, type ProcessError } from '$lib/server/media/process-runner';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import { HlsSessionId, type MediaEntryId } from '$lib/shared/contracts/ids';
import { HlsSessionMetadata } from '$lib/shared/contracts/playback';
import { HlsFileNotFound, MediaChanged, TranscodeFailed, TranscodeTimedOut } from './errors';

type Accelerator = 'nvenc' | 'qsv' | 'software';

const SEGMENT_DURATION_SECONDS = 6;
/** Part of every session key: bump it to invalidate cached segments after changing encoding. */
const CACHE_VERSION = 'v4';
const SEGMENT_TIMEOUT = '30 seconds';
const DETECTION_TIMEOUT = '20 seconds';
/** How long a segment request may wait for a transcode slot. */
const MAX_SEGMENT_WAIT = '20 seconds';
/** Sessions served within this window are never evicted from the cache. */
const ACTIVE_SESSION_WINDOW_MS = 10 * 60_000;
/** Cache eviction walks every session directory, so it runs at most this often. */
const CACHE_SWEEP_INTERVAL = '1 minute';

const sessionPattern = /^[a-f0-9]{64}$/;
const filePattern = /^[a-zA-Z0-9._-]+$/;
const segmentPattern = /^segment-(\d{5})\.ts$/;

const decodeSessionMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(HlsSessionMetadata));

function sessionKey(metadata: HlsSessionMetadata) {
  return createHash('sha256')
    .update(
      `${metadata.mediaId}:${metadata.size}:${metadata.mtimeMs}:${metadata.audioStream}:${metadata.accelerator}:${CACHE_VERSION}`,
    )
    .digest('hex');
}

/** A VOD playlist of 6-second segments, each a separately encoded MPEG-TS file. */
export function manifest(durationMs: number) {
  const count = Math.ceil(durationMs / (SEGMENT_DURATION_SECONDS * 1000));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION_SECONDS}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let index = 0; index < count; index++) {
    const remaining = durationMs / 1000 - index * SEGMENT_DURATION_SECONDS;
    lines.push(
      `#EXTINF:${Math.min(SEGMENT_DURATION_SECONDS, remaining).toFixed(3)},`,
      `segment-${String(index).padStart(5, '0')}.ts`,
    );
    if (index < count - 1) lines.push('#EXT-X-DISCONTINUITY');
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

function videoEncoderArgs(accelerator: Accelerator, threads: number) {
  if (accelerator === 'nvenc')
    return ['-vf', 'format=nv12', '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'];
  if (accelerator === 'qsv')
    return ['-vf', 'format=nv12', '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-threads', String(threads)];
}

// Cache I/O failures (a full or missing disk) are not expected in normal operation: they are defects.
const io = <A>(run: () => Promise<A>) => Effect.orDie(Effect.tryPromise({ try: run, catch: (cause) => cause }));
const exists = (file: string) =>
  Effect.promise(() =>
    stat(file).then(
      () => true,
      () => false,
    ),
  );
const removeQuietly = (file: string) => Effect.promise(() => rm(file, { recursive: true, force: true }));

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(file) : (await stat(file)).size;
  }
  return total;
}

/**
 * On-demand HLS: sessions, segments, hardware encoder selection, and the segment cache. All state
 * lives in this service, and its FFmpeg work is owned by the runtime.
 */
export class Transcoding extends Context.Service<Transcoding>()('fern/Transcoding', {
  make: Effect.gen(function* () {
    const config = yield* FernConfig;
    const runner = yield* MediaProcessRunner;
    const library = yield* MediaLibrary;
    const cacheDirectory = config.HLS_CACHE_DIR;

    const segments = yield* makeSharedWork<TranscodeFailed | TranscodeTimedOut | CapacityExceeded>();
    const sessions = yield* makeSharedWork<never>();
    const capacity = yield* makeCapacity({
      concurrency: config.MAX_CONCURRENT_TRANSCODES,
      maxWaiting: config.TRANSCODE_MAX_WAITING,
      maxWait: MAX_SEGMENT_WAIT,
    });
    const recentlyServed = new Map<string, number>();

    // Hardware encoder selection. A hardware encoder that fails is never used again by this process.
    const failedAccelerators = new Set<Accelerator>();
    let selected: Accelerator | null = null;
    const detectionLock = yield* Semaphore.make(1);

    const detectAccelerator = Effect.gen(function* () {
      const configured = config.TRANSCODE_ACCELERATOR;
      const candidates: Accelerator[] =
        configured === 'auto' ? ['nvenc', 'qsv'] : configured === 'software' ? [] : [configured];
      for (const candidate of candidates) {
        if (failedAccelerators.has(candidate)) continue;
        const probe = yield* Effect.result(
          runner.run({
            program: 'ffmpeg',
            args: [
              '-hide_banner',
              '-loglevel',
              'error',
              '-f',
              'lavfi',
              '-i',
              'color=size=256x256:rate=1',
              '-frames:v',
              '1',
              '-an',
              ...videoEncoderArgs(candidate, config.TRANSCODE_THREADS),
              '-f',
              'null',
              '-',
            ],
            timeout: DETECTION_TIMEOUT,
          }),
        );
        if (probe._tag === 'Success') {
          yield* Effect.logInfo('Using hardware transcoding').pipe(Effect.annotateLogs({ accelerator: candidate }));
          return candidate;
        }
        failedAccelerators.add(candidate);
      }
      if (candidates.length) yield* Effect.logWarning('Could not initialize hardware transcoding; using software');
      return 'software' as const;
    });

    const currentAccelerator = detectionLock.withPermits(1)(
      Effect.suspend(() =>
        selected
          ? Effect.succeed(selected)
          : detectAccelerator.pipe(Effect.tap((accelerator) => Effect.sync(() => (selected = accelerator)))),
      ),
    );

    const disableAccelerator = (accelerator: Accelerator, error: ProcessError) =>
      Effect.sync(() => {
        failedAccelerators.add(accelerator);
        selected = null;
      }).pipe(
        Effect.andThen(
          Effect.logWarning('Hardware encoder failed; falling back to software').pipe(
            Effect.annotateLogs({ accelerator, failure: error._tag }),
          ),
        ),
      );

    const touch = (session: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => recentlyServed.set(session, now)));

    /** Evicts old sessions, never touching sessions served recently or being generated. */
    const sweepCache = yield* makeThrottled(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [key, servedAt] of recentlyServed)
          if (now - servedAt > ACTIVE_SESSION_WINDOW_MS) recentlyServed.delete(key);
        const protectedKeys = new Set([
          ...recentlyServed.keys(),
          ...sessions.inFlightKeys(),
          ...segments.inFlightKeys().map((target) => path.basename(path.dirname(target))),
        ]);
        const names = yield* Effect.promise(() => readdir(cacheDirectory).catch(() => [] as string[]));
        const items = yield* Effect.forEach(
          names.filter((name) => sessionPattern.test(name)),
          (key) =>
            Effect.promise(async () => {
              const directory = path.join(cacheDirectory, key);
              try {
                return { key, bytes: await directorySize(directory), lastUsedMs: (await stat(directory)).mtimeMs };
              } catch {
                return null;
              }
            }),
          { concurrency: 4 },
        );
        const evictions = selectEvictions(
          items.filter((item) => item !== null),
          {
            now,
            maxAgeMs: config.HLS_CACHE_MAX_AGE_HOURS * 3_600_000,
            maxBytes: config.HLS_CACHE_MAX_BYTES,
            protectedKeys,
          },
        );
        yield* Effect.forEach(evictions, (key) => removeQuietly(path.join(cacheDirectory, key)), { discard: true });
        if (evictions.length)
          yield* Effect.logInfo('Evicted HLS sessions').pipe(Effect.annotateLogs({ count: evictions.length }));
      }),
      CACHE_SWEEP_INTERVAL,
    );

    const prepareSession = (key: string, metadata: HlsSessionMetadata) =>
      Effect.gen(function* () {
        const directory = path.join(cacheDirectory, key);
        const cached = yield* readSessionMetadata(directory).pipe(Effect.option);
        if (
          Option.isSome(cached) &&
          sessionKey(cached.value) === key &&
          (yield* exists(path.join(directory, 'master.m3u8')))
        )
          return;
        yield* removeQuietly(directory);
        yield* io(() => mkdir(directory, { recursive: true }));
        yield* io(() => writeFile(path.join(directory, 'session.json'), JSON.stringify(metadata)));
        yield* io(() => writeFile(path.join(directory, 'master.m3u8'), manifest(metadata.durationMs)));
      });

    const readSessionMetadata = (directory: string) =>
      Effect.promise(() => readFile(path.join(directory, 'session.json'), 'utf8').catch(() => '')).pipe(
        Effect.flatMap((json) => decodeSessionMetadata(json)),
      );

    /** Prepares (or reuses) the HLS session for validated media with a known duration. */
    const startSession = (
      media: { readonly id: MediaEntryId; readonly path: string; readonly durationMs: number },
      audioStream: number | null,
    ) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise({
          try: () => stat(media.path),
          catch: () => new MediaFileUnavailable({ path: media.path, reason: 'missing' }),
        });
        const metadata: HlsSessionMetadata = {
          mediaId: media.id,
          audioStream,
          durationMs: media.durationMs,
          size: info.size,
          mtimeMs: info.mtimeMs,
          accelerator: yield* currentAccelerator,
        };
        const key = sessionKey(metadata);
        yield* touch(key);
        yield* sessions.run(key, prepareSession(key, metadata));
        yield* sweepCache;
        return { sessionId: HlsSessionId.make(key), manifestUrl: `/hls/${key}/master.m3u8` };
      }).pipe(
        Effect.annotateLogs({ mediaId: media.id }),
        Effect.withSpan('transcode.session', { attributes: { mediaId: media.id, audioStream } }),
      );

    const encodeSegment = (
      input: string,
      output: string,
      audioStream: number | null,
      accelerator: Accelerator,
      startSeconds: number,
      durationSeconds: number,
    ) =>
      runner.run({
        program: 'ffmpeg',
        args: [
          '-y',
          '-v',
          'error',
          '-ss',
          startSeconds.toFixed(3),
          '-i',
          input,
          '-t',
          durationSeconds.toFixed(3),
          '-map',
          '0:v:0',
          ...(audioStream !== null ? ['-map', `0:${audioStream}`] : ['-map', '0:a:0?']),
          '-sn',
          '-dn',
          ...videoEncoderArgs(accelerator, config.TRANSCODE_THREADS),
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-avoid_negative_ts',
          'make_zero',
          '-muxdelay',
          '0',
          '-f',
          'mpegts',
          output,
        ],
        timeout: SEGMENT_TIMEOUT,
      });

    /** Encodes one segment to a temporary file and renames it into place, removing the temporary file on any exit. */
    const generateSegment = (
      input: string,
      target: string,
      metadata: HlsSessionMetadata,
      startSeconds: number,
      durationSeconds: number,
    ): Effect.Effect<void, TranscodeFailed | TranscodeTimedOut> => {
      const temporary = `${target}.${randomUUID()}.tmp.ts`;
      return Effect.gen(function* () {
        const preferred = failedAccelerators.has(metadata.accelerator) ? 'software' : metadata.accelerator;
        yield* encodeSegment(input, temporary, metadata.audioStream, preferred, startSeconds, durationSeconds).pipe(
          Effect.catch((error) =>
            preferred === 'software' || error._tag === 'ProcessSpawnFailed'
              ? Effect.fail(error)
              : disableAccelerator(preferred, error).pipe(
                  Effect.andThen(removeQuietly(temporary)),
                  Effect.andThen(
                    encodeSegment(input, temporary, metadata.audioStream, 'software', startSeconds, durationSeconds),
                  ),
                ),
          ),
          Effect.mapError((error) =>
            error._tag === 'ProcessTimedOut'
              ? new TranscodeTimedOut({ timeoutMs: error.timeoutMs })
              : new TranscodeFailed({ cause: error }),
          ),
        );
        yield* io(() => rename(temporary, target));
      }).pipe(
        Effect.ensuring(removeQuietly(temporary)),
        Effect.withSpan('transcode.segment', { attributes: { mediaId: metadata.mediaId, startSeconds } }),
      );
    };

    /**
     * Resolves a manifest or segment in a session, generating the segment on demand. Concurrent
     * requests for one segment share a single FFmpeg run, which stops once no request needs it.
     */
    const hlsFile = (session: string, file: string) =>
      Effect.gen(function* () {
        if (!sessionPattern.test(session) || !filePattern.test(file))
          return yield* new HlsFileNotFound({ session, file });
        const directory = path.join(cacheDirectory, session);
        const target = path.join(directory, file);
        yield* touch(session);
        if (file === 'master.m3u8') {
          if (yield* exists(target)) return target;
          return yield* new HlsFileNotFound({ session, file });
        }
        const match = segmentPattern.exec(file);
        if (!match) return yield* new HlsFileNotFound({ session, file });
        if (yield* exists(target)) return target;

        const metadata = yield* readSessionMetadata(directory).pipe(
          Effect.catchTag('SchemaError', () => Effect.fail(new HlsFileNotFound({ session, file }))),
        );
        if (sessionKey(metadata) !== session) return yield* new HlsFileNotFound({ session, file });
        const startSeconds = Number(match[1]) * SEGMENT_DURATION_SECONDS;
        if (startSeconds * 1000 >= metadata.durationMs) return yield* new HlsFileNotFound({ session, file });

        const media = yield* library.activeMedia(metadata.mediaId);
        const info = yield* Effect.tryPromise({
          try: () => stat(media.path),
          catch: () => new MediaFileUnavailable({ path: media.path, reason: 'missing' }),
        });
        if (info.size !== metadata.size || info.mtimeMs !== metadata.mtimeMs)
          return yield* new MediaChanged({ mediaId: metadata.mediaId });

        const durationSeconds = Math.min(SEGMENT_DURATION_SECONDS, metadata.durationMs / 1000 - startSeconds);
        yield* segments.run(
          target,
          capacity.withCapacity(
            Effect.suspend(() => exists(target)).pipe(
              Effect.flatMap((done) =>
                done ? Effect.void : generateSegment(media.path, target, metadata, startSeconds, durationSeconds),
              ),
            ),
          ),
        );
        return target;
      }).pipe(Effect.annotateLogs({ sessionId: session, file }));

    return { startSession, hlsFile } as const;
  }),
}) {
  /** Requires `FernConfig`, `MediaProcessRunner`, and `MediaLibrary`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database` and `FernConfig`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(MediaLibrary.layer),
    Layer.provide(MediaProcessRunner.layer),
  );
}

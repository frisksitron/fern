import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Clock, Context, Effect, FileSystem, Layer, Option, Schema, SynchronizedRef } from 'effect';
import { FernConfig } from '$lib/server/config';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable, type MediaFileError, type MediaNotFound } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcess, type ProcessError } from '$lib/server/media/process';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import { Disk } from '$lib/server/platform/disk';
import { HlsSessionId, type MediaEntryId } from '$lib/shared/contracts/ids';
import { HlsSessionMetadata, type HlsSession } from '$lib/shared/contracts/playback';
import { HlsFileNotFound, MediaChanged, TranscodeFailed, TranscodeTimedOut } from './errors';

export type Accelerator = 'nvenc' | 'qsv' | 'software';

/** Validated media with a known duration, ready to stream. */
export type SessionMedia = { readonly id: MediaEntryId; readonly path: string; readonly durationMs: number };

export type HlsFileError =
  | HlsFileNotFound
  | MediaChanged
  | MediaNotFound
  | MediaFileError
  | DatabaseUnavailable
  | TranscodeFailed
  | TranscodeTimedOut
  | CapacityExceeded;

/**
 * On-demand HLS: sessions, segments, hardware encoder selection, and the segment cache. All state
 * lives in this service, and its FFmpeg work is owned by the runtime.
 */
export interface Interface {
  /** Prepares (or reuses) the HLS session for the media and audio stream. */
  readonly startSession: (media: SessionMedia, audioStream: number | null) => Effect.Effect<HlsSession, MediaFileError>;
  /**
   * Resolves a manifest or segment in a session to its file, generating the segment on demand.
   * Concurrent requests for one segment share a single FFmpeg run, which stops once no request
   * needs it.
   */
  readonly hlsFile: (session: string, file: string) => Effect.Effect<string, HlsFileError>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Transcoding') {}

const SEGMENT_DURATION_SECONDS = 6;
/** Part of every session key: bump it to invalidate cached segments after changing encoding. */
const CACHE_VERSION = 'v4';
const SEGMENT_TIMEOUT = '30 seconds';
const DETECTION_TIMEOUT = '20 seconds';
/** How long a segment request may wait for a transcode slot. */
const MAX_SEGMENT_WAIT = '20 seconds';
/** Sessions served within this window are never evicted from the cache. */
const ACTIVE_SESSION_WINDOW_MS = 10 * 60_000;
/** How long a hardware encoder that failed is left alone before it is tried again. */
const ACCELERATOR_RETRY_AFTER_MS = 10 * 60_000;
/** Cache eviction walks every session directory, so it runs at most this often. */
const CACHE_SWEEP_INTERVAL = '1 minute';

const sessionPattern = /^[a-f0-9]{64}$/;
const filePattern = /^[a-zA-Z0-9._-]+$/;
const segmentPattern = /^segment-(\d{5})\.ts$/;

const SessionMetadataJson = Schema.fromJsonString(HlsSessionMetadata);
const decodeSessionMetadata = Schema.decodeUnknownEffect(SessionMetadataJson);
const encodeSessionMetadata = Schema.encodeSync(SessionMetadataJson);

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

export function videoEncoderArgs(accelerator: Accelerator, threads: number) {
  if (accelerator === 'nvenc')
    return ['-vf', 'format=nv12', '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'];
  if (accelerator === 'qsv')
    return ['-vf', 'format=nv12', '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'];
  // Browsers cannot decode H.264 High 10, which libx264 would produce for a 10-bit source.
  return [
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-profile:v', 'high'],
    ...['-threads', String(threads)],
  ];
}

/** Whether a hardware encoder that failed at `failedAtMs` is still being left alone at `nowMs`. */
export function isAcceleratorBenched(failedAtMs: number | undefined, nowMs: number) {
  return failedAtMs !== undefined && nowMs - failedAtMs < ACCELERATOR_RETRY_AFTER_MS;
}

/** Requires `FernConfig`, `MediaProcess`, `MediaLibrary`, `Disk`, and `FileSystem`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    const media = yield* MediaProcess.Service;
    const library = yield* MediaLibrary.Service;
    const disk = yield* Disk.Service;
    const fs = yield* FileSystem.FileSystem;
    const cacheDirectory = config.HLS_CACHE_DIR;

    const segments = yield* makeSharedWork<TranscodeFailed | TranscodeTimedOut | CapacityExceeded>();
    const sessions = yield* makeSharedWork<never>();
    const capacity = yield* makeCapacity({
      concurrency: config.MAX_CONCURRENT_TRANSCODES,
      maxWaiting: config.TRANSCODE_MAX_WAITING,
      maxWait: MAX_SEGMENT_WAIT,
    });
    const recentlyServed = new Map<string, number>();

    // Failures of the cache itself (a full or missing disk) are not expected in normal operation:
    // they are defects. Reads that find nothing are not failures.
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    const removeQuietly = (file: string) => fs.remove(file, { recursive: true, force: true }).pipe(Effect.ignore);

    /** The size and modification time of a media file, which identify its version. */
    const versionOf = (file: string) =>
      disk
        .stat(file)
        .pipe(
          Effect.catchTag('PathNotFound', () =>
            Effect.fail(new MediaFileUnavailable({ path: file, reason: 'missing' })),
          ),
        );

    // Hardware encoder selection. An encoder that fails is left alone for a while, then tried again.
    const failedAccelerators = new Map<Accelerator, number>();
    const selected = yield* SynchronizedRef.make(Option.none<{ accelerator: Accelerator; detectedAtMs: number }>());

    const detectAccelerator = Effect.fnUntraced(function* () {
      const configured = config.TRANSCODE_ACCELERATOR;
      const candidates: Accelerator[] =
        configured === 'auto' ? ['nvenc', 'qsv'] : configured === 'software' ? [] : [configured];
      for (const candidate of candidates) {
        if (isAcceleratorBenched(failedAccelerators.get(candidate), yield* Clock.currentTimeMillis)) continue;
        const probe = yield* Effect.result(
          media.run({
            program: 'ffmpeg',
            args: [
              ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=256x256:rate=1'],
              ...['-frames:v', '1', '-an', ...videoEncoderArgs(candidate, config.TRANSCODE_THREADS), '-f', 'null', '-'],
            ],
            timeout: DETECTION_TIMEOUT,
          }),
        );
        if (probe._tag === 'Success') {
          yield* Effect.logInfo('Using hardware transcoding').pipe(Effect.annotateLogs({ accelerator: candidate }));
          return candidate;
        }
        failedAccelerators.set(candidate, yield* Clock.currentTimeMillis);
      }
      if (candidates.length) yield* Effect.logWarning('Could not initialize hardware transcoding; using software');
      return 'software' as const;
    });

    /**
     * The encoder for new sessions: detected once, again after a hardware encoder failed, and again
     * once the wait after a failure is over.
     */
    const currentAccelerator = SynchronizedRef.modifyEffect(selected, (current) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const retryHardware =
          Option.isSome(current) &&
          current.value.accelerator === 'software' &&
          config.TRANSCODE_ACCELERATOR !== 'software' &&
          now - current.value.detectedAtMs >= ACCELERATOR_RETRY_AFTER_MS;
        if (Option.isSome(current) && !retryHardware) return [current.value.accelerator, current] as const;
        const accelerator = yield* detectAccelerator();
        return [accelerator, Option.some({ accelerator, detectedAtMs: now })] as const;
      }),
    );

    /** Blames a hardware encoder for a failure that software did not share. */
    const disableAccelerator = Effect.fnUntraced(function* (accelerator: Accelerator, error: ProcessError) {
      failedAccelerators.set(accelerator, yield* Clock.currentTimeMillis);
      yield* SynchronizedRef.set(selected, Option.none());
      yield* Effect.logWarning('Hardware encoder failed; falling back to software').pipe(
        Effect.annotateLogs({ accelerator, failure: error._tag }),
      );
    });

    const touch = (session: string) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        recentlyServed.set(session, now);
      });

    /** A session directory's total size and when it was last used, or nothing if it cannot be read. */
    const sessionUsage = (key: string) => {
      const directory = path.join(cacheDirectory, key);
      return Effect.gen(function* () {
        const sizes = yield* Effect.forEach(yield* fs.readDirectory(directory, { recursive: true }), (name) =>
          fs
            .stat(path.join(directory, name))
            .pipe(Effect.map((info) => (info.type === 'File' ? Number(info.size) : 0))),
        );
        const info = yield* fs.stat(directory);
        return {
          key,
          bytes: sizes.reduce((total, size) => total + size, 0),
          lastUsedMs: Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
        };
      }).pipe(Effect.option);
    };

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
        const names = yield* fs.readDirectory(cacheDirectory).pipe(Effect.orElseSucceed((): string[] => []));
        const usage = yield* Effect.forEach(
          names.filter((name) => sessionPattern.test(name)),
          sessionUsage,
          { concurrency: 4 },
        );
        const evictions = selectEvictions(
          usage.flatMap((item) => (Option.isSome(item) ? [item.value] : [])),
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

    const readSessionMetadata = (directory: string) =>
      fs.readFileString(path.join(directory, 'session.json')).pipe(
        Effect.orElseSucceed(() => ''),
        Effect.flatMap(decodeSessionMetadata),
      );

    const prepareSession = Effect.fnUntraced(function* (key: string, metadata: HlsSessionMetadata) {
      const directory = path.join(cacheDirectory, key);
      const cached = yield* readSessionMetadata(directory).pipe(Effect.option);
      if (
        Option.isSome(cached) &&
        sessionKey(cached.value) === key &&
        (yield* exists(path.join(directory, 'master.m3u8')))
      )
        return;
      yield* removeQuietly(directory);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, 'session.json'), encodeSessionMetadata(metadata));
      yield* fs.writeFileString(path.join(directory, 'master.m3u8'), manifest(metadata.durationMs));
    }, Effect.orDie);

    const startSession = Effect.fn('Transcoding.startSession')(
      function* (source: SessionMedia, audioStream: number | null) {
        yield* Effect.annotateCurrentSpan({ mediaId: source.id, audioStream });
        const version = yield* versionOf(source.path);
        const metadata: HlsSessionMetadata = {
          mediaId: source.id,
          audioStream,
          durationMs: source.durationMs,
          size: version.size,
          mtimeMs: version.mtimeMs,
          accelerator: yield* currentAccelerator,
        };
        const key = sessionKey(metadata);
        yield* touch(key);
        yield* sessions.run(key, prepareSession(key, metadata));
        yield* sweepCache;
        return { sessionId: HlsSessionId.make(key), manifestUrl: `/hls/${key}/master.m3u8` };
      },
      (effect, source) => Effect.annotateLogs(effect, { mediaId: source.id }),
    );

    const encodeSegment = (
      input: string,
      output: string,
      audioStream: number | null,
      accelerator: Accelerator,
      startSeconds: number,
      durationSeconds: number,
    ) =>
      media.run({
        program: 'ffmpeg',
        args: [
          ...['-y', '-v', 'error', '-ss', startSeconds.toFixed(3), '-i', input, '-t', durationSeconds.toFixed(3)],
          ...['-map', '0:v:0', ...(audioStream !== null ? ['-map', `0:${audioStream}`] : ['-map', '0:a:0?'])],
          ...['-sn', '-dn', ...videoEncoderArgs(accelerator, config.TRANSCODE_THREADS)],
          ...['-c:a', 'aac', '-ac', '2', '-avoid_negative_ts', 'make_zero', '-muxdelay', '0', '-f', 'mpegts', output],
        ],
        timeout: SEGMENT_TIMEOUT,
      });

    /** Encodes one segment to a temporary file and renames it into place, removing the temporary file on any exit. */
    const generateSegment = Effect.fn('Transcoding.generateSegment')(function* (
      input: string,
      target: string,
      metadata: HlsSessionMetadata,
      startSeconds: number,
      durationSeconds: number,
    ) {
      yield* Effect.annotateCurrentSpan({ mediaId: metadata.mediaId, startSeconds });
      const temporary = `${target}.${randomUUID()}.tmp.ts`;
      const preferred = isAcceleratorBenched(
        failedAccelerators.get(metadata.accelerator),
        yield* Clock.currentTimeMillis,
      )
        ? 'software'
        : metadata.accelerator;
      const encode = (accelerator: Accelerator) =>
        encodeSegment(input, temporary, metadata.audioStream, accelerator, startSeconds, durationSeconds);
      yield* encode(preferred).pipe(
        // Only an encoder that exited with an error and whose segment software then encodes is
        // to blame. A timeout, a bad input, or a missing stream would fail software too.
        Effect.catch((error) =>
          preferred === 'software' || error._tag !== 'ProcessExited'
            ? Effect.fail(error)
            : removeQuietly(temporary).pipe(
                Effect.andThen(encode('software')),
                Effect.tap(() => disableAccelerator(preferred, error)),
              ),
        ),
        Effect.mapError((error) =>
          error._tag === 'ProcessTimedOut'
            ? new TranscodeTimedOut({ timeoutMs: error.timeoutMs })
            : new TranscodeFailed({ cause: error }),
        ),
        Effect.andThen(fs.rename(temporary, target).pipe(Effect.orDie)),
        Effect.ensuring(removeQuietly(temporary)),
      );
    });

    const hlsFile = Effect.fn('Transcoding.hlsFile')(
      function* (session: string, file: string) {
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

        const source = yield* library.activeMedia(metadata.mediaId);
        const version = yield* versionOf(source.path);
        if (version.size !== metadata.size || version.mtimeMs !== metadata.mtimeMs)
          return yield* new MediaChanged({ mediaId: metadata.mediaId });

        const durationSeconds = Math.min(SEGMENT_DURATION_SECONDS, metadata.durationMs / 1000 - startSeconds);
        yield* segments.run(
          target,
          capacity.withCapacity(
            Effect.flatMap(exists(target), (done) =>
              done ? Effect.void : generateSegment(source.path, target, metadata, startSeconds, durationSeconds),
            ),
          ),
        );
        return target;
      },
      (effect, session, file) => Effect.annotateLogs(effect, { sessionId: session, file }),
    );

    return Service.of({ startSession, hlsFile });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(MediaLibrary.defaultLayer),
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Disk.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(FernConfig.defaultLayer),
);

export * as Transcoding from './service';

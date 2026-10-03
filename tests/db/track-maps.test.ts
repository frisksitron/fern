import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duration, Effect, Layer, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaProcessRunner, ProcessExited, type ProcessRequest } from '../../src/lib/server/media/process-runner';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { TrackMaps } from '../../src/lib/server/track-maps/service';
import { MediaEntryId } from '../../src/lib/shared/contracts/ids';
import { decodeTrackMap, TrackMapResponse } from '../../src/lib/shared/contracts/track-map';
import { testConfig } from '../support/config';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
let workspace: string;
let mediaId: MediaEntryId;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.pool.query('truncate media_roots cascade');
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = await mkdtemp(path.join(tmpdir(), 'fern-track-maps-'));
  const library = path.join(workspace, 'library');
  await mkdir(library);
  await writeFile(path.join(library, 'song.flac'), 'flac');
  const rootId = randomUUID();
  mediaId = MediaEntryId.make(randomUUID());
  await database.pool.query(
    `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Music', 'music')`,
    [rootId, library],
  );
  await database.pool.query(
    `insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_audio, duration_ms, probe_status)
     values ($1, $2, 'song.flac', 'song.flac', 'file', 0, true, 30000, 'ok')`,
    [mediaId, rootId],
  );
});

const RATE = 24_000;

/**
 * 30 s of song: a quiet tone, then 10 s with a kick every half second over it, then the quiet tone
 * again. As FFmpeg would write it: mono, little-endian 32-bit floats.
 */
function song() {
  const samples = Float32Array.from({ length: RATE * 30 }, (_, index) => {
    const time = index / RATE;
    const tone = Math.sin(2 * Math.PI * 440 * time);
    if (time < 10 || time >= 20) return tone * 0.01;
    const sinceKick = (time - 10) % 0.5;
    return tone * 0.2 + Math.exp(-sinceKick / 0.05) * Math.sin(2 * Math.PI * 60 * sinceKick) * 0.8;
  });
  return Buffer.from(samples.buffer);
}

/** Stands in for FFmpeg: streams the song to `onStdout` in uneven chunks, or fails. */
function fakeFfmpeg(options: { readonly fail?: boolean } = {}) {
  const runs: (readonly string[])[] = [];
  const timeouts: number[] = [];
  const pcm = song();
  const layer = Layer.succeed(MediaProcessRunner, {
    run: (request: ProcessRequest) =>
      Effect.gen(function* () {
        runs.push(request.args);
        timeouts.push(Duration.toMillis(request.timeout));
        if (options.fail)
          return yield* new ProcessExited({ program: 'ffmpeg', code: 1, signal: null, stderr: 'no audio' });
        // Uneven chunks, so samples are split between them as pipes split them.
        for (let at = 0; at < pcm.length; at += 65_531) request.onStdout?.(pcm.subarray(at, at + 65_531));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        return { stdout: Buffer.alloc(0), stderr: '', durationMs: 1 };
      }),
  });
  return { runs, timeouts, layer };
}

function trackMaps(runner: ReturnType<typeof fakeFfmpeg>) {
  const layer = TrackMaps.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        testConfig({ TRACK_MAP_CACHE_DIR: path.join(workspace, 'track-maps') }),
        runner.layer,
        MediaLibrary.layerWithoutDependencies.pipe(Layer.provide(Layer.mergeAll(FileSystem.layer, database.layer))),
      ),
    ),
  );
  return <A, E>(program: (service: TrackMaps['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.scoped(Effect.provide(TrackMaps.use(program), layer)));
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TrackMapResponse));

describe('TrackMaps', () => {
  it('analyses each track once, streaming its audio, and serves later requests from disk', async () => {
    const runner = fakeFfmpeg();
    const [first, again] = await trackMaps(runner)((service) =>
      Effect.gen(function* () {
        const concurrent = yield* Effect.forEach([1, 2], () => service.trackMapOf(mediaId), {
          concurrency: 'unbounded',
        });
        expect(concurrent[0].key).toBe(concurrent[1].key);
        return [concurrent[0], yield* service.trackMapOf(mediaId)];
      }),
    );
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]).toEqual(expect.arrayContaining(['-ar', String(RATE), '-f', 'f32le']));
    expect(again.key).toBe(first.key);

    const map = decodeTrackMap(decode(first.contents.toString()));
    expect(map.calm).toHaveLength(600);
    const kicks = [...map.hits.bass.entries()].filter(([, hit]) => hit > 0).map(([step]) => step);
    expect(kicks.length).toBeGreaterThanOrEqual(15);
    expect(kicks.every((step) => step >= 200 && step < 410)).toBe(true);
    expect((await readdir(path.join(workspace, 'track-maps'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('reads the whole track, however long', async () => {
    const runner = fakeFfmpeg();
    const read = trackMaps(runner);
    await read((service) => service.trackMapOf(mediaId));
    // No cut-off, and minutes more to read for every ten of the track's length (here 30 s).
    expect(runner.runs[0]).not.toContain('-t');
    expect(runner.timeouts).toEqual([3 * 60_000 + 3_000]);
  });

  it('reports audio FFmpeg cannot decode as TrackMapFailed', async () => {
    const runner = fakeFfmpeg({ fail: true });
    await trackMaps(runner)((service) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.trackMapOf(mediaId))).toMatchObject({ _tag: 'TrackMapFailed' });
      }),
    );
    expect((await readdir(path.join(workspace, 'track-maps'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('reports a track that is not in the library as MediaNotFound', async () => {
    const runner = fakeFfmpeg();
    await trackMaps(runner)((service) =>
      Effect.gen(function* () {
        const missing = MediaEntryId.make(randomUUID());
        expect(yield* Effect.flip(service.trackMapOf(missing))).toMatchObject({ _tag: 'MediaNotFound' });
      }),
    );
    expect(runner.runs).toHaveLength(0);
  });
});

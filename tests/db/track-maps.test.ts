import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Duration, Effect, FileSystem, Layer, Schema, Stream } from 'effect';
import { SqlClient } from 'effect/sql';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaProcess, ProcessExited } from '../../src/lib/server/media/process';
import { Disk } from '../../src/lib/server/platform/disk';
import { TrackMaps } from '../../src/lib/server/track-maps/service';
import { MediaEntryId } from '../../src/lib/shared/contracts/ids';
import { decodeTrackMap, TrackMapResponse } from '../../src/lib/shared/contracts/track-map';
import { testConfig } from '../support/config';
import { TestDatabase } from './support/database';

/** A music library with one indexed 30-second song, in a directory removed after the test. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  yield* TestDatabase.truncate('media_roots');
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-track-maps-' });
  const library = path.join(workspace, 'library');
  yield* fs.makeDirectory(library);
  yield* fs.writeFileString(path.join(library, 'song.flac'), 'flac');
  const rootId = randomUUID();
  const mediaId = MediaEntryId.make(randomUUID());
  yield* sql`insert into media_roots (id, path, display_name, media_type) values (${rootId}, ${library}, 'Music', 'music')`;
  yield* sql`insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_audio, duration_ms, probe_status)
    values (${mediaId}, ${rootId}, 'song.flac', 'song.flac', 'file', 0, true, 30000, 'ok')`;
  return { workspace, mediaId, cacheDirectory: path.join(workspace, 'track-maps') };
});

type Fixture = Effect.Success<typeof fixture>;

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
  return new Uint8Array(samples.buffer);
}

/** Stands in for FFmpeg: streams the song in uneven chunks, or fails. */
function fakeFfmpeg(options: { readonly fail?: boolean } = {}) {
  const runs: (readonly string[])[] = [];
  const timeouts: number[] = [];
  const pcm = song();
  // Uneven chunks, so samples are split between them as pipes split them.
  const chunks = Array.from({ length: Math.ceil(pcm.length / 65_531) }, (_, index) =>
    pcm.subarray(index * 65_531, (index + 1) * 65_531),
  );
  const layer = Layer.mock(MediaProcess.Service, {
    stdout: (request) => {
      runs.push(request.args);
      timeouts.push(Duration.toMillis(request.timeout));
      return options.fail
        ? Stream.fail(new ProcessExited({ program: 'ffmpeg', code: 1, stderr: 'no audio' }))
        : Stream.fromIterable(chunks);
    },
  });
  return { runs, timeouts, layer };
}

/** A `TrackMaps` of its own, released when the effect it is provided to ends. */
const trackMaps = (files: Fixture, ffmpeg: ReturnType<typeof fakeFfmpeg>) =>
  Effect.provide(
    Layer.fresh(TrackMaps.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          testConfig({ TRACK_MAP_CACHE_DIR: files.cacheDirectory }),
          ffmpeg.layer,
          MediaLibrary.layer.pipe(Layer.provideMerge(Disk.layer)),
        ),
      ),
    ),
  );

const trackMapOf = (id: MediaEntryId) => TrackMaps.Service.use((service) => service.trackMapOf(id));

const temporaryFiles = (directory: string) =>
  FileSystem.FileSystem.use((fs) => fs.readDirectory(directory)).pipe(
    Effect.map((names) => names.filter((name) => name.includes('.tmp.'))),
  );

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(TrackMapResponse));

layer(Layer.mergeAll(TestDatabase.layer, NodeServices.layer), { excludeTestServices: true })('TrackMaps', (it) => {
  it.effect('analyses each track once, streaming its audio, and serves later requests from disk', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = fakeFfmpeg();
      const [first, again] = yield* Effect.gen(function* () {
        const concurrent = yield* Effect.forEach([1, 2], () => trackMapOf(files.mediaId), {
          concurrency: 'unbounded',
        });
        expect(concurrent[0].key).toBe(concurrent[1].key);
        return [concurrent[0], yield* trackMapOf(files.mediaId)];
      }).pipe(trackMaps(files, ffmpeg));
      expect(ffmpeg.runs).toHaveLength(1);
      expect(ffmpeg.runs[0]).toEqual(expect.arrayContaining(['-ar', String(RATE), '-f', 'f32le']));
      expect(again.key).toBe(first.key);

      const map = decodeTrackMap(decode(new TextDecoder().decode(first.contents)));
      expect(map.calm).toHaveLength(600);
      const kicks = [...map.hits.bass.entries()].filter(([, hit]) => hit > 0).map(([step]) => step);
      expect(kicks.length).toBeGreaterThanOrEqual(15);
      expect(kicks.every((step) => step >= 200 && step < 410)).toBe(true);
      expect(yield* temporaryFiles(files.cacheDirectory)).toEqual([]);
    }),
  );

  it.effect('reads the whole track, however long, and reads it again when its chapters change', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const ffmpeg = fakeFfmpeg();
      yield* Effect.gen(function* () {
        const first = yield* trackMapOf(files.mediaId);
        // No cut-off, and minutes more to read for every ten of the track's length (here 30 s).
        expect(ffmpeg.runs[0]).not.toContain('-t');
        expect(ffmpeg.timeouts).toEqual([3 * 60_000 + 3_000]);

        yield* sql`insert into media_chapters (media_entry_id, position, start_ms, end_ms, title)
          values (${files.mediaId}, 0, 0, 15000, 'One'), (${files.mediaId}, 1, 15000, 30000, 'Two')`;
        const chaptered = yield* trackMapOf(files.mediaId);
        expect(chaptered.key).not.toBe(first.key);
        expect(ffmpeg.runs).toHaveLength(2);
      }).pipe(trackMaps(files, ffmpeg));
    }),
  );

  it.effect('reports audio FFmpeg cannot decode as TrackMapFailed', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = fakeFfmpeg({ fail: true });
      expect(yield* Effect.flip(trackMapOf(files.mediaId)).pipe(trackMaps(files, ffmpeg))).toMatchObject({
        _tag: 'TrackMapFailed',
      });
      expect(yield* temporaryFiles(files.cacheDirectory)).toEqual([]);
    }),
  );

  it.effect('reports a track that is not in the library as MediaNotFound', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = fakeFfmpeg();
      const missing = MediaEntryId.make(randomUUID());
      expect(yield* Effect.flip(trackMapOf(missing)).pipe(trackMaps(files, ffmpeg))).toMatchObject({
        _tag: 'MediaNotFound',
      });
      expect(ffmpeg.runs).toHaveLength(0);
    }),
  );
});

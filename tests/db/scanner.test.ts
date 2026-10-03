import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { MediaProbe } from '../../src/lib/server/media/probe';
import { MediaProcess, ProcessExited, type ProcessRequest } from '../../src/lib/server/media/process';
import { Disk } from '../../src/lib/server/platform/disk';
import { ScanEvents } from '../../src/lib/server/scans/events';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { ScanId } from '../../src/lib/shared/contracts/ids';
import { testConfig } from '../support/config';
import { fakeDisk } from '../support/fakes';
import { TestDatabase } from './support/database';

function ffprobeJson(file: string) {
  const name = path.basename(file);
  // A mix as yt-dlp saves it: Ogg Opus keeps its tags on the audio stream. The file's text says
  // which chapters it has.
  if (name.endsWith('.opus'))
    return {
      format: { duration: '600.0', format_name: 'ogg' },
      streams: [
        { index: 0, codec_type: 'audio', codec_name: 'opus', tags: { title: 'Late Mix', ARTIST: 'Chrysalis' } },
      ],
      chapters: readFileSync(file, 'utf8').includes('recut')
        ? [{ start_time: '0.000000', end_time: '600.000000', tags: { title: 'Whole Mix' } }]
        : [
            { start_time: '0.000000', end_time: '200.000000', tags: { title: 'Intro' } },
            { start_time: '200.000000', end_time: '612.500000', tags: { title: 'Second Song' } },
          ],
    };
  if (/\.(mp3|flac)$/.test(name))
    return {
      format: { duration: '180.5', format_name: 'mp3', bit_rate: '320000', tags: { title: name, TRACK: '2/10' } },
      streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }],
    };
  const audio = name.endsWith('.mkv')
    ? [
        { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'jpn' }, disposition: { default: 1 } },
        { index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
      ]
    : [{ index: 1, codec_type: 'audio', codec_name: 'aac' }];
  return {
    format: { duration: '45.0', format_name: name.endsWith('.mkv') ? 'matroska,webm' : 'mov,mp4,m4a' },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 180 }, ...audio],
  };
}

/** The real MediaProbe over an ffprobe that answers with canned JSON, fails for files named "broken", and records its concurrency. */
function fakeFfprobe() {
  const stats = { calls: [] as string[], active: 0, maxActive: 0 };
  const process = Layer.mock(MediaProcess.Service, {
    run: (request: ProcessRequest) =>
      Effect.gen(function* () {
        const file = request.args.at(-1)!;
        stats.calls.push(path.basename(file));
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        yield* Effect.sleep('10 millis').pipe(Effect.ensuring(Effect.sync(() => stats.active--)));
        if (file.includes('broken'))
          return yield* new ProcessExited({ program: 'ffprobe', code: 1, stderr: 'Invalid data found' });
        return { stdout: Buffer.from(JSON.stringify(ffprobeJson(file))), stderr: '', durationMs: 10 };
      }),
  });
  return { stats, layer: MediaProbe.layer.pipe(Layer.provide(process)) };
}

/** A scanner of its own on the block's database. */
function scanner(probe = fakeFfprobe(), disk: Layer.Layer<Disk.Service> = Disk.layer) {
  const layer = Layer.fresh(
    Scanner.layer.pipe(
      Layer.provide(Layer.mergeAll(testConfig({ SCAN_PROBE_CONCURRENCY: '2' }), disk, probe.layer, ScanEvents.layer)),
    ),
  );
  return {
    probe,
    run: (scanId: string) => Scanner.Service.use((s) => s.run(ScanId.make(scanId))).pipe(Effect.provide(layer)),
  };
}

/** An empty temporary media library, removed when the test ends. */
const emptyLibrary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-scan-' });
  const absolute = (relativePath: string) => path.join(root, ...relativePath.split('/'));
  return {
    path: root,
    write: (relativePath: string, contents = 'media') =>
      fs
        .makeDirectory(path.dirname(absolute(relativePath)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(absolute(relativePath), contents)), Effect.orDie),
    remove: (relativePath: string) => fs.remove(absolute(relativePath), { recursive: true }).pipe(Effect.orDie),
  };
});

/** A library with two folders of video, a subtitle, a broken file, and a text file. */
const videoLibrary = Effect.gen(function* () {
  const library = yield* emptyLibrary;
  yield* library.write('Movies/Direct Play.mp4');
  yield* library.write('Movies/Direct Play.en.srt', '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  yield* library.write('Movies/broken.avi');
  yield* library.write('Shows/Season 1/Episode 1.mkv');
  yield* library.write('Shows/notes.txt', 'not media');
  return library;
});

const addRoot = Effect.fnUntraced(function* (rootPath: string, mediaType: 'video' | 'music' = 'video') {
  const sql = yield* SqlClient.SqlClient;
  const id = randomUUID();
  yield* sql`insert into media_roots (id, path, display_name, media_type) values (${id}, ${rootPath}, 'Root', ${mediaType})`;
  return id;
});

const queueScan = Effect.fnUntraced(function* (rootId: string | null) {
  const sql = yield* SqlClient.SqlClient;
  const id = randomUUID();
  yield* sql`insert into scan_runs (id, state, root_id) values (${id}, 'queued', ${rootId})`;
  return id;
});

const scanRow = Effect.fnUntraced(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql`select * from scan_runs where id = ${id}`;
  return row;
});

const reset = TestDatabase.truncate('scan_runs', 'media_roots');

layer(Layer.mergeAll(TestDatabase.layer, NodeServices.layer), { excludeTestServices: true })('Scanner', (it) => {
  it.effect('indexes entries, tracks, and subtitles and records probe failures with their paths', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      const scanId = yield* queueScan(yield* addRoot(library.path));
      yield* scanner().run(scanId);

      expect(yield* scanRow(scanId)).toMatchObject({
        state: 'completed',
        directories_seen: 3,
        files_seen: 5,
        videos_seen: 3,
        audio_seen: 0,
        files_probed: 2,
        errors_count: 1,
      });
      expect(
        yield* sql`select e.relative_path, e.probe_status, p.relative_path as parent
          from media_entries e left join media_entries p on p.id = e.parent_id order by e.relative_path`,
      ).toEqual([
        { relative_path: 'Movies', probe_status: 'not_required', parent: null },
        { relative_path: 'Movies/Direct Play.en.srt', probe_status: 'not_required', parent: 'Movies' },
        { relative_path: 'Movies/Direct Play.mp4', probe_status: 'ok', parent: 'Movies' },
        { relative_path: 'Movies/broken.avi', probe_status: 'failed', parent: 'Movies' },
        { relative_path: 'Shows', probe_status: 'not_required', parent: null },
        { relative_path: 'Shows/Season 1', probe_status: 'not_required', parent: 'Shows' },
        { relative_path: 'Shows/Season 1/Episode 1.mkv', probe_status: 'ok', parent: 'Shows/Season 1' },
        { relative_path: 'Shows/notes.txt', probe_status: 'not_required', parent: 'Shows' },
      ]);
      expect(yield* sql`select count(*)::int as count from media_tracks`).toEqual([{ count: 5 }]);
      expect(yield* sql`select relative_path, format from external_subtitles`).toEqual([
        { relative_path: 'Movies/Direct Play.en.srt', format: 'srt' },
      ]);
      expect(
        yield* sql`select stage, error_code, relative_path from scan_errors where scan_run_id = ${scanId}`,
      ).toEqual([{ stage: 'probe', error_code: 'FFPROBE_FAILED', relative_path: 'Movies/broken.avi' }]);
    }),
  );

  it.effect('can run the same scan again without duplicating entries, tracks, or errors', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      const scanId = yield* queueScan(yield* addRoot(library.path));
      yield* scanner().run(scanId);
      const entries = sql`select id, relative_path from media_entries order by relative_path`;
      const firstIds = yield* entries;

      // A redelivered scan finds itself running (for example after a crash) and runs again.
      yield* sql`update scan_runs set state = 'running' where id = ${scanId}`;
      yield* sql`update media_entries set probe_status = 'pending' where relative_path like '%.mp4'`;
      yield* scanner().run(scanId);

      expect(yield* entries).toEqual(firstIds);
      expect(yield* sql`select count(*)::int as count from media_tracks`).toEqual([{ count: 5 }]);
      expect(yield* sql`select count(*)::int as count from scan_errors where scan_run_id = ${scanId}`).toEqual([
        { count: 1 },
      ]);
      expect((yield* scanRow(scanId)).state).toBe('completed');
    }),
  );

  it.effect('leaves a completed scan alone when it is delivered again', () =>
    Effect.gen(function* () {
      yield* reset;
      const library = yield* videoLibrary;
      const scanId = yield* queueScan(yield* addRoot(library.path));
      yield* scanner().run(scanId);
      const again = scanner();
      yield* again.run(scanId);
      expect(again.probe.stats.calls).toEqual([]);
    }),
  );

  it.effect('rewrites and probes only files that still need probing when nothing changed', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      const rootId = yield* addRoot(library.path);
      yield* scanner().run(yield* queueScan(rootId));
      const unchanged = sql`select id, updated_at from media_entries where relative_path <> 'Movies/broken.avi' order by id`;
      const updatedAt = yield* unchanged;

      const rescan = scanner();
      yield* rescan.run(yield* queueScan(rootId));
      // Only the file that failed to probe is tried again.
      expect(rescan.probe.stats.calls).toEqual(['broken.avi']);
      expect(yield* unchanged).toEqual(updatedAt);
    }),
  );

  it.effect('probes changed files only, and never more at once than configured', () =>
    Effect.gen(function* () {
      yield* reset;
      const library = yield* videoLibrary;
      for (let index = 0; index < 12; index++) yield* library.write(`Batch/clip-${index}.mp4`);
      const rootId = yield* addRoot(library.path);
      const first = scanner();
      yield* first.run(yield* queueScan(rootId));
      expect(first.probe.stats.maxActive).toBeLessThanOrEqual(2);
      expect(first.probe.stats.maxActive).toBeGreaterThan(1);

      yield* library.write('Batch/clip-3.mp4', 'a longer file now');
      const rescan = scanner();
      yield* rescan.run(yield* queueScan(rootId));
      expect(rescan.probe.stats.calls.sort()).toEqual(['broken.avi', 'clip-3.mp4']);
    }),
  );

  it.effect('removes entries whose files are gone', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      const rootId = yield* addRoot(library.path);
      yield* scanner().run(yield* queueScan(rootId));
      yield* library.remove('Shows');
      yield* scanner().run(yield* queueScan(rootId));
      expect(
        yield* sql`select relative_path from media_entries where deleted_at is not null order by relative_path`,
      ).toEqual([
        { relative_path: 'Shows' },
        { relative_path: 'Shows/Season 1' },
        { relative_path: 'Shows/Season 1/Episode 1.mkv' },
        { relative_path: 'Shows/notes.txt' },
      ]);
    }),
  );

  it.effect('keeps only the entries under paths that could not be read, and still removes the rest', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const files = {
        '/library/Movies/a.mp4': { size: 5 },
        '/library/Movies/gone.mp4': { size: 5 },
        '/library/Movies/gone.en.srt': { size: 5 },
        '/library/Movies/stuck.mp4': { size: 5 },
        '/library/Locked/b.mp4': { size: 5 },
        '/library/Locked/b.en.srt': { size: 5 },
      };
      const rootId = yield* addRoot('/library');
      // Index everything first, then make one folder and one file unreadable and delete two files.
      yield* scanner(fakeFfprobe(), fakeDisk(files)).run(yield* queueScan(rootId));
      yield* sql`update media_roots set last_scanned_at = null`;
      const { '/library/Movies/gone.mp4': _video, '/library/Movies/gone.en.srt': _subtitle, ...remaining } = files;
      const second = yield* queueScan(rootId);
      yield* scanner(
        fakeFfprobe(),
        fakeDisk(remaining, { denied: ['/library/Locked', '/library/Movies/stuck.mp4'] }),
      ).run(second);

      expect(
        yield* sql`select relative_path from media_entries where deleted_at is not null order by relative_path`,
      ).toEqual([{ relative_path: 'Movies/gone.en.srt' }, { relative_path: 'Movies/gone.mp4' }]);
      expect(
        yield* sql`select relative_path, deleted_at is not null as deleted from external_subtitles order by relative_path`,
      ).toEqual([
        { relative_path: 'Locked/b.en.srt', deleted: false },
        { relative_path: 'Movies/gone.en.srt', deleted: true },
      ]);
      expect(
        yield* sql`select relative_path, stage, error_code from scan_errors where scan_run_id = ${second} order by relative_path`,
      ).toEqual([
        { relative_path: 'Locked', stage: 'walk', error_code: 'PATH_UNREADABLE' },
        { relative_path: 'Movies/stuck.mp4', stage: 'walk', error_code: 'PATH_UNREADABLE' },
      ]);
      // The root was walked, so it counts as scanned even though parts of it were unreadable.
      expect(yield* sql`select last_scanned_at is not null as scanned from media_roots`).toEqual([{ scanned: true }]);
    }),
  );

  it.effect('skips system folders and files that vanish mid-scan without recording errors', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const files = {
        '/library/Movies/a.mp4': { size: 5 },
        '/library/lost+found/lost.mp4': { size: 5 },
        '/library/System Volume Information/x.mp4': { size: 5 },
        '/library/Movies/@eaDir/a.mp4/thumb.mp4': { size: 5 },
      };
      const scanId = yield* queueScan(yield* addRoot('/library'));
      yield* scanner(fakeFfprobe(), fakeDisk(files, { vanished: ['/library/Movies/vanished.mp4'] })).run(scanId);

      expect(yield* scanRow(scanId)).toMatchObject({ state: 'completed', errors_count: 0 });
      expect(yield* sql`select relative_path from media_entries order by relative_path`).toEqual([
        { relative_path: 'Movies' },
        { relative_path: 'Movies/a.mp4' },
      ]);
    }),
  );

  it.effect('removes subtitles whose files are gone and restores them when they return', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      const rootId = yield* addRoot(library.path);
      yield* scanner().run(yield* queueScan(rootId));
      const subtitles = sql`select relative_path, deleted_at is not null as deleted from external_subtitles`;
      expect(yield* subtitles).toEqual([{ relative_path: 'Movies/Direct Play.en.srt', deleted: false }]);

      yield* library.remove('Movies/Direct Play.en.srt');
      yield* scanner().run(yield* queueScan(rootId));
      expect(yield* subtitles).toEqual([{ relative_path: 'Movies/Direct Play.en.srt', deleted: true }]);

      yield* library.write('Movies/Direct Play.en.srt', 'subtitle');
      yield* scanner().run(yield* queueScan(rootId));
      expect(yield* subtitles).toEqual([{ relative_path: 'Movies/Direct Play.en.srt', deleted: false }]);
    }),
  );

  it.effect('records an unavailable root and still scans the others', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* videoLibrary;
      yield* addRoot(path.join(library.path, 'missing'));
      yield* addRoot(library.path);
      const scanId = yield* queueScan(null);
      yield* scanner().run(scanId);
      expect(yield* scanRow(scanId)).toMatchObject({ state: 'completed', videos_seen: 3, errors_count: 2 });
      expect(yield* sql`select error_code from scan_errors where scan_run_id = ${scanId} order by error_code`).toEqual([
        { error_code: 'FFPROBE_FAILED' },
        { error_code: 'ROOT_UNAVAILABLE' },
      ]);
    }),
  );

  it.effect('assigns the best-ranked folder artwork to music and updates it when it changes', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* emptyLibrary;
      yield* library.write('Album/cover.jpg', 'jpeg');
      yield* library.write('Album/folder.png', 'png');
      yield* library.write('Album/Disc 1/01 Song.mp3');
      const rootId = yield* addRoot(library.path, 'music');
      yield* scanner().run(yield* queueScan(rootId));

      const artwork = sql<{ relative_path: string; artwork: string | null }>`
        select e.relative_path, a.relative_path as artwork from media_entries e
        left join media_entries a on a.id = e.artwork_media_entry_id
        where e.kind = 'directory' or e.is_audio order by e.relative_path`;
      expect(yield* artwork).toEqual([
        { relative_path: 'Album', artwork: 'Album/cover.jpg' },
        { relative_path: 'Album/Disc 1', artwork: 'Album/cover.jpg' },
        { relative_path: 'Album/Disc 1/01 Song.mp3', artwork: 'Album/cover.jpg' },
      ]);

      yield* library.remove('Album/cover.jpg');
      yield* scanner().run(yield* queueScan(rootId));
      expect((yield* artwork).map((row) => row.artwork)).toEqual([
        'Album/folder.png',
        'Album/folder.png',
        'Album/folder.png',
      ]);
    }),
  );

  it.effect('stores a mix’s chapters and its own cover, and replaces the chapters when the file changes', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const library = yield* emptyLibrary;
      yield* library.write('Chrysalis/cover.jpg', 'jpeg');
      yield* library.write('Chrysalis/Late Mix [rBarjCP_KUs].opus', 'mix');
      yield* library.write('Chrysalis/Late Mix [rBarjCP_KUs].jpg', 'jpeg');
      const rootId = yield* addRoot(library.path, 'music');
      yield* scanner().run(yield* queueScan(rootId));

      expect(
        yield* sql`select e.title, e.artist, a.relative_path as artwork from media_entries e
          join media_entries a on a.id = e.artwork_media_entry_id where e.is_audio`,
      ).toEqual([{ title: 'Late Mix', artist: 'Chrysalis', artwork: 'Chrysalis/Late Mix [rBarjCP_KUs].jpg' }]);
      const chapters = sql`
        select c.position, c.start_ms::int, c.end_ms::int, c.title from media_chapters c
        join media_entries e on e.id = c.media_entry_id order by c.position`;
      // The last chapter ends after the file does, so it is cut at the file's duration.
      expect(yield* chapters).toEqual([
        { position: 0, start_ms: 0, end_ms: 200_000, title: 'Intro' },
        { position: 1, start_ms: 200_000, end_ms: 600_000, title: 'Second Song' },
      ]);

      yield* library.write('Chrysalis/Late Mix [rBarjCP_KUs].opus', 'mix, recut');
      yield* scanner().run(yield* queueScan(rootId));
      expect(yield* chapters).toEqual([{ position: 0, start_ms: 0, end_ms: 600_000, title: 'Whole Mix' }]);
    }),
  );
});

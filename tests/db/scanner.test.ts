import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/lib/server/db/service';
import { MediaProcessRunner, ProcessExited, type ProcessRequest } from '../../src/lib/server/media/process-runner';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { ScanEvents } from '../../src/lib/server/scans/events';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { ScanId } from '../../src/lib/shared/contracts/ids';
import { testConfig } from '../support/config';
import { fakeFileSystem } from '../support/fakes';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
let library: string;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate scan_runs, media_roots cascade');
  if (library) await rm(library, { recursive: true, force: true });
  library = await mkdtemp(path.join(tmpdir(), 'fern-scan-'));
});

async function write(relativePath: string, contents = 'media') {
  const file = path.join(library, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function ffprobeJson(file: string) {
  const name = path.basename(file);
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

/** Answers ffprobe with canned JSON, fails for files named "broken", and records probe concurrency. */
function fakeFfprobe() {
  const stats = { calls: [] as string[], active: 0, maxActive: 0 };
  const layer = Layer.succeed(MediaProcessRunner, {
    run: (request: ProcessRequest) =>
      Effect.gen(function* () {
        const file = request.args.at(-1)!;
        stats.calls.push(path.basename(file));
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        yield* Effect.sleep('10 millis').pipe(Effect.ensuring(Effect.sync(() => stats.active--)));
        if (file.includes('broken'))
          return yield* new ProcessExited({ program: 'ffprobe', code: 1, signal: null, stderr: 'Invalid data found' });
        return { stdout: Buffer.from(JSON.stringify(ffprobeJson(file))), stderr: '', durationMs: 10 };
      }),
  });
  return { stats, layer };
}

function scanner(runner = fakeFfprobe(), fileSystem: Layer.Layer<FileSystem> = FileSystem.layer) {
  const layer = Scanner.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        database.layer,
        testConfig({ SCAN_PROBE_CONCURRENCY: '2' }),
        fileSystem,
        runner.layer,
        ScanEvents.layer,
      ),
    ),
  );
  return {
    runner,
    run: (scanId: string) =>
      Effect.runPromise(
        Effect.provide(
          Scanner.use((s) => s.run(ScanId.make(scanId))),
          layer,
        ),
      ),
  };
}

async function addRoot(rootPath: string, mediaType: 'video' | 'music' = 'video') {
  const id = randomUUID();
  await database.pool.query(
    `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Root', $3)`,
    [id, rootPath, mediaType],
  );
  return id;
}

async function queueScan(rootId: string | null) {
  const id = randomUUID();
  await database.pool.query(`insert into scan_runs (id, state, root_id) values ($1, 'queued', $2)`, [id, rootId]);
  return id;
}

const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await database.pool.query(text, params)).rows as T[];

async function scanRow(id: string) {
  return (await query('select * from scan_runs where id = $1', [id]))[0];
}

describe('Scanner', () => {
  beforeEach(async () => {
    await write('Movies/Direct Play.mp4');
    await write('Movies/Direct Play.en.srt', '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
    await write('Movies/broken.avi');
    await write('Shows/Season 1/Episode 1.mkv');
    await write('Shows/notes.txt', 'not media');
  });

  it('indexes entries, tracks, and subtitles and records probe failures with their paths', async () => {
    const rootId = await addRoot(library);
    const scanId = await queueScan(rootId);
    await scanner().run(scanId);

    expect(await scanRow(scanId)).toMatchObject({
      state: 'completed',
      directories_seen: 3,
      files_seen: 5,
      videos_seen: 3,
      audio_seen: 0,
      files_probed: 2,
      errors_count: 1,
    });
    const entries = await query<{ relative_path: string; probe_status: string; parent: string | null }>(
      `select e.relative_path, e.probe_status, p.relative_path as parent
       from media_entries e left join media_entries p on p.id = e.parent_id order by e.relative_path`,
    );
    expect(entries).toEqual([
      { relative_path: 'Movies', probe_status: 'not_required', parent: null },
      { relative_path: 'Movies/Direct Play.en.srt', probe_status: 'not_required', parent: 'Movies' },
      { relative_path: 'Movies/Direct Play.mp4', probe_status: 'ok', parent: 'Movies' },
      { relative_path: 'Movies/broken.avi', probe_status: 'failed', parent: 'Movies' },
      { relative_path: 'Shows', probe_status: 'not_required', parent: null },
      { relative_path: 'Shows/Season 1', probe_status: 'not_required', parent: 'Shows' },
      { relative_path: 'Shows/Season 1/Episode 1.mkv', probe_status: 'ok', parent: 'Shows/Season 1' },
      { relative_path: 'Shows/notes.txt', probe_status: 'not_required', parent: 'Shows' },
    ]);
    expect(await query('select count(*)::int as count from media_tracks')).toEqual([{ count: 5 }]);
    expect(await query('select relative_path, format from external_subtitles')).toEqual([
      { relative_path: 'Movies/Direct Play.en.srt', format: 'srt' },
    ]);
    expect(
      await query('select stage, error_code, relative_path from scan_errors where scan_run_id = $1', [scanId]),
    ).toEqual([{ stage: 'probe', error_code: 'FFPROBE_FAILED', relative_path: 'Movies/broken.avi' }]);
  });

  it('can run the same scan again without duplicating entries, tracks, or errors', async () => {
    const rootId = await addRoot(library);
    const scanId = await queueScan(rootId);
    await scanner().run(scanId);
    const firstIds = await query('select id, relative_path from media_entries order by relative_path');

    // A redelivered scan finds itself running (for example after a crash) and runs again.
    await database.pool.query(`update scan_runs set state = 'running' where id = $1`, [scanId]);
    await database.pool.query(`update media_entries set probe_status = 'pending' where relative_path like '%.mp4'`);
    await scanner().run(scanId);

    expect(await query('select id, relative_path from media_entries order by relative_path')).toEqual(firstIds);
    expect(await query('select count(*)::int as count from media_tracks')).toEqual([{ count: 5 }]);
    expect(await query('select count(*)::int as count from scan_errors where scan_run_id = $1', [scanId])).toEqual([
      { count: 1 },
    ]);
    expect((await scanRow(scanId)).state).toBe('completed');
  });

  it('leaves a completed scan alone when it is delivered again', async () => {
    const rootId = await addRoot(library);
    const scanId = await queueScan(rootId);
    await scanner().run(scanId);
    const again = scanner();
    await again.run(scanId);
    expect(again.runner.stats.calls).toEqual([]);
  });

  it('rewrites and probes only files that still need probing when nothing changed', async () => {
    const rootId = await addRoot(library);
    await scanner().run(await queueScan(rootId));
    const unchanged = `select id, updated_at from media_entries where relative_path <> 'Movies/broken.avi' order by id`;
    const updatedAt = await query(unchanged);

    const rescan = scanner();
    await rescan.run(await queueScan(rootId));
    // Only the file that failed to probe is tried again.
    expect(rescan.runner.stats.calls).toEqual(['broken.avi']);
    expect(await query(unchanged)).toEqual(updatedAt);
  });

  it('probes changed files only, and never more at once than configured', async () => {
    for (let index = 0; index < 12; index++) await write(`Batch/clip-${index}.mp4`);
    const rootId = await addRoot(library);
    const first = scanner();
    await first.run(await queueScan(rootId));
    expect(first.runner.stats.maxActive).toBeLessThanOrEqual(2);
    expect(first.runner.stats.maxActive).toBeGreaterThan(1);

    await write('Batch/clip-3.mp4', 'a longer file now');
    const rescan = scanner();
    await rescan.run(await queueScan(rootId));
    expect(rescan.runner.stats.calls.sort()).toEqual(['broken.avi', 'clip-3.mp4']);
  });

  it('removes entries whose files are gone', async () => {
    const rootId = await addRoot(library);
    await scanner().run(await queueScan(rootId));
    await rm(path.join(library, 'Shows'), { recursive: true });
    await scanner().run(await queueScan(rootId));
    expect(
      await query(`select relative_path from media_entries where deleted_at is not null order by relative_path`),
    ).toEqual([
      { relative_path: 'Shows' },
      { relative_path: 'Shows/Season 1' },
      { relative_path: 'Shows/Season 1/Episode 1.mkv' },
      { relative_path: 'Shows/notes.txt' },
    ]);
  });

  it('keeps entries under a folder that could not be read', async () => {
    const tree = fakeFileSystem(
      {
        '/library/Movies/a.mp4': { size: 5 },
        '/library/Locked/b.mp4': { size: 5 },
      },
      { denied: ['/library/Locked'] },
    );
    const rootId = await addRoot('/library');
    const scanId = await queueScan(rootId);
    // Index both folders first, then make one unreadable.
    await scanner(
      fakeFfprobe(),
      fakeFileSystem({ '/library/Movies/a.mp4': { size: 5 }, '/library/Locked/b.mp4': { size: 5 } }),
    ).run(scanId);
    const second = await queueScan(rootId);
    await scanner(fakeFfprobe(), tree).run(second);

    expect(await query(`select count(*)::int as count from media_entries where deleted_at is not null`)).toEqual([
      { count: 0 },
    ]);
    expect(await query('select stage, error_code from scan_errors where scan_run_id = $1', [second])).toEqual([
      { stage: 'walk', error_code: 'PATH_UNREADABLE' },
    ]);
  });

  it('records an unavailable root and still scans the others', async () => {
    await addRoot(path.join(library, 'missing'));
    await addRoot(library);
    const scanId = await queueScan(null);
    await scanner().run(scanId);
    expect(await scanRow(scanId)).toMatchObject({ state: 'completed', videos_seen: 3, errors_count: 2 });
    expect(
      await query('select error_code from scan_errors where scan_run_id = $1 order by error_code', [scanId]),
    ).toEqual([{ error_code: 'FFPROBE_FAILED' }, { error_code: 'ROOT_UNAVAILABLE' }]);
  });

  it('assigns the best-ranked folder artwork to music and updates it when it changes', async () => {
    await rm(library, { recursive: true, force: true });
    await write('Album/cover.jpg', 'jpeg');
    await write('Album/folder.png', 'png');
    await write('Album/Disc 1/01 Song.mp3');
    const rootId = await addRoot(library, 'music');
    await scanner().run(await queueScan(rootId));

    const artwork = async () =>
      query<{ relative_path: string; artwork: string | null }>(
        `select e.relative_path, a.relative_path as artwork from media_entries e
         left join media_entries a on a.id = e.artwork_media_entry_id
         where e.kind = 'directory' or e.is_audio order by e.relative_path`,
      );
    expect(await artwork()).toEqual([
      { relative_path: 'Album', artwork: 'Album/cover.jpg' },
      { relative_path: 'Album/Disc 1', artwork: 'Album/cover.jpg' },
      { relative_path: 'Album/Disc 1/01 Song.mp3', artwork: 'Album/cover.jpg' },
    ]);

    await rm(path.join(library, 'Album', 'cover.jpg'));
    await scanner().run(await queueScan(rootId));
    expect((await artwork()).map((row) => row.artwork)).toEqual([
      'Album/folder.png',
      'Album/folder.png',
      'Album/folder.png',
    ]);
  });
});

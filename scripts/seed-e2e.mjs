import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { query } from './compose-psql.mjs';

const root = process.cwd();
const media = path.join(root, 'mock-media').replaceAll('\\', '/');
const profileId = '10000000-0000-4000-8000-000000000001';
const rootId = '20000000-0000-4000-8000-000000000001';
const currentId = '30000000-0000-4000-8000-000000000001';
const nextId = '30000000-0000-4000-8000-000000000002';

function completed(child) {
  return new Promise((resolve, reject) =>
    child
      .once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Command exited ${code}`))))
      .once('error', reject),
  );
}

const sourceMedia = path.join(media, 'Movies', 'Direct Play Demo.mp4');
try {
  await access(sourceMedia);
} catch {
  await completed(spawn('pnpm', ['mockmedia'], { cwd: root, shell: true, stdio: 'inherit' }));
}
const nextMedia = path.join(media, 'Movies', 'Next Episode.mp4');
await copyFile(sourceMedia, nextMedia);
const sourceStat = await stat(sourceMedia);
const nextStat = await stat(nextMedia);

await query(`
  insert into profiles (id, name, avatar_key)
  values ('${profileId}', 'Playwright', 'fern')
  on conflict (id) do update set name = excluded.name, avatar_key = excluded.avatar_key
`);
await query(`
  insert into media_roots (id, path, display_name, media_type)
  values ('${rootId}', '${media.replaceAll("'", "''")}', 'Test media', 'video')
  on conflict (id) do update set path = excluded.path, display_name = excluded.display_name
`);
await query(`
  insert into media_entries
    (id, media_root_id, relative_path, name, kind, sort_order, extension, size_bytes, mtime_ms, is_video, duration_ms, container, video_codec, audio_codec_summary, width, height, probe_status)
  values
    ('${currentId}', '${rootId}', 'Movies/Direct Play Demo.mp4', 'Direct Play Demo.mp4', 'file', 0, '.mp4', ${sourceStat.size}, ${Math.round(sourceStat.mtimeMs)}, true, 45000, 'mp4', 'h264', 'aac', 320, 180, 'ok'),
    ('${nextId}', '${rootId}', 'Movies/Next Episode.mp4', 'Next Episode.mp4', 'file', 1, '.mp4', ${nextStat.size}, ${Math.round(nextStat.mtimeMs)}, true, 45000, 'mp4', 'h264', 'aac', 320, 180, 'ok')
  on conflict (id) do update set
    media_root_id = excluded.media_root_id,
    relative_path = excluded.relative_path,
    name = excluded.name,
    size_bytes = excluded.size_bytes,
    mtime_ms = excluded.mtime_ms,
    probe_status = excluded.probe_status,
    deleted_at = null
`);

// A music root with catalog rows only, in a disposable folder: enough for browsing, search, and
// playlists without audio files. No test scans it.
const musicRootId = '20000000-0000-4000-8000-000000000003';
const musicPath = path.join(root, '.cache', 'e2e', 'music').replaceAll('\\', '/');
await mkdir(musicPath, { recursive: true });
await query(`
  insert into media_roots (id, path, display_name, media_type, display_order)
  values ('${musicRootId}', '${musicPath.replaceAll("'", "''")}', 'Test music', 'music', 98)
  on conflict (id) do update set path = excluded.path, display_name = excluded.display_name, media_type = 'music'
`);
await query(`
  insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms)
  values
    ('60000000-0000-4000-8000-000000000001', '${musicRootId}', null, 'Night Drive', 'Night Drive', 'directory', 0),
    ('60000000-0000-4000-8000-000000000002', '${musicRootId}', '60000000-0000-4000-8000-000000000001', 'Night Drive/Neon', 'Neon', 'directory', 0)
  on conflict (id) do update set deleted_at = null
`);
await query(`
  insert into media_entries
    (id, media_root_id, parent_id, relative_path, name, kind, extension, mtime_ms, is_audio, duration_ms, title, artist, album, track_number, probe_status)
  values
    ('60000000-0000-4000-8000-000000000011', '${musicRootId}', '60000000-0000-4000-8000-000000000002', 'Night Drive/Neon/01 Blue Hour.flac', '01 Blue Hour.flac', 'file', '.flac', 0, true, 200000, 'Blue Hour', 'Night Drive', 'Neon', 1, 'ok'),
    ('60000000-0000-4000-8000-000000000012', '${musicRootId}', '60000000-0000-4000-8000-000000000002', 'Night Drive/Neon/02 Glass City.flac', '02 Glass City.flac', 'file', '.flac', 0, true, 210000, 'Glass City', 'Night Drive', 'Neon', 2, 'ok'),
    ('60000000-0000-4000-8000-000000000013', '${musicRootId}', '60000000-0000-4000-8000-000000000002', 'Night Drive/Neon/03 Blue Signal.flac', '03 Blue Signal.flac', 'file', '.flac', 0, true, 220000, 'Blue Signal', 'Night Drive', 'Neon', 3, 'ok')
  on conflict (id) do update set deleted_at = null, title = excluded.title, album = excluded.album, track_number = excluded.track_number
`);
// Playlists left by earlier runs of the music tests.
await query(`delete from playlists where profile_id = '${profileId}' and name like 'E2E %'`);

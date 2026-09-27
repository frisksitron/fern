/**
 * Visible scan behavior and the scan-dependent playback contracts:
 * HLS sessions, audio-track sessions, external subtitles, and unplayable media.
 *
 * The test scans a dedicated, disposable media root so it never touches the seeded
 * mock-media root (whose entries other specs expect at the root level) or real libraries.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../scripts/compose-psql.mjs';

const profileId = '10000000-0000-4000-8000-000000000001';
const rootId = '20000000-0000-4000-8000-000000000002';
const rootName = 'E2E scan media';
const mediaRoot = path.resolve('.cache', 'e2e', 'scan-media');
const fixtures = [
  'Movies/Direct Play Demo.mp4',
  'Movies/Direct Play Demo.en.srt',
  'Movies/Broken Sample.avi',
  'Anime/Demo Show/01 - Multi Audio.mkv',
];

test.describe.configure({ mode: 'serial' });

let scanId: string;

async function removeRoot() {
  await query(`delete from media_roots where id = '${rootId}'`);
}

async function entryId(relativePath: string) {
  const id = await query(
    `select id from media_entries where media_root_id = '${rootId}' and relative_path = '${relativePath}' and deleted_at is null`,
  );
  expect(id, `indexed entry for ${relativePath}`).toMatch(/^[0-9a-f-]{36}$/);
  return String(id);
}

async function plan(request: APIRequestContext, relativePath: string) {
  const response = await request.get(`/api/playback/${await entryId(relativePath)}/plan`);
  expect(response.status()).toBe(200);
  return response.json();
}

test.beforeAll(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
  for (const fixture of fixtures) {
    const target = path.join(mediaRoot, ...fixture.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join('mock-media', ...fixture.split('/')), target);
  }
  await removeRoot();
  const rootPath = mediaRoot.replaceAll('\\', '/').replaceAll("'", "''");
  await query(
    `insert into media_roots (id, path, display_name, media_type, display_order) values ('${rootId}', '${rootPath}', '${rootName}', 'video', 99)`,
  );
});

test.afterAll(async () => {
  await removeRoot();
  await rm(mediaRoot, { recursive: true, force: true });
});

test('scans one media root from the settings page and reports completion', async ({ page, context, request }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto('/settings/media');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  const row = page.locator('section > div').filter({ has: page.getByRole('heading', { name: rootName, exact: true }) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText('Not scanned yet')).toBeVisible();

  const [started] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/scans') && response.request().method() === 'POST'),
    row.getByRole('button', { name: 'Scan', exact: true }).click(),
  ]);
  expect(started.status()).toBe(202);
  ({ scanId } = await started.json());
  expect(scanId).toMatch(/^[0-9a-f-]{36}$/);

  await expect(page.getByText('Scan completed. 4 files · 3 videos · 0 songs · 1 errors')).toBeVisible({
    timeout: 60_000,
  });
  await expect(row.getByText(/^Last scanned /)).toBeVisible({ timeout: 15_000 });
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/scan-completed.png', fullPage: true });

  const scan = await (await request.get(`/api/scans/${scanId}`)).json();
  expect(scan).toMatchObject({
    id: scanId,
    state: 'completed',
    directoriesSeen: 3,
    filesSeen: 4,
    videosSeen: 3,
    audioSeen: 0,
    filesProbed: 2,
    errorsCount: 1,
    errorSummary: null,
    startedAt: expect.any(String),
    completedAt: expect.any(String),
  });
  // Probe failures record the file's relative path.
  expect(
    await query(
      `select stage || '|' || error_code || '|' || relative_path from scan_errors where scan_run_id = '${scanId}'`,
    ),
  ).toBe('probe|FFPROBE_FAILED|Movies/Broken Sample.avi');
});

test('admits one scan at a time', async ({ request }) => {
  const responses = await Promise.all([
    request.post('/api/scans', { data: { rootId } }),
    request.post('/api/scans', { data: { rootId } }),
  ]);
  expect(responses.map((response) => response.status()).sort()).toEqual([202, 409]);
  const rejected = responses.find((response) => response.status() === 409)!;
  expect(await rejected.json()).toEqual({ code: 'scan.already_running', message: expect.any(String) });

  const { scanId: admitted } = await responses.find((response) => response.status() === 202)!.json();
  await expect
    .poll(async () => (await (await request.get(`/api/scans/${admitted}`)).json()).state, { timeout: 60_000 })
    .toBe('completed');
});

test('replays a completed scan as one server-sent snapshot event and closes', async () => {
  const response = await fetch(`http://127.0.0.1:5173/api/scans/${scanId}/events`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const events = await response.text();
  expect(events).toMatch(/^event: scan\.snapshot\ndata: [^\n]*\n\n$/);
  expect(JSON.parse(events.split('\n')[1].slice('data: '.length))).toMatchObject({
    id: scanId,
    state: 'completed',
    rootId,
  });
});

test('plans direct play, HLS, and unplayable media from probe results', async ({ request }) => {
  const direct = await plan(request, 'Movies/Direct Play Demo.mp4');
  expect(direct).toMatchObject({ mode: 'direct', durationMs: 45000 });
  expect(direct.audioTracks).toHaveLength(1);
  expect(direct.subtitleTracks).toEqual([
    { id: expect.any(String), name: 'Direct Play Demo.en.srt', format: 'srt', language: null, kind: 'external' },
  ]);

  const subtitle = await request.get(`/api/subtitles/${direct.subtitleTracks[0].id}`);
  expect(subtitle.status()).toBe(200);
  expect(subtitle.headers()['content-type']).toBe('text/vtt; charset=utf-8');
  expect(await subtitle.text()).toMatch(/^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:05\.000\nWelcome to Fern\./);

  const multiAudio = await plan(request, 'Anime/Demo Show/01 - Multi Audio.mkv');
  expect(multiAudio).toMatchObject({ mode: 'hls', subtitleTracks: [] });
  expect(multiAudio.url).toBeUndefined();
  expect(multiAudio.durationMs).toBeGreaterThanOrEqual(45000);
  expect(
    multiAudio.audioTracks.map((track: { streamIndex: number; language: string; kind: string }) => [
      track.streamIndex,
      track.language,
      track.kind,
    ]),
  ).toEqual([
    [1, 'jpn', 'audio'],
    [2, 'eng', 'audio'],
  ]);

  expect(await plan(request, 'Movies/Broken Sample.avi')).toEqual({
    mode: 'unplayable',
    reason: 'Could not inspect this media file.',
  });
});

test('explains unplayable media on the watch page', async ({ page, context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto(`/watch/${await entryId('Movies/Broken Sample.avi')}`);
  // The overlay sits inside media-chrome's controller, which Playwright's visibility check does not see through.
  await expect(page.getByText('Could not inspect this media file.')).toBeAttached();
  await expect(page.getByRole('link', { name: 'Back to media folder' }).first()).toBeAttached();
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/unplayable-media.png' });
});

test('serves on-demand HLS sessions per audio track', async ({ request }) => {
  test.setTimeout(120_000);
  const id = await entryId('Anime/Demo Show/01 - Multi Audio.mkv');
  const durationMs = (await plan(request, 'Anime/Demo Show/01 - Multi Audio.mkv')).durationMs as number;

  const created = await request.post(`/api/playback/${id}/session`, { data: { audioStream: null } });
  expect(created.status()).toBe(201);
  const { sessionId, manifestUrl } = await created.json();
  expect(sessionId).toMatch(/^[a-f0-9]{64}$/);
  expect(manifestUrl).toBe(`/hls/${sessionId}/master.m3u8`);

  const manifest = await request.get(manifestUrl);
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()).toMatchObject({
    'content-type': 'application/vnd.apple.mpegurl',
    'cache-control': 'no-cache',
  });
  const playlist = await manifest.text();
  expect(playlist.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n')).toBe(
    true,
  );
  expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  expect(playlist.match(/^segment-\d{5}\.ts$/gm)).toHaveLength(Math.ceil(durationMs / 6000));

  const segment = await request.get(`/hls/${sessionId}/segment-00000.ts`, { timeout: 90_000 });
  expect(segment.status()).toBe(200);
  expect(segment.headers()).toMatchObject({
    'content-type': 'video/mp2t',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  expect((await segment.body())[0]).toBe(0x47);

  const beyondEnd = await request.get(`/hls/${sessionId}/segment-00099.ts`);
  expect(beyondEnd.status()).toBe(404);

  const english = await request.post(`/api/playback/${id}/session`, { data: { audioStream: 2 } });
  expect(english.status()).toBe(201);
  expect((await english.json()).sessionId).not.toBe(sessionId);

  const missingTrack = await request.post(`/api/playback/${id}/session`, { data: { audioStream: 7 } });
  expect(missingTrack.status()).toBe(404);
  expect(await missingTrack.json()).toEqual({ code: 'playback.audio_stream_not_found', message: expect.any(String) });
});

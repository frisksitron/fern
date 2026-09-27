/**
 * The HTTP contracts Fern exposes: status codes, headers, and response shapes. When a contract
 * changes on purpose, update the assertion in the same commit.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

const mediaId = '30000000-0000-4000-8000-000000000001';
const missingId = '00000000-0000-4000-8000-00000000abcd';

test.describe('health', () => {
  test('reports liveness and database readiness', async ({ request }) => {
    const live = await request.get('/health/live');
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });

    const ready = await request.get('/health/ready');
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', ffmpeg: 'ok', ffprobe: 'ok' },
    });
  });

  test('tags every API response with a request ID, keeping a well-formed caller ID', async ({ request }) => {
    const generated = await request.get('/health/ready');
    expect(generated.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const given = await request.get('/api/scans', { headers: { 'x-request-id': 'e2e-trace-1' } });
    expect(given.headers()['x-request-id']).toBe('e2e-trace-1');
  });

  test('explains the scan worker and recent scans for operators', async ({ request }) => {
    const diagnostics = await request.get('/health/scans');
    expect(diagnostics.status()).toBe(200);
    const body = await diagnostics.json();
    expect(body).toMatchObject({ workerLockHeld: true, worker: { leader: true } });
    expect(Array.isArray(body.recentFailures)).toBe(true);
  });
});

test.describe('playback plan', () => {
  test('plans direct play for H.264/AAC MP4', async ({ request }) => {
    const response = await request.get(`/api/playback/${mediaId}/plan`);
    expect(response.status()).toBe(200);
    const plan = await response.json();
    expect(plan).toMatchObject({ mode: 'direct', url: `/stream/${mediaId}`, durationMs: 45000 });
    expect(plan.sessionUrl).toBeUndefined();
    expect(Array.isArray(plan.audioTracks)).toBe(true);
    expect(Array.isArray(plan.subtitleTracks)).toBe(true);
  });

  test('falls back to HLS when the client reports no H.264 support', async ({ request }) => {
    const plan = await (await request.get(`/api/playback/${mediaId}/plan?h264=false`)).json();
    expect(plan).toMatchObject({ mode: 'hls', sessionUrl: `/api/playback/${mediaId}/session` });
    expect(plan.url).toBeUndefined();
  });

  // Missing media is a 404 error, not an "unplayable" plan; malformed IDs are 400.
  test('rejects missing media with 404 and malformed IDs with 400', async ({ request }) => {
    const missing = await request.get(`/api/playback/${missingId}/plan`);
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ code: 'media.not_found', message: expect.any(String) });

    const malformed = await request.get('/api/playback/not-a-uuid/plan');
    expect(malformed.status()).toBe(400);
    expect(await malformed.json()).toEqual({ code: 'request.invalid', message: expect.any(String) });
  });

  test('rejects sessions for missing media with 404 and invalid audio streams with 400', async ({ request }) => {
    const missing = await request.post(`/api/playback/${missingId}/session`, { data: { audioStream: null } });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ code: 'media.not_found', message: expect.any(String) });

    const negative = await request.post(`/api/playback/${mediaId}/session`, { data: { audioStream: -1 } });
    expect(negative.status()).toBe(400);
    expect(await negative.json()).toEqual({ code: 'request.invalid', message: expect.any(String) });
  });
});

test.describe('direct streaming', () => {
  test('advertises byte ranges on HEAD', async ({ request }) => {
    const response = await request.head(`/stream/${mediaId}`);
    expect(response.status()).toBe(200);
    expect(response.headers()).toMatchObject({ 'accept-ranges': 'bytes', 'content-type': 'video/mp4' });
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(0);
  });

  test('serves satisfiable ranges with 206 and rejects others with 416', async ({ request }) => {
    const size = Number((await request.head(`/stream/${mediaId}`)).headers()['content-length']);

    const partial = await request.get(`/stream/${mediaId}`, { headers: { range: 'bytes=0-99' } });
    expect(partial.status()).toBe(206);
    expect(partial.headers()).toMatchObject({ 'content-range': `bytes 0-99/${size}`, 'content-length': '100' });
    expect((await partial.body()).subarray(4, 8).toString('ascii')).toBe('ftyp');

    const suffix = await request.get(`/stream/${mediaId}`, { headers: { range: 'bytes=-10' } });
    expect(suffix.status()).toBe(206);
    expect(suffix.headers()['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);

    const unsatisfiable = await request.get(`/stream/${mediaId}`, { headers: { range: `bytes=${size}-` } });
    expect(unsatisfiable.status()).toBe(416);
    expect(unsatisfiable.headers()['content-range']).toBe(`bytes */${size}`);
  });

  test('returns 404 for missing media and 400 for malformed IDs', async ({ request }) => {
    const response = await request.get(`/stream/${missingId}`);
    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({ code: 'media.not_found', message: expect.any(String) });
    expect((await request.get('/stream/not-a-uuid')).status()).toBe(400);
  });
});

test.describe('scans', () => {
  test('reports scan status and rejects unknown scans and roots', async ({ request }) => {
    const status = await request.get('/api/scans');
    expect(status.status()).toBe(200);
    const body = await status.json();
    expect(Object.keys(body)).toEqual(['scan']);
    if (body.scan !== null) expect(body.scan).toMatchObject({ id: expect.any(String), state: expect.any(String) });

    const unknownScan = await request.get(`/api/scans/${missingId}`);
    expect(unknownScan.status()).toBe(404);
    expect(await unknownScan.json()).toEqual({ code: 'scan.not_found', message: expect.any(String) });
    expect((await request.get('/api/scans/not-a-uuid')).status()).toBe(400);
    expect((await request.get('/api/scans/not-a-uuid/events')).status()).toBe(400);

    // An unknown root is 404 (409 while another scan runs); malformed bodies are 400.
    const unknownRoot = await request.post('/api/scans', { data: { rootId: missingId } });
    expect([404, 409]).toContain(unknownRoot.status());
    expect(await unknownRoot.json()).toMatchObject({
      code: expect.stringMatching(/^(media_root.not_found|scan.already_running)$/),
    });
    const malformed = await request.post('/api/scans', { data: { rootId: 'not-a-uuid' } });
    expect(malformed.status()).toBe(400);
  });
});

test.describe('filesystem browsing', () => {
  test('lists filesystem roots and rejects unresolvable paths with stable codes', async ({ request }) => {
    const roots = await request.get('/api/filesystem/directories');
    expect(roots.status()).toBe(200);
    const listing = await roots.json();
    expect(listing).toMatchObject({ currentPath: null, parentPath: null });
    expect(listing.directories.length).toBeGreaterThan(0);
    for (const directory of listing.directories)
      expect(directory).toEqual({ name: expect.any(String), path: expect.any(String) });

    // Missing paths are 404 and relative paths 400, with stable codes and no server paths in messages.
    const missing = await request.get(
      `/api/filesystem/directories?path=${encodeURIComponent('/fern-missing-directory')}`,
    );
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ code: 'filesystem.not_found', message: 'That folder does not exist.' });

    const relative = await request.get(`/api/filesystem/directories?path=${encodeURIComponent('relative/path')}`);
    expect(relative.status()).toBe(400);
    expect((await relative.json()).code).toBe('filesystem.path_invalid');
  });
});

test.describe('media assets', () => {
  test('renders JPEG thumbnails with a content-derived ETag', async ({ request }) => {
    const response = await request.get(`/api/media/${mediaId}/thumbnail?positionMs=1000`);
    expect(response.status()).toBe(200);
    expect(response.headers()).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'private, no-cache' });
    expect(response.headers().etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect((await response.body()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    const invalid = await request.get(`/api/media/${mediaId}/thumbnail?positionMs=later`);
    expect(invalid.status()).toBe(400);
    const missing = await request.get(`/api/media/${missingId}/thumbnail?positionMs=1000`);
    expect(missing.status()).toBe(404);
  });

  test('returns 404 for missing subtitles, artwork, and HLS files', async ({ request }) => {
    const subtitle = await request.get(`/api/subtitles/${missingId}`);
    expect(subtitle.status()).toBe(404);
    expect(await subtitle.json()).toEqual({ code: 'subtitle.not_found', message: expect.any(String) });
    expect((await request.get('/api/subtitles/not-a-uuid')).status()).toBe(400);

    const embedded = await request.get(`/api/media/${mediaId}/subtitles/99`);
    expect(embedded.status()).toBe(404);
    expect((await embedded.json()).code).toBe('subtitle.not_found');

    const artwork = await request.get(`/api/media/${mediaId}/artwork`);
    expect(artwork.status()).toBe(404);
    expect(await artwork.json()).toEqual({ code: 'artwork.not_found', message: expect.any(String) });

    for (const file of ['/hls/not-a-session/master.m3u8', `/hls/${'a'.repeat(64)}/segment-00000.ts`]) {
      const hls = await request.get(file);
      expect(hls.status()).toBe(404);
      expect(await hls.json()).toMatchObject({ code: 'hls.not_found' });
    }
  });
});

test.describe('media roots', () => {
  test('rejects removing unknown roots with 404 and malformed IDs with 400', async ({ request }) => {
    const missing = await request.delete(`/api/media-roots/${missingId}`);
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ code: 'media_root.not_found', message: expect.any(String) });
    const malformed = await request.delete('/api/media-roots/not-a-uuid');
    expect(malformed.status()).toBe(400);
    expect((await malformed.json()).code).toBe('request.invalid');
  });
});

test.describe('library pages', () => {
  const profile = 'profileId=10000000-0000-4000-8000-000000000001';
  const videoRoot = '20000000-0000-4000-8000-000000000001';

  /** The status and redirect target of a page, without following the redirect. */
  async function visit(request: APIRequestContext, path: string, cookie = profile) {
    const response = await request.get(path, { headers: { cookie }, maxRedirects: 0 });
    return { status: response.status(), location: response.headers()['location'] ?? null };
  }

  test('send malformed and unknown profile cookies back to profile selection', async ({ request }) => {
    expect(await visit(request, '/browse', 'profileId=not-a-uuid')).toEqual({ status: 303, location: '/' });
    expect(await visit(request, '/music', `profileId=${missingId}`)).toEqual({ status: 303, location: '/' });
  });

  test('redirect malformed and unknown roots, folders, and playlists instead of failing', async ({ request }) => {
    expect(await visit(request, '/browse/not-a-uuid')).toEqual({ status: 303, location: '/browse' });
    for (const folder of ['not-a-uuid', missingId])
      expect(await visit(request, `/browse/${videoRoot}/${folder}`)).toEqual({
        status: 303,
        location: `/browse/${videoRoot}`,
      });
    expect(await visit(request, '/music/playlist/not-a-uuid')).toEqual({ status: 303, location: '/music' });
    expect(await visit(request, `/browse/${videoRoot}`)).toEqual({ status: 200, location: null });
  });
});

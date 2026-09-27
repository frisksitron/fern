/**
 * Media-root creation through the settings UI and POST /api/media-roots. Fixture folders live in
 * a disposable directory, and every root created under it is removed afterwards.
 */
import { expect, test } from '@playwright/test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../scripts/compose-psql.mjs';

const fixture = path.resolve('.cache', 'e2e', 'add-root');
const profileId = '10000000-0000-4000-8000-000000000001';

test.describe.configure({ mode: 'serial' });

async function removeFixtureRoots() {
  const prefix = fixture.replaceAll('\\', '/').replaceAll("'", "''");
  await query(`delete from media_roots where starts_with(replace(path, '\\', '/'), '${prefix}')`);
}

test.beforeAll(async () => {
  await removeFixtureRoots();
  await rm(fixture, { recursive: true, force: true });
  await mkdir(path.join(fixture, 'Shows', 'Season 1'), { recursive: true });
  await mkdir(path.join(fixture, 'Movies'), { recursive: true });
  await writeFile(path.join(fixture, 'notes.txt'), 'not a folder');
  await symlink(path.join(fixture, 'Shows'), path.join(fixture, 'shows-alias'), 'junction');
});

test.afterAll(async () => {
  await removeFixtureRoots();
  await rm(fixture, { recursive: true, force: true });
});

test('adds a media folder from the picker and rejects an overlapping one', async ({ page, context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto(`/settings/media/add?type=video&path=${encodeURIComponent(fixture)}`);
  await expect(page.getByRole('heading', { name: 'Choose a video folder /' })).toBeVisible();
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  // The picker lists folders only; files and links are not offered.
  const folders = page.locator('section a', { hasNotText: 'Parent folder' });
  await expect(folders).toHaveText(['[dir] Movies', '[dir] Shows']);

  const shows = page.locator('section > div').filter({ hasText: 'Shows' });
  await shows.getByRole('button', { name: 'Select' }).click();
  await expect(page).toHaveURL('/settings/media');
  await expect(page.getByText('Added “Shows”.')).toBeVisible();
  const row = page.locator('section > div').filter({ has: page.getByRole('heading', { name: 'Shows', exact: true }) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText(path.join(fixture, 'Shows'))).toBeVisible();
  // The confirmation travels in navigation state, not the URL, so a reload does not repeat it.
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.getByText('Added “Shows”.')).toHaveCount(0);

  await page.goto(`/settings/media/add?type=music&path=${encodeURIComponent(path.join(fixture, 'Shows', 'Season 1'))}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await page.getByRole('button', { name: 'Select this folder' }).click();
  await expect(page.getByText('Media folders cannot overlap.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/media\/add\?/);
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/media-root-overlap.png', fullPage: true });
});

test('shows a stable message when browsing a missing folder', async ({ page }) => {
  await page.goto(`/settings/media/add?type=video&path=${encodeURIComponent(path.join(fixture, 'missing'))}`);
  await expect(page.getByText('That folder does not exist.')).toBeVisible();
  await expect(page.getByText(fixture)).toHaveCount(1); // only the breadcrumb, never the error
});

test('creates roots on the server with canonical paths and typed failures', async ({ request }) => {
  const post = (body: unknown) => request.post('/api/media-roots', { data: body });

  const created = await post({ path: `${path.join(fixture, 'Movies')}${path.sep}`, mediaType: 'music' });
  expect(created.status()).toBe(201);
  expect(await created.json()).toEqual({
    root: {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      path: path.join(fixture, 'Movies'),
      displayName: 'Movies',
      mediaType: 'music',
      displayOrder: expect.any(Number),
    },
  });

  const failures: Array<[unknown, number, string]> = [
    [{ path: path.join(fixture, 'shows-alias'), mediaType: 'video' }, 409, 'media_root.overlap'],
    [{ path: path.join(fixture, 'Movies', '..', 'Movies'), mediaType: 'video' }, 409, 'media_root.overlap'],
    [{ path: path.join(fixture, 'notes.txt'), mediaType: 'video' }, 400, 'filesystem.not_a_directory'],
    [{ path: path.join(fixture, 'missing'), mediaType: 'video' }, 404, 'filesystem.not_found'],
    [{ path: 'relative/folder', mediaType: 'video' }, 400, 'filesystem.path_invalid'],
    [{ path: fixture, mediaType: 'photos' }, 400, 'request.invalid'],
    [{ path: '' }, 400, 'request.invalid'],
  ];
  for (const [body, status, code] of failures) {
    const response = await post(body);
    expect(response.status(), JSON.stringify(body)).toBe(status);
    const error = await response.json();
    expect(error).toEqual({ code, message: expect.any(String) });
    expect(error.message).not.toContain(fixture);
  }

  const notJson = await request.post('/api/media-roots', {
    headers: { 'content-type': 'application/json' },
    data: '{',
  });
  expect(notJson.status()).toBe(400);
  expect((await notJson.json()).code).toBe('request.invalid');
});

test('removes a media folder from the settings page', async ({ page, context, request }) => {
  await mkdir(path.join(fixture, 'Removable'), { recursive: true });
  const created = await request.post('/api/media-roots', {
    data: { path: path.join(fixture, 'Removable'), mediaType: 'video' },
  });
  expect(created.status()).toBe(201);

  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto('/settings/media');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const row = page
    .locator('section > div')
    .filter({ has: page.getByRole('heading', { name: 'Removable', exact: true }) });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove folder /' });
  await expect(dialog).toContainText('No media files are deleted.');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/media-root-removed.png', fullPage: true });
});

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { query } from '../../scripts/compose-psql.mjs';

// Seeded by scripts/seed-e2e.mjs: catalog rows for one artist folder, one album, and three tracks.
const profileId = '10000000-0000-4000-8000-000000000001';
const musicRootId = '20000000-0000-4000-8000-000000000003';
const artistId = '60000000-0000-4000-8000-000000000001';
const tracks = {
  blueHour: '60000000-0000-4000-8000-000000000011',
  glassCity: '60000000-0000-4000-8000-000000000012',
  blueSignal: '60000000-0000-4000-8000-000000000013',
};

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
});

test('searches music on the server and shows only matching tracks', async ({ page }) => {
  await page.goto('/music/search?q=blue');
  await expect(page.getByText('Blue Hour')).toBeVisible();
  await expect(page.getByText('Blue Signal')).toBeVisible();
  await expect(page.getByText('Glass City')).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Search music' }).fill('no such song');
  await expect(page.getByText('No music found for “no such song”.')).toBeVisible();
  await mkdir('test-results/screenshots', { recursive: true });
  await page.getByRole('searchbox', { name: 'Search music' }).fill('glass');
  await expect(page.getByText('Glass City')).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/music-search.png', fullPage: true });
});

test('creates a playlist from a dragged folder, including its subfolders', async ({ page }) => {
  await page.goto(`/music/${musicRootId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const folder = page.getByRole('link', { name: 'Night Drive' }).first();
  await expect(folder).toBeVisible();
  await folder.dragTo(page.getByRole('button', { name: 'Create playlist' }));
  const dialog = page.getByRole('dialog', { name: 'New playlist /' });
  await expect(dialog.getByLabel('Name')).toHaveValue('Night Drive');
  await dialog.getByLabel('Name').fill('E2E Night Drive');
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('link', { name: 'E2E Night Drive' })).toBeVisible();
  await expect
    .poll(() =>
      query(`
        select string_agg(i.media_entry_id::text, ',' order by i.position)
        from playlist_items i join playlists p on p.id = i.playlist_id
        where p.profile_id = '${profileId}' and p.name = 'E2E Night Drive'`),
    )
    .toBe([tracks.blueHour, tracks.glassCity, tracks.blueSignal].join(','));

  await page.getByRole('link', { name: 'E2E Night Drive' }).click();
  await expect(page.getByText('Glass City')).toBeVisible();
  await expect(page.getByText('Blue Signal')).toBeVisible();
});

test('reorders a playlist by dragging a song’s handle or with Alt and the arrow keys', async ({ page }) => {
  const playlistId = randomUUID();
  await query(`insert into playlists (id, profile_id, name) values ('${playlistId}', '${profileId}', 'E2E Reorder')`);
  await query(`
    insert into playlist_items (id, playlist_id, media_entry_id, position) values
      ('${randomUUID()}', '${playlistId}', '${tracks.blueHour}', 0),
      ('${randomUUID()}', '${playlistId}', '${tracks.glassCity}', 1),
      ('${randomUUID()}', '${playlistId}', '${tracks.blueSignal}', 2)`);
  const savedOrder = () =>
    query(`
      select string_agg(t.title, ',' order by i.position)
      from playlist_items i join media_entries t on t.id = i.media_entry_id
      where i.playlist_id = '${playlistId}'`);
  const shownOrder = () =>
    page
      .locator('[data-track-id]')
      .evaluateAll((rows) => rows.map((row) => row.querySelector('p')?.textContent?.trim()));

  await page.goto(`/music/playlist/${playlistId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect.poll(shownOrder).toEqual(['Blue Hour', 'Glass City', 'Blue Signal']);

  // Drag Blue Signal's handle onto the first row.
  const handle = page.getByRole('button', { name: 'Move Blue Signal', exact: true });
  const target = await page.locator('[data-track-id]').first().boundingBox();
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(target!.x + 200, target!.y + target!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(shownOrder).toEqual(['Blue Signal', 'Blue Hour', 'Glass City']);
  await expect.poll(savedOrder).toBe('Blue Signal,Blue Hour,Glass City');
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/playlist-reorder.png', fullPage: true });

  // Alt with the arrow keys moves the focused song, and keeps the focus on it.
  await page.getByRole('row', { name: 'Glass City', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(shownOrder).toEqual(['Blue Signal', 'Glass City', 'Blue Hour']);
  await expect(page.getByRole('row', { name: 'Glass City', exact: true })).toBeFocused();
  await expect.poll(savedOrder).toBe('Blue Signal,Glass City,Blue Hour');

  await page.reload();
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect.poll(shownOrder).toEqual(['Blue Signal', 'Glass City', 'Blue Hour']);

  // Releasing outside the list drops the track where it is shown, and ends the drag.
  const rows = page.locator('[data-track-id]');
  const dragBy = async (name: string, over: number) => {
    const box = (await rows.nth(over).boundingBox())!;
    await page.getByRole('button', { name, exact: true }).hover();
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 8 });
  };
  await dragBy('Move Blue Hour', 0);
  await page.mouse.move(20, 20, { steps: 4 });
  await page.mouse.up();
  await expect.poll(savedOrder).toBe('Blue Hour,Blue Signal,Glass City');
  const last = (await rows.nth(2).boundingBox())!;
  await page.mouse.move(last.x + 200, last.y + last.height / 2, { steps: 8 });
  await expect.poll(shownOrder).toEqual(['Blue Hour', 'Blue Signal', 'Glass City']);

  // Only the pointer's height counts: beside the list (over the sidebar) and below it still move the track.
  const first = (await rows.nth(0).boundingBox())!;
  await page.getByRole('button', { name: 'Move Glass City', exact: true }).hover();
  await page.mouse.down();
  await page.mouse.move(40, first.y + first.height / 2, { steps: 8 });
  await expect.poll(shownOrder).toEqual(['Glass City', 'Blue Hour', 'Blue Signal']);
  await page.mouse.move(40, last.y + last.height * 3, { steps: 8 });
  await expect.poll(shownOrder).toEqual(['Blue Hour', 'Blue Signal', 'Glass City']);
  await page.mouse.move(40, first.y + first.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(savedOrder).toBe('Glass City,Blue Hour,Blue Signal');

  // Escape cancels a drag and puts the track back.
  await dragBy('Move Blue Signal', 0);
  await expect.poll(shownOrder).toEqual(['Blue Signal', 'Glass City', 'Blue Hour']);
  await page.keyboard.press('Escape');
  await expect.poll(shownOrder).toEqual(['Glass City', 'Blue Hour', 'Blue Signal']);
  await page.mouse.up();
  await expect.poll(savedOrder).toBe('Glass City,Blue Hour,Blue Signal');
});

test('selects, acts on, and plays songs the same way in folders, search, and playlists', async ({ page }) => {
  const albumId = '60000000-0000-4000-8000-000000000002';
  const playlistId = randomUUID();
  await query(`insert into playlists (id, profile_id, name) values ('${playlistId}', '${profileId}', 'E2E Songs')`);
  const row = (name: string) => page.getByRole('row', { name, exact: true });

  const selected = page.locator('[role="row"][aria-selected="true"]');

  // Folder: click selects, Shift-click selects a range, Ctrl/Cmd-click toggles one song. Nothing
  // above the list changes with the selection, so the songs never move.
  await page.goto(`/music/${musicRootId}/${albumId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByText('3 songs · 11 min')).toBeVisible();
  const firstRowTop = (await row('Blue Hour').boundingBox())!.y;
  await row('Blue Hour').click();
  await row('Blue Signal').click({ modifiers: ['Shift'] });
  await expect(selected).toHaveCount(3);
  await row('Glass City').click({ modifiers: ['ControlOrMeta'] });
  await expect(selected).toHaveCount(2);
  await expect(row('Glass City')).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByText('3 songs · 11 min')).toBeVisible();
  expect((await row('Blue Hour').boundingBox())!.y).toBe(firstRowTop);
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/song-list-selection.png', fullPage: true });

  // A selected song's menu acts on the whole selection.
  await row('Blue Signal').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add 2 songs to playlist…' }).click();
  await page.getByRole('dialog', { name: 'Add to playlist /' }).getByRole('button', { name: 'E2E Songs' }).click();
  await expect(selected).toHaveCount(0);
  const saved = () =>
    query(`
      select coalesce(string_agg(t.title, ',' order by i.position), '')
      from playlist_items i join media_entries t on t.id = i.media_entry_id
      where i.playlist_id = '${playlistId}'`);
  await expect.poll(saved).toBe('Blue Hour,Blue Signal');

  // Search: each song's ⋯ menu leads to its folder.
  await page.goto('/music/search?q=glass');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await row('Glass City').getByRole('button', { name: 'More actions for Glass City' }).click();
  await page.getByRole('menuitem', { name: 'Show in folder' }).click();
  await expect(page).toHaveURL(new RegExp(`/music/${musicRootId}/${albumId}$`));

  // Playlist: double-click plays without selecting; clicking elsewhere or the menu clears a
  // selection; the selection is removed together.
  await page.goto(`/music/playlist/${playlistId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await row('Blue Hour').dblclick();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.getAttribute('src') ?? ''))
    .toBe(`/stream/${tracks.blueHour}`);
  await expect(selected).toHaveCount(0);
  await row('Blue Signal').click();
  await expect(selected).toHaveCount(1);
  await page.getByRole('heading', { name: 'E2E Songs /' }).click();
  await expect(selected).toHaveCount(0);
  await row('Blue Hour').click();
  await row('Blue Signal').click({ modifiers: ['Shift'] });
  await row('Blue Hour').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Clear selection' }).click();
  await expect(selected).toHaveCount(0);
  await row('Blue Hour').click();
  await row('Blue Signal').click({ modifiers: ['Shift'] });
  await row('Blue Hour').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove 2 songs from playlist' }).click();
  await expect(page.getByText('This playlist is empty.')).toBeVisible();
  await expect.poll(saved).toBe('');
});

test('lists a folder’s tracks for playlists and rejects malformed folders', async ({ request }) => {
  const artist = await request.get(`/api/music/tracks?root=${musicRootId}&folder=${artistId}`);
  expect(artist.status()).toBe(200);
  expect(await artist.json()).toEqual({ ids: [tracks.blueHour, tracks.glassCity, tracks.blueSignal] });

  const malformed = await request.get(`/api/music/tracks?root=${musicRootId}&folder=not-an-id`);
  expect(malformed.status()).toBe(400);
  expect(await malformed.json()).toMatchObject({ code: 'request.invalid' });
});

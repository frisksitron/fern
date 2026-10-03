import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { query } from '../../scripts/compose-psql.mjs';

// Seeded by scripts/seed-e2e.mjs: Blue Hour has 20 s of audio. These tests give it chapters, as a
// downloaded mix has, and list downloads in each state. Nothing here talks to YouTube.
const profileId = '10000000-0000-4000-8000-000000000001';
const blueHour = '60000000-0000-4000-8000-000000000011';
const downloads = {
  running: '70000000-0000-4000-8000-000000000001',
  failed: '70000000-0000-4000-8000-000000000002',
  completed: '70000000-0000-4000-8000-000000000003',
};

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await query(`delete from youtube_downloads where id in ('${Object.values(downloads).join("','")}')`);
  await query(`
    insert into youtube_downloads
      (id, video_id, url, state, title, channel, duration_ms, downloaded_bytes, total_bytes, media_entry_id, error_message, created_at)
    values
      ('${downloads.completed}', 'e2eComplete', 'https://www.youtube.com/watch?v=e2eComplete', 'completed', 'Blue Hour Mix', 'Night Drive', 20000, 4, 4, '${blueHour}', null, now() - interval '3 minutes'),
      ('${downloads.failed}', 'e2eFailedVd', 'https://www.youtube.com/watch?v=e2eFailedVd', 'failed', null, null, null, null, null, null, 'This video is private.', now() - interval '2 minutes'),
      ('${downloads.running}', 'e2eRunnings', 'https://www.youtube.com/watch?v=e2eRunnings', 'downloading', 'Sunrise Set', 'Night Drive', 7200000, 25000000, 100000000, null, null, now() - interval '1 minute')
  `);
  await query(`delete from media_chapters where media_entry_id = '${blueHour}'`);
  await query(`
    insert into media_chapters (media_entry_id, position, start_ms, end_ms, title)
    values ('${blueHour}', 0, 0, 6000, 'Quiet Start'), ('${blueHour}', 1, 6000, 12000, 'The Chorus'), ('${blueHour}', 2, 12000, 20000, 'Outro')
  `);
});

/** The listed download showing `text`. The dev database may hold real downloads besides these. */
function downloadRow(page: Page, text: string) {
  return page.getByRole('list', { name: 'Downloads' }).getByRole('listitem').filter({ hasText: text });
}

test.afterEach(async () => {
  await query(`delete from youtube_downloads where id in ('${Object.values(downloads).join("','")}')`);
  await query(`delete from media_chapters where media_entry_id = '${blueHour}'`);
});

test('lists downloads with their progress and accepts only links to a video', async ({ page }) => {
  await page.goto('/music/youtube');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const list = page.getByRole('list', { name: 'Downloads' });
  await expect(downloadRow(page, 'Sunrise Set')).toContainText('Downloading 25% of 95 MB');
  const failed = downloadRow(page, 'This video is private.');
  await expect(failed).toContainText('https://www.youtube.com/watch?v=e2eFailedVd');
  await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(downloadRow(page, 'Blue Hour Mix')).toContainText('In the library');
  await expect(list.getByRole('listitem').first()).toContainText('Sunrise Set');
  await expect(page.getByRole('link', { name: 'Open library' })).toBeVisible();

  const link = page.getByRole('textbox', { name: 'YouTube link' });
  const download = page.getByRole('button', { name: 'Download', exact: true });
  await link.fill('https://www.youtube.com/playlist?list=PL123');
  await expect(download).toBeDisabled();
  await link.fill('https://youtu.be/rBarjCP_KUs');
  await expect(download).toBeEnabled();

  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/music-youtube.png', fullPage: true });
});

test('moves between a mix’s chapters with previous, next, and the chapter list', async ({ page }) => {
  await page.goto('/music/youtube');
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await downloadRow(page, 'Blue Hour Mix').getByRole('button', { name: 'Play' }).click();

  const chapterButton = page.getByRole('button', { name: 'Show chapters' });
  await expect(chapterButton).toContainText('1/3');
  await expect(chapterButton).toContainText('Quiet Start');
  // One song in the queue, but there is a chapter to go to.
  await page.getByRole('button', { name: 'Next chapter' }).click();
  await expect(chapterButton).toContainText('2/3');
  await expect(chapterButton).toContainText('The Chorus');

  await chapterButton.click();
  const chapters = page.getByRole('region', { name: 'Chapters' });
  await expect(chapters.getByRole('button', { name: /The Chorus/ })).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: 'test-results/screenshots/music-chapters.png' });
  await chapters.getByRole('button', { name: /Outro/ }).click();
  await expect(chapters).toBeHidden();
  await expect(chapterButton).toContainText('3/3');
  // The last chapter of the only song: nothing comes next.
  await expect(page.getByRole('button', { name: 'Next track' })).toBeDisabled();

  // Just after a chapter starts, previous goes to the chapter before.
  await page.getByRole('button', { name: 'Previous chapter' }).click();
  await expect(chapterButton).toContainText('2/3');
});

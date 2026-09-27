import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { query } from '../../scripts/compose-psql.mjs';

const profileId = '10000000-0000-4000-8000-000000000001';
const currentId = '30000000-0000-4000-8000-000000000001';
const nextId = '30000000-0000-4000-8000-000000000002';

test('finishes the current media and opens the next media', async ({ page, context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto(`/watch/${currentId}`);

  const nextButton = page.getByRole('button', { name: 'Finish and play Next Episode.mp4' });
  await expect(nextButton).toBeVisible();
  await expect(nextButton).toHaveAttribute('title', 'Next: Next Episode.mp4');
  const titleBox = await page.getByRole('heading', { name: 'Direct Play Demo.mp4' }).boundingBox();
  const buttonBox = await nextButton.boundingBox();
  expect(Math.abs((titleBox?.x ?? 0) + (titleBox?.width ?? 0) / 2 - 640)).toBeLessThan(10);
  expect(buttonBox?.y).toBeLessThan(100);

  await page.mouse.move(640, 650);
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/next-media-button.png', fullPage: true });

  await nextButton.click();
  await expect(page).toHaveURL(`/watch/${nextId}`);
  // The player remounts for the next media instead of keeping the previous one.
  await expect(page.getByRole('heading', { name: 'Next Episode.mp4' })).toBeVisible();
  await expect(page.locator('video')).toHaveAttribute('src', `/stream/${nextId}`);

  await expect
    .poll(() =>
      query(
        `select watched::text from playback_progress where profile_id = '${profileId}' and media_entry_id = '${currentId}'`,
      ),
    )
    .toBe('true');
});

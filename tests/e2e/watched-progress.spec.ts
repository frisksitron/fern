import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { query } from '../../scripts/compose-psql.mjs';

const profileId = '10000000-0000-4000-8000-000000000001';
const rootId = '20000000-0000-4000-8000-000000000001';
const unwatchedPositionId = '30000000-0000-4000-8000-000000000001';
const savedPositionId = '30000000-0000-4000-8000-000000000002';

test('watched media keeps actual progress and uses the default thumbnail', async ({ page, context }) => {
  await query(`
    insert into playback_progress (profile_id, media_entry_id, position_ms, duration_ms, watched)
    values ('${profileId}', '${unwatchedPositionId}', 0, 45000, true), ('${profileId}', '${savedPositionId}', 22500, 45000, true)
    on conflict (profile_id, media_entry_id) do update
    set position_ms = excluded.position_ms, duration_ms = excluded.duration_ms, watched = excluded.watched, updated_at = now()
  `);

  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
  await page.goto(`/browse/${rootId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();

  const defaultThumbnailCard = page.locator(`a[href="/watch/${unwatchedPositionId}"]`);
  const savedPositionCard = page.locator(`a[href="/watch/${savedPositionId}"]`);
  await expect(defaultThumbnailCard.locator('img')).toHaveAttribute(
    'src',
    `/api/media/${unwatchedPositionId}/thumbnail?positionMs=13500`,
  );
  await expect(defaultThumbnailCard.locator('img')).toHaveClass(/opacity-50/);
  await expect(defaultThumbnailCard.locator('img')).toHaveClass(/saturate-50/);
  await expect(defaultThumbnailCard.locator('[data-watched-tint]')).toHaveClass(/bg-fern-accent\/40/);
  await expect(defaultThumbnailCard.locator('progress')).toHaveJSProperty('value', 45000);
  await expect(savedPositionCard.locator('img')).toHaveAttribute(
    'src',
    `/api/media/${savedPositionId}/thumbnail?positionMs=13500`,
  );
  await expect(savedPositionCard.locator('progress')).toHaveJSProperty('value', 22500);

  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/watched-progress.png', fullPage: true });

  await expect(page.getByRole('button', { name: 'Reorder episodes' })).toHaveCount(0);
  const episode = page.locator(`[data-reorder-id="${unwatchedPositionId}"]`);
  const targetEpisode = page.locator(`[data-reorder-id="${savedPositionId}"]`);
  const box = await episode.boundingBox();
  const targetBox = await targetEpisode.boundingBox();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-drag-ghost]')).toBeVisible();
  await expect(episode).toHaveClass(/opacity-20/);
  await page.mouse.move(
    (targetBox?.x ?? 0) + (targetBox?.width ?? 0) / 2,
    (targetBox?.y ?? 0) + (targetBox?.height ?? 0) / 2,
    { steps: 5 },
  );
  await expect(page.locator('[data-reorder-id]').first()).toHaveAttribute('data-reorder-id', savedPositionId);
  await page.screenshot({ path: 'test-results/screenshots/long-press-reorder.png', fullPage: true });
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2, { steps: 5 });
  await expect(page.locator('[data-reorder-id]').first()).toHaveAttribute('data-reorder-id', unwatchedPositionId);
  await page.mouse.up();
  await expect(page.locator('[data-drag-ghost]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Done' })).toHaveCount(0);
});

import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Seeded by scripts/seed-e2e.mjs: Blue Hour has audio, Glass City only a catalog row.
const profileId = '10000000-0000-4000-8000-000000000001';
const musicRootId = '20000000-0000-4000-8000-000000000003';
const albumId = '60000000-0000-4000-8000-000000000002';
const blueHour = '60000000-0000-4000-8000-000000000011';
const glassCity = '60000000-0000-4000-8000-000000000012';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'profileId', value: profileId, url: 'http://127.0.0.1:5173' }]);
});

/**
 * How many of the canvas's pixels the effect draws on, 4 s into the song (paused there). It is
 * read in the frame the effect draws in, as the canvas is cleared once the frame is shown.
 */
function drawnPixels(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const audio = document.querySelector('audio')!;
        audio.pause();
        // A moment it has not just drawn, so that it draws, in the next frame, before this.
        audio.currentTime = audio.currentTime === 4 ? 4.01 : 4;
        requestAnimationFrame(() => {
          const gl = document.querySelector('canvas')!.getContext('webgl2')!;
          const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
          gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let drawn = 0;
          for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha]) drawn++;
          resolve(drawn);
        });
      }),
  );
}

test('shows the playing song’s visual effect behind the player, and goes through the effects', async ({ page }) => {
  const shaderErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /effect's (shader|program)/.test(message.text()))
      shaderErrors.push(message.text());
  });
  await page.goto(`/music/${musicRootId}/${albumId}`);
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await page.getByRole('row', { name: 'Blue Hour', exact: true }).dblclick();
  const mapped = page.waitForResponse((response) => response.url().endsWith(`/api/media/${blueHour}/track-map`));
  await page.getByRole('button', { name: 'Visual effect' }).click();
  await expect(page).toHaveURL('/music/fx');
  expect((await mapped).status()).toBe(200);
  await expect(page.locator('[aria-live="polite"]')).toBeEmpty();

  // Every effect compiles and draws. Clicking the background goes to the next one.
  const effect = page.getByRole('button', { name: /^Effect: / });
  await expect(effect).toHaveAccessibleName('Effect: Mana. Next effect');
  const count = Number(/\/(\d+)/.exec(await effect.innerText())![1]);
  const shown = new Set<string>();
  for (let each = 0; each < count; each++) {
    const name = (await effect.getAttribute('aria-label'))!;
    shown.add(name);
    await expect.poll(() => drawnPixels(page), { message: `${name} draws`, timeout: 30_000 }).toBeGreaterThan(2_000);
    await page.mouse.click(60, 400);
  }
  expect(shown.size).toBe(count);
  expect(shaderErrors).toEqual([]);

  // The GPU can be taken away, as phones do in the background, and given back: it draws again.
  const gpu = await page.evaluateHandle(() =>
    document.querySelector('canvas')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!,
  );
  await gpu.evaluate((extension) => extension.loseContext());
  await expect.poll(() => drawnPixels(page)).toBe(0);
  await gpu.evaluate((extension) => extension.restoreContext());
  await expect.poll(() => drawnPixels(page), { timeout: 30_000 }).toBeGreaterThan(2_000);

  // The arrow keys go either way.
  await expect(effect).toHaveAccessibleName('Effect: Mana. Next effect');
  await page.keyboard.press('ArrowRight');
  await expect(effect).toHaveAccessibleName('Effect: Zoltraak. Next effect');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(effect).toHaveAccessibleName('Effect: Groove. Next effect');
  await page.evaluate(() => (document.querySelector('audio')!.currentTime = 10));
  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/music-fx.png' });

  // Escape goes back to where it was opened from, and the choice of effect is kept.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`/music/${musicRootId}/${albumId}$`));
  await page.getByRole('button', { name: 'Visual effect' }).click();
  await expect(page.getByRole('button', { name: /^Effect: / })).toHaveAccessibleName('Effect: Groove. Next effect');
});

test('serves a track’s map, and none for a track without its file', async ({ request }) => {
  const map = await request.get(`/api/media/${blueHour}/track-map`);
  expect(map.status()).toBe(200);
  expect(map.headers()['etag']).toMatch(/^"[a-f0-9]{64}"$/);
  expect(Object.keys(await map.json()).sort()).toEqual(['calm', 'hits', 'levels', 'peaks']);
  expect((await request.get(`/api/media/${glassCity}/track-map`)).status()).toBe(404);
  expect((await request.get('/api/media/not-an-id/track-map')).status()).toBe(400);
});

import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('provides Fern branding and installable PWA metadata', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/media');

  const brand = page.getByRole('link', { name: '[fern]', exact: true });
  await expect(brand).toBeVisible();
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/fern-icon.svg');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/fern-apple-touch.png');

  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({
    name: 'Fern',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    icons: [
      { src: '/fern-192.png', sizes: '192x192', purpose: 'any' },
      { src: '/fern-512.png', sizes: '512x512', purpose: 'any' },
      { src: '/fern-maskable-512.png', sizes: '512x512', purpose: 'maskable' },
    ],
  });

  const serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL;
  });
  expect(serviceWorker).toContain('/service-worker.js');

  await mkdir('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/pwa-mobile.png', fullPage: true });
});

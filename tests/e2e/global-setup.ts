import { chromium, type FullConfig } from '@playwright/test';

/**
 * `svelte-kit sync` (run by `pnpm check` and Vitest) rewrites `.svelte-kit/generated`, and Vite
 * delivers the resulting full reload to the next page that connects, even seconds later. Load one
 * throwaway page first so that reload can never land in the middle of a test.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:5173';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const connected = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('[vite] connected'),
      timeout: 15_000,
    });
    await page.goto(new URL('/', baseURL).href);
    await connected;
    // A queued reload arrives immediately after the HMR connection opens.
    await page.waitForTimeout(500);
    await page.waitForLoadState('load');
  } finally {
    await browser.close();
  }
}

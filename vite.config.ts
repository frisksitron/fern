import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    process.env.DATABASE_URL ??= 'postgres://fern:fern@127.0.0.1:5432/fern';
    process.env.ORIGIN ??= 'http://127.0.0.1:5173';
    process.env.PUBLIC_ZERO_URL ??= 'http://127.0.0.1:4848';
  }
  return {
    plugins: [tailwindcss(), sveltekit()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      allowedHosts: ['host.docker.internal'],
      // Test runs write reports, fixtures, and caches under the project; watching them made Vite
      // reload open pages mid-test (Playwright's HTML report counts as an HTML change).
      watch: { ignored: ['**/playwright-report/**', '**/test-results/**', '**/.cache/**', '**/mock-media/**'] },
    },
    test: {
      projects: [
        { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
        { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
        {
          extends: true,
          test: {
            name: 'db',
            include: ['tests/db/**/*.test.ts'],
            globalSetup: ['tests/db/global-setup.ts'],
            fileParallelism: false,
          },
        },
      ],
    },
  };
});

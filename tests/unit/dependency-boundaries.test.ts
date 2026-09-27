import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.(ts|svelte)$/.test(entry.name) ? [file] : [];
    }),
  );
  return nested.flat();
}

async function importersOf(pattern: RegExp): Promise<string[]> {
  const importers: string[] = [];
  for (const file of await sourceFiles('src')) {
    if (pattern.test(await readFile(file, 'utf8'))) importers.push(file.split(path.sep).join('/'));
  }
  return importers;
}

describe('dependency boundaries', () => {
  it('confine Zod to the MCP adapter; everything else validates with Effect Schema', async () => {
    const importers = await importersOf(/from ['"]zod['"]/);
    expect(importers.filter((file) => !file.startsWith('src/lib/server/mcp/'))).toEqual([]);
    expect(importers.length).toBeGreaterThan(0);
  });

  it('reach PostgreSQL only through the Database service, except for Zero’s mutation pool', async () => {
    const drivers = /from ['"](pg|@effect\/sql-pg|drizzle-orm\/(node-postgres|effect-postgres))['"]/;
    expect(await importersOf(drivers)).toEqual(['src/lib/server/db/service.ts', 'src/lib/server/zero/service.ts']);
  });

  it('keep SvelteKit redirects and error pages out of the server data layer', async () => {
    const importers = await importersOf(/import \{[^}]*\b(redirect|error)\b[^}]*\} from '@sveltejs\/kit'/);
    const dataLayer = importers.filter((file) => file.startsWith('src/lib/server/'));
    expect(dataLayer).toEqual(['src/lib/server/http.ts']);
  });

  it('spawn FFmpeg and ffprobe only through the media process runner', async () => {
    expect(await importersOf(/from ['"](node:)?child_process['"]/)).toEqual(['src/lib/server/media/process-runner.ts']);
  });
});

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, type FernDatabase } from '../../src/lib/server/db/service';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaRoots } from '../../src/lib/server/media-roots/service';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { testConfig } from '../support/config';
import { inMemoryMediaRootRepository } from '../support/fakes';

let base: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'fern-roots-')));
  await mkdir(path.join(base, 'library', 'Anime', 'Frieren'), { recursive: true });
  await mkdir(path.join(base, 'library', 'Movies'), { recursive: true });
  await mkdir(path.join(base, 'outside'), { recursive: true });
  await writeFile(path.join(base, 'library', 'notes.txt'), 'not a folder');
  // Junctions need no special privileges on Windows; the type is ignored elsewhere.
  await symlink(path.join(base, 'library', 'Anime'), path.join(base, 'anime-link'), 'junction');
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

function mediaRoots(browseRoots: string[] = []) {
  const repository = inMemoryMediaRootRepository();
  const layer = MediaRoots.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layer,
        repository.layer,
        testConfig({ BROWSE_ROOTS: browseRoots.join(path.delimiter) }),
      ),
    ),
  );
  const run = <A, E>(program: Effect.Effect<A, E, MediaRoots>) =>
    Effect.runPromise(Effect.result(Effect.provide(program, layer)));
  return { repository, run };
}

describe('MediaRoots on the real filesystem', () => {
  it('canonicalizes links so an alias cannot bypass the overlap check', async () => {
    const { run, repository } = mediaRoots();
    const created = await run(
      MediaRoots.use((roots) => roots.create({ path: path.join(base, 'anime-link'), mediaType: 'video' })),
    );
    expect(created).toMatchObject({ _tag: 'Success', success: { path: path.join(base, 'library', 'Anime') } });

    const alias = await run(
      MediaRoots.use((roots) =>
        roots.create({ path: path.join(base, 'library', 'Anime', 'Frieren'), mediaType: 'video' }),
      ),
    );
    expect(alias).toMatchObject({ _tag: 'Failure', failure: { _tag: 'MediaRootOverlap' } });
    expect(repository.rows).toHaveLength(1);
  });

  it('classifies missing paths and files', async () => {
    const { run } = mediaRoots();
    const missing = await run(
      MediaRoots.use((roots) => roots.create({ path: path.join(base, 'missing'), mediaType: 'video' })),
    );
    expect(missing).toMatchObject({ _tag: 'Failure', failure: { _tag: 'PathNotFound' } });
    const file = await run(
      MediaRoots.use((roots) => roots.create({ path: path.join(base, 'library', 'notes.txt'), mediaType: 'video' })),
    );
    expect(file).toMatchObject({ _tag: 'Failure', failure: { _tag: 'NotADirectory' } });
  });

  it('lists real directories inside the browse boundary without following links', async () => {
    const { run } = mediaRoots([path.join(base, 'library')]);
    const listing = await run(MediaRoots.use((roots) => roots.listDirectories(path.join(base, 'library'))));
    expect(listing).toMatchObject({
      _tag: 'Success',
      success: {
        currentPath: path.join(base, 'library'),
        parentPath: null,
        directories: [
          { name: 'Anime', path: path.join(base, 'library', 'Anime') },
          { name: 'Movies', path: path.join(base, 'library', 'Movies') },
        ],
      },
    });
    const outside = await run(MediaRoots.use((roots) => roots.listDirectories(path.join(base, 'outside'))));
    expect(outside).toMatchObject({ _tag: 'Failure', failure: { _tag: 'OutsideBrowseBoundary' } });
  });
});

describe('MediaLibrary on the real filesystem', () => {
  const library = MediaLibrary.layerWithoutDependencies.pipe(
    Layer.provide(Layer.mergeAll(FileSystem.layer, Layer.succeed(Database, {} as FernDatabase))),
  );
  const fileInRoot = (root: string, relativePath: string) =>
    Effect.runPromise(
      Effect.result(
        Effect.provide(
          MediaLibrary.use((media) => media.fileInRoot(root, relativePath)),
          library,
        ),
      ),
    );

  it('resolves names with spaces and non-Latin characters', async () => {
    await writeFile(path.join(base, 'library', '映 画.mp4'), 'x');
    expect(await fileInRoot(path.join(base, 'library'), '映 画.mp4')).toMatchObject({
      _tag: 'Success',
      success: path.join(base, 'library', '映 画.mp4'),
    });
  });

  it('refuses a link that escapes the media root', async () => {
    await writeFile(path.join(base, 'outside', 'secret.mp4'), 'x');
    await symlink(path.join(base, 'outside'), path.join(base, 'library', 'escape'), 'junction');
    expect(await fileInRoot(path.join(base, 'library'), 'escape/secret.mp4')).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'MediaFileUnavailable', reason: 'outside-root' },
    });
  });
});

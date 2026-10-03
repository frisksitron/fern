import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaRoots } from '../../src/lib/server/media-roots/service';
import { Disk } from '../../src/lib/server/platform/disk';
import { testConfig } from '../support/config';
import { inMemoryMediaRootRepository, noDatabase } from '../support/fakes';

/** A temporary library with a folder outside it and a junction into it, removed when the test ends. */
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'fern-roots-')));
    await mkdir(path.join(base, 'library', 'Anime', 'Frieren'), { recursive: true });
    await mkdir(path.join(base, 'library', 'Movies'), { recursive: true });
    await mkdir(path.join(base, 'outside'), { recursive: true });
    await writeFile(path.join(base, 'library', 'notes.txt'), 'not a folder');
    // Junctions need no special privileges on Windows; the type is ignored elsewhere.
    await symlink(path.join(base, 'library', 'Anime'), path.join(base, 'anime-link'), 'junction');
    return base;
  }),
  (base) => Effect.promise(() => rm(base, { recursive: true, force: true })),
);

/** `MediaRoots` on the real filesystem with an in-memory repository. */
function mediaRoots(browseRoots: string[] = []) {
  const repository = inMemoryMediaRootRepository();
  const layer = MediaRoots.layer.pipe(
    Layer.provide(
      Layer.mergeAll(Disk.layer, repository.layer, testConfig({ BROWSE_ROOTS: browseRoots.join(path.delimiter) })),
    ),
  );
  return { repository, provide: Effect.provide(layer) };
}

describe('MediaRoots on the real filesystem', () => {
  it.live('canonicalizes links so an alias cannot bypass the overlap check', () =>
    Effect.gen(function* () {
      const base = yield* fixture;
      const { repository, provide } = mediaRoots();
      yield* Effect.gen(function* () {
        const roots = yield* MediaRoots.Service;
        expect(yield* roots.create({ path: path.join(base, 'anime-link'), mediaType: 'video' })).toMatchObject({
          path: path.join(base, 'library', 'Anime'),
        });
        const alias = roots.create({ path: path.join(base, 'library', 'Anime', 'Frieren'), mediaType: 'video' });
        expect(yield* Effect.flip(alias)).toMatchObject({ _tag: 'MediaRootOverlap' });
      }).pipe(provide);
      expect(repository.rows).toHaveLength(1);
    }),
  );

  it.live('classifies missing paths and files', () =>
    Effect.gen(function* () {
      const base = yield* fixture;
      const roots = yield* MediaRoots.Service;
      const missing = roots.create({ path: path.join(base, 'missing'), mediaType: 'video' });
      expect(yield* Effect.flip(missing)).toMatchObject({ _tag: 'PathNotFound' });
      const file = roots.create({ path: path.join(base, 'library', 'notes.txt'), mediaType: 'video' });
      expect(yield* Effect.flip(file)).toMatchObject({ _tag: 'NotADirectory' });
    }).pipe(mediaRoots().provide),
  );

  it.live('lists real directories inside the browse boundary without following links', () =>
    Effect.gen(function* () {
      const base = yield* fixture;
      yield* Effect.gen(function* () {
        const roots = yield* MediaRoots.Service;
        expect(yield* roots.listDirectories(path.join(base, 'library'))).toEqual({
          currentPath: path.join(base, 'library'),
          parentPath: null,
          directories: [
            { name: 'Anime', path: path.join(base, 'library', 'Anime') },
            { name: 'Movies', path: path.join(base, 'library', 'Movies') },
          ],
        });
        expect(yield* Effect.flip(roots.listDirectories(path.join(base, 'outside')))).toMatchObject({
          _tag: 'OutsideBrowseBoundary',
        });
      }).pipe(mediaRoots([path.join(base, 'library')]).provide);
    }),
  );
});

describe('MediaLibrary on the real filesystem', () => {
  // fileInRoot never queries the database.
  const library = MediaLibrary.layer.pipe(Layer.provide(Layer.mergeAll(Disk.layer, noDatabase)));
  const fileInRoot = (root: string, relativePath: string) =>
    MediaLibrary.Service.use((media) => media.fileInRoot(root, relativePath)).pipe(Effect.provide(library));

  it.live('resolves names with spaces and non-Latin characters', () =>
    Effect.gen(function* () {
      const base = yield* fixture;
      yield* Effect.promise(() => writeFile(path.join(base, 'library', '映 画.mp4'), 'x'));
      expect(yield* fileInRoot(path.join(base, 'library'), '映 画.mp4')).toBe(path.join(base, 'library', '映 画.mp4'));
    }),
  );

  it.live('refuses a link that escapes the media root', () =>
    Effect.gen(function* () {
      const base = yield* fixture;
      yield* Effect.promise(async () => {
        await writeFile(path.join(base, 'outside', 'secret.mp4'), 'x');
        await symlink(path.join(base, 'outside'), path.join(base, 'library', 'escape'), 'junction');
      });
      expect(yield* Effect.flip(fileInRoot(path.join(base, 'library'), 'escape/secret.mp4'))).toMatchObject({
        _tag: 'MediaFileUnavailable',
        reason: 'outside-root',
      });
    }),
  );
});

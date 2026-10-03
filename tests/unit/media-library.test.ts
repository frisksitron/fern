import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer } from 'effect';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { fakeDisk, noDatabase } from '../support/fakes';

const library = MediaLibrary.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      fakeDisk({
        '/media/root/Movies/film.mp4': 'file',
        '/media/root/Movies/Extras': 'directory',
        '/media/root/escape.mp4': { link: '/private/secret.mp4' },
        '/media/root/inside.mp4': { link: '/media/root/Movies/film.mp4' },
        '/private/secret.mp4': 'file',
      }),
      // fileInRoot never queries the database.
      noDatabase,
    ),
  ),
);

const fileInRoot = (relativePath: string) =>
  MediaLibrary.Service.use((media) => media.fileInRoot('/media/root', relativePath)).pipe(Effect.provide(library));

describe('MediaLibrary.fileInRoot', () => {
  it.effect('resolves files inside the root, following links that stay inside it', () =>
    Effect.gen(function* () {
      expect(yield* fileInRoot('Movies/film.mp4')).toBe('/media/root/Movies/film.mp4');
      expect(yield* fileInRoot('inside.mp4')).toBe('/media/root/Movies/film.mp4');
    }),
  );

  it.effect('refuses links that resolve outside the root', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(fileInRoot('escape.mp4'))).toMatchObject({
        _tag: 'MediaFileUnavailable',
        reason: 'outside-root',
      });
    }),
  );

  it.effect('reports missing files and directories as unavailable media files', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(fileInRoot('Movies/gone.mp4'))).toMatchObject({
        _tag: 'MediaFileUnavailable',
        reason: 'missing',
      });
      expect(yield* Effect.flip(fileInRoot('Movies/Extras'))).toMatchObject({
        _tag: 'MediaFileUnavailable',
        reason: 'not-a-file',
      });
    }),
  );

  it.effect('treats a stored path that tries to traverse upward as a defect', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(fileInRoot(`..${path.posix.sep}private/secret.mp4`));
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  );
});

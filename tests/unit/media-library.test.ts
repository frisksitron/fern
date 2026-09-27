import path from 'node:path';
import { Effect, Exit, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { Database, type FernDatabase } from '../../src/lib/server/db/service';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { fakeFileSystem } from '../support/fakes';

const layer = MediaLibrary.layerWithoutDependencies.pipe(
  Layer.provide(
    Layer.mergeAll(
      fakeFileSystem({
        '/media/root/Movies/film.mp4': 'file',
        '/media/root/Movies/Extras': 'directory',
        '/media/root/escape.mp4': { link: '/private/secret.mp4' },
        '/media/root/inside.mp4': { link: '/media/root/Movies/film.mp4' },
        '/private/secret.mp4': 'file',
      }),
      // fileInRoot never queries the database.
      Layer.succeed(Database, {} as FernDatabase),
    ),
  ),
);

const fileInRoot = (relativePath: string) =>
  Effect.runPromiseExit(
    Effect.provide(
      MediaLibrary.use((library) => library.fileInRoot('/media/root', relativePath)),
      layer,
    ),
  );

const failure = (relativePath: string) =>
  Effect.runPromise(
    Effect.flip(
      Effect.provide(
        MediaLibrary.use((library) => library.fileInRoot('/media/root', relativePath)),
        layer,
      ),
    ),
  );

describe('MediaLibrary.fileInRoot', () => {
  it('resolves files inside the root, following links that stay inside it', async () => {
    expect(await fileInRoot('Movies/film.mp4')).toEqual(Exit.succeed('/media/root/Movies/film.mp4'));
    expect(await fileInRoot('inside.mp4')).toEqual(Exit.succeed('/media/root/Movies/film.mp4'));
  });

  it('refuses links that resolve outside the root', async () => {
    expect(await failure('escape.mp4')).toMatchObject({ _tag: 'MediaFileUnavailable', reason: 'outside-root' });
  });

  it('reports missing files and directories as unavailable media files', async () => {
    expect(await failure('Movies/gone.mp4')).toMatchObject({ _tag: 'MediaFileUnavailable', reason: 'missing' });
    expect(await failure('Movies/Extras')).toMatchObject({ _tag: 'MediaFileUnavailable', reason: 'not-a-file' });
  });

  it('treats a stored path that tries to traverse upward as a defect', async () => {
    const exit = await fileInRoot(`..${path.posix.sep}private/secret.mp4`);
    expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true);
  });
});

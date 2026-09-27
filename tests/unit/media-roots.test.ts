import path from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { DatabaseUnavailable } from '../../src/lib/server/db/service';
import { browseFailure, createMediaRootFailure } from '../../src/lib/server/media-roots/http';
import { MediaRoots } from '../../src/lib/server/media-roots/service';
import { FileSystemUnavailable, PathAccessDenied } from '../../src/lib/server/platform/filesystem';
import { MediaRootId } from '../../src/lib/shared/contracts/ids';
import type { CreateMediaRootRequest } from '../../src/lib/shared/contracts/media-roots';
import { testConfig } from '../support/config';
import { fakeFileSystem, inMemoryMediaRootRepository, type FakeNode } from '../support/fakes';

const library: Record<string, FakeNode> = {
  '/media/anime/Frieren/Season 1': 'directory',
  '/media/movies': 'directory',
  '/media/notes.txt': 'file',
  '/media/shortcut': { link: '/media/movies' },
  '/links/anime': { link: '/media/anime' },
  '/private/secrets': 'directory',
  '/nas/offline': 'directory',
  '/locked/inside': 'directory',
};

function setup(options: { browseRoots?: string[]; existing?: string[] } = {}) {
  const repository = inMemoryMediaRootRepository(
    (options.existing ?? []).map((existingPath, index) => ({
      id: MediaRootId.make(`00000000-0000-4000-8000-00000000000${index}`),
      path: existingPath,
      displayName: path.posix.basename(existingPath),
      mediaType: 'video' as const,
    })),
  );
  const layer = MediaRoots.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeFileSystem(library, { denied: ['/locked'], unavailable: ['/nas/offline'] }),
        repository.layer,
        testConfig({ BROWSE_ROOTS: (options.browseRoots ?? []).join(path.delimiter) }),
      ),
    ),
  );
  return {
    repository,
    run: <A, E>(program: Effect.Effect<A, E, MediaRoots>) => Effect.runPromise(Effect.provide(program, layer)),
    fail: <A, E>(program: Effect.Effect<A, E, MediaRoots>) =>
      Effect.runPromise(Effect.flip(Effect.provide(program, layer))),
  };
}

const create = (command: CreateMediaRootRequest) => MediaRoots.use((roots) => roots.create(command));
const list = (requested: string | null) => MediaRoots.use((roots) => roots.listDirectories(requested));
const video = (rootPath: string): CreateMediaRootRequest => ({ path: rootPath, mediaType: 'video' });

describe('MediaRoots.create', () => {
  it('stores the canonical path with a derived name and the next display order', async () => {
    const { run, repository } = setup({ existing: ['/media/movies'] });
    const root = await run(create({ path: '/links/anime/', mediaType: 'music' }));
    expect(root).toMatchObject({ path: '/media/anime', displayName: 'anime', mediaType: 'music', displayOrder: 1 });
    expect(root.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.rows.map((row) => row.path)).toEqual(['/media/movies', '/media/anime']);
  });

  it('detects overlaps through symlinks and path aliases', async () => {
    const { fail } = setup({ existing: ['/media/anime', '/media/movies'] });
    for (const alias of ['/links/anime/Frieren', '/media/anime/../anime/', '/media/shortcut', '/media']) {
      expect(await fail(create(video(alias)))).toMatchObject({ _tag: 'MediaRootOverlap' });
    }
  });

  it('rejects invalid, missing, unreadable, and non-directory paths before touching the database', async () => {
    const { fail, repository } = setup();
    const failures = await Promise.all(
      ['media/anime', '/media/\0anime', '/media/missing', '/media/notes.txt', '/locked/inside', '/nas/offline'].map(
        (input) => fail(create(video(input))),
      ),
    );
    expect(failures.map((error) => error._tag)).toEqual([
      'InvalidPath',
      'InvalidPath',
      'PathNotFound',
      'NotADirectory',
      'PathAccessDenied',
      'FileSystemUnavailable',
    ]);
    expect(repository.rows).toEqual([]);
  });

  it('only accepts roots inside BROWSE_ROOTS once it is configured', async () => {
    const { run, fail } = setup({ browseRoots: ['/media', '/unmounted'] });
    expect(await fail(create(video('/private/secrets')))).toMatchObject({
      _tag: 'OutsideBrowseBoundary',
      path: '/private/secrets',
    });
    // A link outside the boundary is judged by its canonical target.
    expect(await run(create(video('/links/anime')))).toMatchObject({ path: '/media/anime' });
  });

  it('treats unresolvable browse roots as closed rather than open', async () => {
    const { run, fail } = setup({ browseRoots: ['/unmounted'] });
    expect(await fail(create(video('/media')))).toMatchObject({ _tag: 'OutsideBrowseBoundary' });
    expect(await run(list(null))).toEqual({ currentPath: null, parentPath: null, directories: [] });
  });
});

describe('MediaRoots.listDirectories', () => {
  it('lists filesystem roots at the top level when unrestricted', async () => {
    const { run } = setup();
    expect(await run(list(null))).toEqual({
      currentPath: null,
      parentPath: null,
      directories: [{ name: '/', path: '/' }],
    });
  });

  it('lists sorted child directories, omitting files and links', async () => {
    const { run } = setup();
    expect(await run(list('/media/'))).toEqual({
      currentPath: '/media',
      parentPath: '/',
      directories: ['anime', 'movies'].map((name) => ({ name, path: path.join('/media', name) })),
    });
  });

  it('shows only browse roots at the top level and stops at their boundary', async () => {
    const { run, fail } = setup({ browseRoots: ['/media/anime', '/unmounted'] });
    expect(await run(list(null))).toEqual({
      currentPath: null,
      parentPath: null,
      directories: [{ name: '/media/anime', path: '/media/anime' }],
    });
    expect(await run(list('/media/anime'))).toMatchObject({ currentPath: '/media/anime', parentPath: null });
    expect(await run(list('/media/anime/Frieren'))).toMatchObject({ parentPath: '/media/anime' });
    expect(await fail(list('/media'))).toMatchObject({ _tag: 'OutsideBrowseBoundary' });
    expect(await fail(list('/links/anime/../../private'))).toMatchObject({ _tag: 'OutsideBrowseBoundary' });
  });
});

describe('public media-root errors', () => {
  it('map every expected failure to a stable status and code without exposing paths', async () => {
    const { fail } = setup({ browseRoots: ['/media'], existing: ['/media/anime'] });
    const cases: Array<[string, number, string]> = [
      ['relative', 400, 'filesystem.path_invalid'],
      ['/media/missing', 404, 'filesystem.not_found'],
      ['/media/notes.txt', 400, 'filesystem.not_a_directory'],
      ['/private/secrets', 403, 'filesystem.outside_boundary'],
      ['/media/anime/Frieren', 409, 'media_root.overlap'],
    ];
    for (const [input, status, code] of cases) {
      const publicError = createMediaRootFailure(await fail(create(video(input))));
      expect(publicError).toMatchObject({ status, code });
      expect(publicError.message).not.toMatch(/media|private|relative|notes/);
    }

    const secret = '/private/secret-path';
    expect(browseFailure(new PathAccessDenied({ path: secret }))).toMatchObject({
      status: 403,
      code: 'filesystem.access_denied',
    });
    expect(browseFailure(new FileSystemUnavailable({ path: secret, cause: new Error(secret) }))).toMatchObject({
      status: 503,
      code: 'filesystem.unavailable',
    });
    expect(createMediaRootFailure(new DatabaseUnavailable({ cause: new Error('ECONNREFUSED') }))).toMatchObject({
      status: 503,
      code: 'database.unavailable',
    });
  });
});

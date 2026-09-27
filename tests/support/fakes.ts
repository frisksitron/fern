import path from 'node:path';
import { Effect, Layer } from 'effect';
import { MediaRootNotFound, MediaRootOverlap } from '../../src/lib/server/media-roots/errors';
import { MediaRootRepository, type NewMediaRoot } from '../../src/lib/server/media-roots/repository';
import { pathsOverlap } from '../../src/lib/server/media/paths';
import {
  FileSystem,
  FileSystemUnavailable,
  PathAccessDenied,
  PathNotFound,
  type FileSystemError,
} from '../../src/lib/server/platform/filesystem';
import type { MediaRootSummary } from '../../src/lib/shared/contracts/media-roots';

/** A directory, an empty file, a file with contents, or a symlink. */
export type FakeNode =
  | 'directory'
  | 'file'
  | { readonly text: string; readonly mtimeMs?: number }
  | { readonly size: number; readonly mtimeMs?: number }
  | { readonly link: string };

const isLink = (node: FakeNode | undefined): node is { readonly link: string } =>
  typeof node === 'object' && 'link' in node;

const isFile = (node: FakeNode | undefined) => node === 'file' || (typeof node === 'object' && !('link' in node));

function fileStats(node: FakeNode | undefined) {
  if (typeof node !== 'object' || 'link' in node) return { size: 0, mtimeMs: 0 };
  return { size: 'text' in node ? node.text.length : node.size, mtimeMs: node.mtimeMs ?? 0 };
}

function normalize(input: string) {
  return path.posix.normalize(input.replaceAll('\\', '/')).replace(/(.)\/$/, '$1');
}

/**
 * An in-memory filesystem keyed by POSIX-style absolute paths. Ancestors of every entry are
 * directories. Links resolve like symlinks; `denied` and `unavailable` paths fail like EACCES and EIO.
 */
export function fakeFileSystem(
  entries: Record<string, FakeNode>,
  options: { roots?: readonly string[]; denied?: readonly string[]; unavailable?: readonly string[] } = {},
) {
  const tree = new Map<string, FakeNode>([['/', 'directory']]);
  for (const [key, node] of Object.entries(entries)) {
    const normalized = normalize(key);
    for (let parent = path.posix.dirname(normalized); !tree.has(parent); parent = path.posix.dirname(parent))
      tree.set(parent, 'directory');
    tree.set(normalized, node);
  }

  const failureAt = (requested: string, current: string): FileSystemError | undefined => {
    if (options.denied?.some((denied) => current === normalize(denied)))
      return new PathAccessDenied({ path: requested });
    if (options.unavailable?.some((unavailable) => current === normalize(unavailable)))
      return new FileSystemUnavailable({ path: requested, cause: new Error('EIO') });
    return undefined;
  };

  const resolve = (requested: string): Effect.Effect<string, FileSystemError> => {
    let current = '';
    for (const part of normalize(requested).split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      let node = tree.get(current);
      for (let hops = 0; isLink(node); hops++) {
        if (hops > 16) return Effect.fail(new FileSystemUnavailable({ path: requested, cause: new Error('ELOOP') }));
        current = normalize(node.link);
        node = tree.get(current);
      }
      const failure = failureAt(requested, current);
      if (failure) return Effect.fail(failure);
      if (!node) return Effect.fail(new PathNotFound({ path: requested }));
    }
    return Effect.succeed(current || '/');
  };

  return Layer.succeed(FileSystem, {
    realPath: (requested) => resolve(requested),
    kind: (requested) =>
      Effect.map(resolve(requested), (resolved) => {
        const node = tree.get(resolved);
        if (node === 'directory') return 'directory';
        return isFile(node) ? 'file' : 'other';
      }),
    childDirectoryNames: (requested) =>
      Effect.map(resolve(requested), (resolved) =>
        [...tree.entries()]
          .filter(([key, node]) => key !== '/' && path.posix.dirname(key) === resolved && node === 'directory')
          .map(([key]) => path.posix.basename(key)),
      ),
    roots: Effect.succeed(options.roots ?? ['/']),
    readDirectory: (requested) =>
      Effect.map(resolve(requested), (resolved) =>
        [...tree.entries()]
          .filter(([key]) => key !== '/' && path.posix.dirname(key) === resolved)
          .map(([key, node]) => ({
            name: path.posix.basename(key),
            kind: isLink(node)
              ? ('symlink' as const)
              : node === 'directory'
                ? ('directory' as const)
                : ('file' as const),
          })),
      ),
    stat: (requested) =>
      Effect.map(resolve(requested), (resolved) => {
        const node = tree.get(resolved);
        if (node === 'directory') return { kind: 'directory' as const, size: 0, mtimeMs: 0 };
        return { kind: isFile(node) ? ('file' as const) : ('other' as const), ...fileStats(node) };
      }),
    readText: (requested) =>
      Effect.flatMap(resolve(requested), (resolved) => {
        const node = tree.get(resolved);
        if (node === 'file') return Effect.succeed('');
        if (typeof node === 'object' && 'text' in node) return Effect.succeed(node.text);
        return Effect.fail(new FileSystemUnavailable({ path: requested, cause: new Error('EISDIR') }));
      }),
  });
}

/** Records inserted roots and applies the same overlap rule as the PostgreSQL repository. */
export function inMemoryMediaRootRepository(existing: readonly NewMediaRoot[] = []) {
  const rows: MediaRootSummary[] = existing.map((root, displayOrder) => ({ ...root, displayOrder }));
  const layer = Layer.succeed(MediaRootRepository, {
    insertIfNoOverlap: (root) =>
      Effect.suspend(() => {
        const conflict = rows.find((row) => pathsOverlap(row.path, root.path));
        if (conflict) return Effect.fail(new MediaRootOverlap({ path: root.path, conflictingRootId: conflict.id }));
        const created = { ...root, displayOrder: rows.length };
        rows.push(created);
        return Effect.succeed(created);
      }),
    remove: (id) =>
      Effect.suspend(() => {
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) return Effect.fail(new MediaRootNotFound({ id }));
        rows.splice(index, 1);
        return Effect.void;
      }),
  });
  return { rows, layer };
}

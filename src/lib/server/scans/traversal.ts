import path from 'node:path';
import { Effect, Schema } from 'effect';
import {
  FileSystemUnavailable,
  PathAccessDenied,
  PathNotFound,
  type Disk,
  type FileSystemError,
} from '$lib/server/platform/disk';

/** A file or directory found under a media root. Paths are root-relative and use `/`. */
export type DiscoveredItem = {
  readonly relativePath: string;
  /** The containing directory's relative path, or null at the root. */
  readonly parentPath: string | null;
  readonly name: string;
  readonly kind: 'directory' | 'file';
  /** Lower-case, including the dot; null for directories. */
  readonly extension: string | null;
  readonly sizeBytes: number | null;
  /** Rounded to whole milliseconds, as stored. */
  readonly mtimeMs: number;
};

/**
 * A directory or entry inside the root that could not be read. A directory's contents are unknown;
 * an entry that could not be examined is unknown itself. An entry that vanished between listing and
 * examining is not a warning: it is gone.
 */
type TraversalWarning = { readonly relativePath: string; readonly cause: FileSystemError };

type Traversal = {
  readonly items: readonly DiscoveredItem[];
  readonly warnings: readonly TraversalWarning[];
};

/** The media root itself is missing, not a directory, or unreadable. */
export class RootUnavailable extends Schema.TaggedError<RootUnavailable>()('RootUnavailable', {
  path: Schema.String,
  cause: Schema.Union([PathNotFound, PathAccessDenied, FileSystemUnavailable, Schema.Literal('not-a-directory')]),
}) {}

/** Hidden files and folders: system files, sync markers (`.stfolder`), and thumbnail caches. */
const isHidden = (name: string) => name.startsWith('.');

/** Operating system and NAS folders that hold no library media and are often unreadable. */
const systemFolders = new Set([
  'lost+found',
  'system volume information',
  '$recycle.bin',
  '@eadir',
  '#recycle',
  '#snapshot',
]);
const isSystemFolder = (name: string) => systemFolders.has(name.toLowerCase());
const statConcurrency = 16;

/**
 * Walks a media root depth-first, so every directory is listed before its contents. Hidden entries,
 * system folders, symlinks, and special files are skipped. Unreadable subdirectories become warnings rather than failing the root.
 * (A plain function rather than `Effect.fn`, which cannot keep `onDirectory`'s error type parameter.)
 */
export function traverseRoot<E = never>(
  disk: Disk.Interface,
  rootPath: string,
  onDirectory: (relativePath: string) => Effect.Effect<void, E> = () => Effect.void,
): Effect.Effect<Traversal, RootUnavailable | E> {
  return Effect.gen(function* () {
    const rootStats = yield* disk
      .stat(rootPath)
      .pipe(Effect.mapError((cause) => new RootUnavailable({ path: rootPath, cause })));
    if (rootStats.kind !== 'directory') return yield* new RootUnavailable({ path: rootPath, cause: 'not-a-directory' });

    const items: DiscoveredItem[] = [];
    const warnings: TraversalWarning[] = [];

    const walk = (relativeDir: string): Effect.Effect<void, RootUnavailable | E> =>
      Effect.gen(function* () {
        const absolute = path.join(rootPath, ...relativeDir.split('/').filter(Boolean));
        const listing = yield* Effect.result(disk.readDirectory(absolute));
        if (listing._tag === 'Failure') {
          if (relativeDir === '') return yield* new RootUnavailable({ path: rootPath, cause: listing.failure });
          warnings.push({ relativePath: relativeDir, cause: listing.failure });
          return;
        }
        yield* onDirectory(relativeDir);

        const candidates = listing.success
          .filter(
            (entry) =>
              !isHidden(entry.name) &&
              !isSystemFolder(entry.name) &&
              (entry.kind === 'file' || entry.kind === 'directory'),
          )
          .sort((left, right) => left.name.localeCompare(right.name));
        const stated = yield* Effect.forEach(
          candidates,
          (entry) => {
            const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            return Effect.result(disk.stat(path.join(absolute, entry.name))).pipe(
              Effect.map((result) => ({ entry, relativePath, result })),
            );
          },
          { concurrency: statConcurrency },
        );

        const directories: string[] = [];
        for (const { entry, relativePath, result } of stated) {
          if (result._tag === 'Failure') {
            if (result.failure._tag !== 'PathNotFound') warnings.push({ relativePath, cause: result.failure });
            continue;
          }
          const isDirectory = entry.kind === 'directory';
          items.push({
            relativePath,
            parentPath: relativeDir || null,
            name: entry.name,
            kind: isDirectory ? 'directory' : 'file',
            extension: isDirectory ? null : path.extname(entry.name).toLowerCase(),
            sizeBytes: isDirectory ? null : result.success.size,
            mtimeMs: Math.round(result.success.mtimeMs),
          });
          if (isDirectory) directories.push(relativePath);
        }
        for (const directory of directories) yield* walk(directory);
      });

    yield* walk('');
    return { items, warnings };
  });
}

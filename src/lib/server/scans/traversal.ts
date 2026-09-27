import path from 'node:path';
import { Data, Effect } from 'effect';
import { FileSystem, type FileSystemError } from '$lib/server/platform/filesystem';

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

/** A directory or entry inside the root that could not be read. */
type TraversalWarning = { readonly relativePath: string; readonly cause: FileSystemError };

type Traversal = {
  readonly items: readonly DiscoveredItem[];
  readonly warnings: readonly TraversalWarning[];
};

/** The media root itself is missing, not a directory, or unreadable. */
export class RootUnavailable extends Data.TaggedError('RootUnavailable')<{
  readonly path: string;
  readonly cause: FileSystemError | 'not-a-directory';
}> {}

/** Hidden files and folders: system files, sync markers (`.stfolder`), and thumbnail caches. */
const isHidden = (name: string) => name.startsWith('.');
const statConcurrency = 16;

/**
 * Walks a media root depth-first, so every directory is listed before its contents. Hidden entries,
 * symlinks, and special files are skipped. Unreadable subdirectories become warnings rather than failing the root.
 */
export function traverseRoot<E = never>(
  rootPath: string,
  onDirectory: (relativePath: string) => Effect.Effect<void, E> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const rootStats = yield* fs
      .stat(rootPath)
      .pipe(Effect.mapError((cause) => new RootUnavailable({ path: rootPath, cause })));
    if (rootStats.kind !== 'directory') return yield* new RootUnavailable({ path: rootPath, cause: 'not-a-directory' });

    const items: DiscoveredItem[] = [];
    const warnings: TraversalWarning[] = [];

    const walk = (relativeDir: string): Effect.Effect<void, RootUnavailable | E> =>
      Effect.gen(function* () {
        const absolute = path.join(rootPath, ...relativeDir.split('/').filter(Boolean));
        const listing = yield* Effect.result(fs.readDirectory(absolute));
        if (listing._tag === 'Failure') {
          if (relativeDir === '') return yield* new RootUnavailable({ path: rootPath, cause: listing.failure });
          warnings.push({ relativePath: relativeDir, cause: listing.failure });
          return;
        }
        yield* onDirectory(relativeDir);

        const candidates = listing.success
          .filter((entry) => !isHidden(entry.name) && (entry.kind === 'file' || entry.kind === 'directory'))
          .sort((left, right) => left.name.localeCompare(right.name));
        const stated = yield* Effect.forEach(
          candidates,
          (entry) => {
            const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            return Effect.result(fs.stat(path.join(absolute, entry.name))).pipe(
              Effect.map((result) => ({ entry, relativePath, result })),
            );
          },
          { concurrency: statConcurrency },
        );

        const directories: string[] = [];
        for (const { entry, relativePath, result } of stated) {
          if (result._tag === 'Failure') {
            warnings.push({ relativePath, cause: result.failure });
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
    return { items, warnings } satisfies Traversal;
  });
}

import { access, opendir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { Context, Effect, Layer, Schema } from 'effect';

export class PathNotFound extends Schema.TaggedError<PathNotFound>()('PathNotFound', { path: Schema.String }) {}

export class PathAccessDenied extends Schema.TaggedError<PathAccessDenied>()('PathAccessDenied', {
  path: Schema.String,
}) {}

/** Any other I/O failure, such as an unreachable network share. */
export class FileSystemUnavailable extends Schema.TaggedError<FileSystemUnavailable>()('FileSystemUnavailable', {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export type FileSystemError = PathNotFound | PathAccessDenied | FileSystemUnavailable;

export type PathKind = 'directory' | 'file' | 'other';

/** A directory entry as listed, without following links. */
export type DirectoryEntry = { readonly name: string; readonly kind: PathKind | 'symlink' };

export type FileStats = { readonly kind: PathKind; readonly size: number; readonly mtimeMs: number };

/** The filesystem operations Fern needs to browse folders and index media, so features can be tested against a fake. */
export interface Interface {
  /** Resolves symlinks, junctions, and mapped drives to the canonical absolute path. */
  readonly realPath: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly kind: (path: string) => Effect.Effect<PathKind, FileSystemError>;
  /** Names of the directories directly inside `path`, excluding symlinks. */
  readonly childDirectoryNames: (path: string) => Effect.Effect<readonly string[], FileSystemError>;
  /** Top-level locations: `/`, or the accessible Windows drive roots. */
  readonly roots: () => Effect.Effect<readonly string[]>;
  readonly readText: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly readDirectory: (path: string) => Effect.Effect<readonly DirectoryEntry[], FileSystemError>;
  /** Follows links, like `stat`. */
  readonly stat: (path: string) => Effect.Effect<FileStats, FileSystemError>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Disk') {}

// Node's own API rather than Effect's FileSystem, which lists names only and has no `lstat`, so
// skipping symlinks would cost a `readLink` per entry; it also reports Windows' EPERM for denied
// folders as an unknown failure rather than a permission error. `mtimeMs` keeps Node's precision
// so it matches the values the scanner has already stored (rounded, see `traversal.ts`).
export const layer = Layer.succeed(
  Service,
  Service.of({
    realPath: (path) => attempt(path, () => realpath(path)),
    kind: (path) => attempt(path, async () => kindOf(await stat(path))),
    childDirectoryNames: (path) =>
      attempt(path, async () => {
        const names: string[] = [];
        for await (const item of await opendir(path)) if (item.isDirectory()) names.push(item.name);
        return names;
      }),
    roots: () => Effect.promise(filesystemRoots),
    readText: (path) => attempt(path, () => readFile(path, 'utf8')),
    readDirectory: (path) =>
      attempt(path, async () =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink() ? 'symlink' : kindOf(entry),
        })),
      ),
    stat: (path) =>
      attempt(path, async () => {
        const info = await stat(path);
        return { kind: kindOf(info), size: info.size, mtimeMs: info.mtimeMs };
      }),
  }),
);

function kindOf(entry: { isDirectory(): boolean; isFile(): boolean }): PathKind {
  if (entry.isDirectory()) return 'directory';
  return entry.isFile() ? 'file' : 'other';
}

function attempt<A>(path: string, run: () => Promise<A>): Effect.Effect<A, FileSystemError> {
  return Effect.tryPromise({ try: run, catch: (cause) => fileSystemError(path, cause) });
}

function fileSystemError(path: string, cause: unknown): FileSystemError {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new PathNotFound({ path });
  if (code === 'EACCES' || code === 'EPERM') return new PathAccessDenied({ path });
  return new FileSystemUnavailable({ path, cause });
}

async function filesystemRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];
  const drives = await Promise.all(
    Array.from({ length: 26 }, (_, index) => {
      const drive = `${String.fromCharCode(65 + index)}:\\`;
      // Disconnected network drives can take seconds to fail, so give each drive a short deadline.
      return Promise.race([
        access(drive).then(
          () => drive,
          () => null,
        ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
    }),
  );
  return drives.filter((drive) => drive !== null);
}

export * as Disk from './disk';

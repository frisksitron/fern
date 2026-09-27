import { access, opendir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { Context, Data, Effect, Layer } from 'effect';

export class PathNotFound extends Data.TaggedError('PathNotFound')<{ readonly path: string }> {}
export class PathAccessDenied extends Data.TaggedError('PathAccessDenied')<{ readonly path: string }> {}
/** Any other I/O failure, such as an unreachable network share. */
export class FileSystemUnavailable extends Data.TaggedError('FileSystemUnavailable')<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export type FileSystemError = PathNotFound | PathAccessDenied | FileSystemUnavailable;

type PathKind = 'directory' | 'file' | 'other';

/** A directory entry as listed, without following links. */
export type DirectoryEntry = { readonly name: string; readonly kind: PathKind | 'symlink' };

type FileStats = { readonly kind: PathKind; readonly size: number; readonly mtimeMs: number };

/** The filesystem operations Fern needs, so features can be tested against a fake. */
export class FileSystem extends Context.Service<
  FileSystem,
  {
    /** Resolves symlinks, junctions, and mapped drives to the canonical absolute path. */
    readonly realPath: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly kind: (path: string) => Effect.Effect<PathKind, FileSystemError>;
    /** Names of the directories directly inside `path`, excluding symlinks. */
    readonly childDirectoryNames: (path: string) => Effect.Effect<readonly string[], FileSystemError>;
    /** Top-level locations: `/`, or the accessible Windows drive roots. */
    readonly roots: Effect.Effect<readonly string[]>;
    readonly readText: (path: string) => Effect.Effect<string, FileSystemError>;
    readonly readDirectory: (path: string) => Effect.Effect<readonly DirectoryEntry[], FileSystemError>;
    /** Follows links, like `stat`. */
    readonly stat: (path: string) => Effect.Effect<FileStats, FileSystemError>;
  }
>()('fern/FileSystem') {
  /** The Node.js implementation. */
  static readonly layer = Layer.succeed(this, {
    realPath: (path) => attempt(path, () => realpath(path)),
    kind: (path) =>
      attempt(path, async () => {
        const info = await stat(path);
        return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
      }),
    childDirectoryNames: (path) =>
      attempt(path, async () => {
        const names: string[] = [];
        for await (const item of await opendir(path)) if (item.isDirectory()) names.push(item.name);
        return names;
      }),
    roots: Effect.promise(() => filesystemRoots()),
    readText: (path) => attempt(path, () => readFile(path, 'utf8')),
    readDirectory: (path) =>
      attempt(path, async () =>
        (await readdir(path, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? 'symlink'
            : entry.isDirectory()
              ? 'directory'
              : entry.isFile()
                ? 'file'
                : 'other',
        })),
      ),
    stat: (path) =>
      attempt(path, async () => {
        const info = await stat(path);
        return {
          kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
      }),
  });
}

function fileSystemError(path: string, cause: unknown): FileSystemError {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new PathNotFound({ path });
  if (code === 'EACCES' || code === 'EPERM') return new PathAccessDenied({ path });
  return new FileSystemUnavailable({ path, cause });
}

function attempt<A>(path: string, run: () => Promise<A>): Effect.Effect<A, FileSystemError> {
  return Effect.tryPromise({ try: run, catch: (cause) => fileSystemError(path, cause) });
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
  return drives.filter((drive): drive is string => drive !== null);
}

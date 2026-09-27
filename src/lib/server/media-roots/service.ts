import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Context, Effect, Layer, Option } from 'effect';
import { FernConfig } from '$lib/server/config';
import { comparablePath, isSameOrInside } from '$lib/server/media/paths';
import { FileSystem } from '$lib/server/platform/filesystem';
import { MediaRootId } from '$lib/shared/contracts/ids';
import type { CreateMediaRootRequest, DirectoryListing, MediaRootSummary } from '$lib/shared/contracts/media-roots';
import {
  InvalidPath,
  NotADirectory,
  OutsideBrowseBoundary,
  type BrowseError,
  type CreateMediaRootError,
} from './errors';
import { MediaRootRepository } from './repository';

function displayNameFor(directory: string) {
  return path.basename(directory) || directory;
}

/**
 * The media-folder picker and media-root creation. Both apply the same policy: paths are
 * canonicalized with `realpath`, must be directories, and must lie inside `BROWSE_ROOTS` when it
 * is configured.
 */
export class MediaRoots extends Context.Service<MediaRoots>()('fern/MediaRoots', {
  make: Effect.gen(function* () {
    const { BROWSE_ROOTS } = yield* FernConfig;
    const fs = yield* FileSystem;
    const repository = yield* MediaRootRepository;

    // Resolved on each use rather than at startup because network mounts can appear later.
    // Unresolvable browse roots are skipped, so a missing mount narrows the boundary instead of opening it.
    const boundary: Effect.Effect<readonly string[] | null> =
      BROWSE_ROOTS.length === 0
        ? Effect.succeed(null)
        : Effect.forEach(BROWSE_ROOTS, (root) => Effect.option(fs.realPath(root))).pipe(
            Effect.map((roots) => roots.flatMap((root) => (Option.isSome(root) ? [root.value] : []))),
          );

    const allowedDirectory = (input: string) =>
      Effect.gen(function* () {
        if (input.includes('\0') || !path.isAbsolute(input)) return yield* new InvalidPath({ path: input });
        const canonical = yield* fs.realPath(input);
        if ((yield* fs.kind(canonical)) !== 'directory') return yield* new NotADirectory({ path: canonical });
        const allowed = yield* boundary;
        if (allowed && !allowed.some((root) => isSameOrInside(root, canonical)))
          return yield* new OutsideBrowseBoundary({ path: canonical });
        return { canonical, allowed };
      });

    const topLevel = Effect.gen(function* () {
      const roots = (yield* boundary) ?? (yield* fs.roots);
      return {
        currentPath: null,
        parentPath: null,
        directories: roots.map((root) => ({ name: root, path: root })),
      };
    });

    /** Lists child directories, or the top-level locations when `requested` is null. */
    const listDirectories = (requested: string | null): Effect.Effect<DirectoryListing, BrowseError> =>
      requested === null
        ? topLevel
        : Effect.gen(function* () {
            const { canonical, allowed } = yield* allowedDirectory(requested);
            const names = yield* fs.childDirectoryNames(canonical);
            const parent = path.dirname(canonical);
            const atBoundary = allowed?.some((root) => comparablePath(root) === comparablePath(canonical)) ?? false;
            return {
              currentPath: canonical,
              parentPath: atBoundary || parent === canonical ? null : parent,
              directories: [...names]
                .sort((left, right) => left.localeCompare(right))
                .map((name) => ({ name, path: path.join(canonical, name) })),
            };
          });

    const create = (command: CreateMediaRootRequest): Effect.Effect<MediaRootSummary, CreateMediaRootError> =>
      Effect.gen(function* () {
        const { canonical } = yield* allowedDirectory(command.path);
        return yield* repository.insertIfNoOverlap({
          id: MediaRootId.make(randomUUID()),
          path: canonical,
          displayName: displayNameFor(canonical),
          mediaType: command.mediaType,
        });
      });

    /** Removes a root and everything indexed under it. */
    const remove = (id: MediaRootId) => repository.remove(id);

    return { listDirectories, create, remove } as const;
  }),
}) {
  /** Requires `FileSystem`, `MediaRootRepository`, and `FernConfig`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires only the root infrastructure: `Database` and `FernConfig`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(MediaRootRepository.layer),
    Layer.provide(FileSystem.layer),
  );
}

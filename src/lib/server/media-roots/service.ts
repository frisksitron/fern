import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Context, Effect, Layer, Option } from 'effect';
import { FernConfig } from '$lib/server/config';
import { comparablePath, isSameOrInside } from '$lib/server/media/paths';
import { Disk } from '$lib/server/platform/disk';
import { MediaRootId } from '$lib/shared/contracts/ids';
import type { CreateMediaRootRequest, DirectoryListing, MediaRootSummary } from '$lib/shared/contracts/media-roots';
import {
  InvalidPath,
  NotADirectory,
  OutsideBrowseBoundary,
  type BrowseError,
  type CreateMediaRootError,
  type RemoveMediaRootError,
} from './errors';
import { MediaRootRepository } from './repository';

/**
 * The media-folder picker and media-root changes. Browsing and creation apply the same policy:
 * paths are canonicalized with `realpath`, must be directories, and must lie inside
 * `BROWSE_ROOTS` when it is configured.
 */
export interface Interface {
  /** Lists child directories, or the top-level locations when `requested` is null. */
  readonly listDirectories: (requested: string | null) => Effect.Effect<DirectoryListing, BrowseError>;
  readonly create: (request: CreateMediaRootRequest) => Effect.Effect<MediaRootSummary, CreateMediaRootError>;
  /** Removes a root and everything indexed under it. */
  readonly remove: (id: MediaRootId) => Effect.Effect<void, RemoveMediaRootError>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/MediaRoots') {}

/** Requires `Disk`, `MediaRootRepository`, and `FernConfig`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    const disk = yield* Disk.Service;
    const repository = yield* MediaRootRepository.Service;

    // Resolved on each use rather than at startup because network mounts can appear later.
    // Unresolvable browse roots are skipped, so a missing mount narrows the boundary instead of opening it.
    const boundary =
      config.BROWSE_ROOTS.length === 0
        ? Effect.succeed(null)
        : Effect.forEach(config.BROWSE_ROOTS, (root) => Effect.option(disk.realPath(root))).pipe(
            Effect.map((roots) => roots.flatMap((root) => (Option.isSome(root) ? [root.value] : []))),
          );

    const allowedDirectory = Effect.fnUntraced(function* (input: string) {
      if (input.includes('\0') || !path.isAbsolute(input)) return yield* new InvalidPath({ path: input });
      const canonical = yield* disk.realPath(input);
      if ((yield* disk.kind(canonical)) !== 'directory') return yield* new NotADirectory({ path: canonical });
      const allowed = yield* boundary;
      if (allowed && !allowed.some((root) => isSameOrInside(root, canonical)))
        return yield* new OutsideBrowseBoundary({ path: canonical });
      return { canonical, allowed };
    });

    const listDirectories = Effect.fn('MediaRoots.listDirectories')(function* (requested: string | null) {
      if (requested === null) {
        const roots = (yield* boundary) ?? (yield* disk.roots());
        return { currentPath: null, parentPath: null, directories: roots.map((root) => ({ name: root, path: root })) };
      }
      const directory = yield* allowedDirectory(requested);
      const names = yield* disk.childDirectoryNames(directory.canonical);
      const parent = path.dirname(directory.canonical);
      const atBoundary =
        directory.allowed?.some((root) => comparablePath(root) === comparablePath(directory.canonical)) ?? false;
      return {
        currentPath: directory.canonical,
        parentPath: atBoundary || parent === directory.canonical ? null : parent,
        directories: [...names]
          .sort((left, right) => left.localeCompare(right))
          .map((name) => ({ name, path: path.join(directory.canonical, name) })),
      };
    });

    const create = Effect.fn('MediaRoots.create')(function* (request: CreateMediaRootRequest) {
      const directory = yield* allowedDirectory(request.path);
      return yield* repository.insertIfNoOverlap({
        id: MediaRootId.make(randomUUID()),
        path: directory.canonical,
        displayName: path.basename(directory.canonical) || directory.canonical,
        mediaType: request.mediaType,
      });
    });

    return Service.of({ listDirectories, create, remove: repository.remove });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(MediaRootRepository.defaultLayer),
  Layer.provide(Disk.layer),
  Layer.provide(FernConfig.defaultLayer),
);

export * as MediaRoots from './service';

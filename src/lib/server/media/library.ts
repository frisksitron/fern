import path from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaChapters, mediaEntries, mediaRoots } from '$lib/server/db/schema';
import { Database, orUnavailable, type DatabaseUnavailable } from '$lib/server/db/service';
import { folderTrackIds } from '$lib/server/library/folder-tracks';
import { FileSystem } from '$lib/server/platform/filesystem';
import type { MediaEntryId } from '$lib/shared/contracts/ids';
import { ArtworkNotFound, MediaFileUnavailable, MediaNotFound, type MediaFileError } from './errors';
import { isContained, normalizeRelative } from './paths';
import { findActiveMedia } from './queries';

/** Finds indexed media and resolves it to files that are verified to lie inside their media roots. */
export class MediaLibrary extends Context.Service<MediaLibrary>()('fern/MediaLibrary', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const fs = yield* FileSystem;

    /** Resolves a root-relative path, refusing anything that escapes the root through links. */
    const fileInRoot = (rootPath: string, relativePath: string): Effect.Effect<string, MediaFileError> =>
      Effect.gen(function* () {
        // Stored relative paths come from the scanner, so an invalid one is a defect, not a user error.
        const segments = yield* Effect.sync(() => normalizeRelative(relativePath).split('/'));
        const root = yield* fs.realPath(rootPath);
        const file = yield* fs.realPath(path.join(root, ...segments));
        if (!isContained(root, file)) return yield* new MediaFileUnavailable({ path: file, reason: 'outside-root' });
        if ((yield* fs.kind(file)) !== 'file')
          return yield* new MediaFileUnavailable({ path: file, reason: 'not-a-file' });
        return file;
      }).pipe(
        Effect.mapError((error) =>
          error._tag === 'PathNotFound' ? new MediaFileUnavailable({ path: error.path, reason: 'missing' }) : error,
        ),
      );

    /** An active video or song, with the verified path of its file. */
    const activeMedia = (id: MediaEntryId) =>
      Effect.gen(function* () {
        const media = yield* orUnavailable(findActiveMedia(db, id));
        if (!media) return yield* new MediaNotFound({ id });
        return { ...media, path: yield* fileInRoot(media.root.path, media.entry.relativePath) };
      });

    /** The cover image assigned to a song or music folder by the scanner. */
    const artwork = (
      id: MediaEntryId,
    ): Effect.Effect<
      { readonly id: string; readonly path: string; readonly extension: string | null; readonly mtimeMs: number },
      ArtworkNotFound | MediaFileError | DatabaseUnavailable
    > =>
      Effect.gen(function* () {
        const [target] = yield* orUnavailable(
          db
            .select({ artworkId: mediaEntries.artworkMediaEntryId, rootId: mediaRoots.id, rootPath: mediaRoots.path })
            .from(mediaEntries)
            .innerJoin(mediaRoots, eq(mediaEntries.mediaRootId, mediaRoots.id))
            .where(
              and(
                eq(mediaEntries.id, id),
                or(eq(mediaEntries.isAudio, true), eq(mediaEntries.kind, 'directory')),
                isNull(mediaEntries.deletedAt),
              ),
            )
            .limit(1),
        );
        const artworkId = target?.artworkId;
        if (!target || !artworkId) return yield* new ArtworkNotFound({ id });

        const [image] = yield* orUnavailable(
          db
            .select({
              id: mediaEntries.id,
              relativePath: mediaEntries.relativePath,
              extension: mediaEntries.extension,
              mtimeMs: mediaEntries.mtimeMs,
            })
            .from(mediaEntries)
            .where(
              and(
                eq(mediaEntries.id, artworkId),
                eq(mediaEntries.mediaRootId, target.rootId),
                eq(mediaEntries.kind, 'file'),
                isNull(mediaEntries.deletedAt),
              ),
            )
            .limit(1),
        );
        if (!image) return yield* new ArtworkNotFound({ id });
        return {
          id: image.id,
          path: yield* fileInRoot(target.rootPath, image.relativePath),
          extension: image.extension,
          mtimeMs: image.mtimeMs,
        };
      });

    /** The audio tracks in a music folder and its subfolders; see `folderTrackIds`. */
    const folderTracks = (rootId: string, folderId: string | null) => folderTrackIds(db, rootId, folderId);

    /** Where a file's chapters start, in seconds and in order: none for most songs, one per song for a mix. */
    const chapterStarts = (id: MediaEntryId): Effect.Effect<number[], DatabaseUnavailable> =>
      orUnavailable(
        db
          .select({ startMs: mediaChapters.startMs })
          .from(mediaChapters)
          .where(eq(mediaChapters.mediaEntryId, id))
          .orderBy(asc(mediaChapters.position)),
      ).pipe(Effect.map((rows) => rows.map((row) => row.startMs / 1000)));

    return { activeMedia, artwork, fileInRoot, folderTracks, chapterStarts } as const;
  }),
}) {
  /** Requires `Database` and `FileSystem`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires only `Database`. */
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(FileSystem.layer));
}

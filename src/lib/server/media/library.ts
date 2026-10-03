import path from 'node:path';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaChapters, mediaEntries, mediaRoots } from '$lib/server/db/schema';
import { Database, orUnavailable, type DatabaseUnavailable } from '$lib/server/db/service';
import { folderTrackIds, type FolderTooLarge } from '$lib/server/library/folder-tracks';
import { Disk } from '$lib/server/platform/disk';
import type { MediaEntryId } from '$lib/shared/contracts/ids';
import { ArtworkNotFound, MediaFileUnavailable, MediaNotFound, type MediaFileError } from './errors';
import { isContained, normalizeRelative } from './paths';
import { findActiveMedia } from './queries';

/** An active video or song, with the verified path of its file. */
export type ActiveMedia = {
  readonly entry: typeof mediaEntries.$inferSelect;
  readonly root: typeof mediaRoots.$inferSelect;
  readonly path: string;
};

export type Artwork = {
  readonly id: string;
  readonly path: string;
  readonly extension: string | null;
  readonly mtimeMs: number;
};

/** Finds indexed media and resolves it to files that are verified to lie inside their media roots. */
export interface Interface {
  readonly activeMedia: (
    id: MediaEntryId,
  ) => Effect.Effect<ActiveMedia, MediaNotFound | MediaFileError | DatabaseUnavailable>;
  /** The cover image assigned to a song or music folder by the scanner. */
  readonly artwork: (
    id: MediaEntryId,
  ) => Effect.Effect<Artwork, ArtworkNotFound | MediaFileError | DatabaseUnavailable>;
  /** Resolves a root-relative path, refusing anything that escapes the root through links. */
  readonly fileInRoot: (rootPath: string, relativePath: string) => Effect.Effect<string, MediaFileError>;
  /** The audio tracks in a music folder and its subfolders; see `folderTrackIds`. */
  readonly folderTracks: (
    rootId: string,
    folderId: string | null,
  ) => Effect.Effect<MediaEntryId[], FolderTooLarge | DatabaseUnavailable>;
  /** Where a file's chapters start, in seconds and in order: none for most songs, one per song for a mix. */
  readonly chapterStarts: (id: MediaEntryId) => Effect.Effect<number[], DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/MediaLibrary') {}

/** Requires `Database` and `Disk`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const disk = yield* Disk.Service;

    const fileInRoot = Effect.fn('MediaLibrary.fileInRoot')(
      function* (rootPath: string, relativePath: string) {
        // Stored relative paths come from the scanner, so an invalid one is a defect, not a user error.
        const segments = normalizeRelative(relativePath).split('/');
        const root = yield* disk.realPath(rootPath);
        const file = yield* disk.realPath(path.join(root, ...segments));
        if (!isContained(root, file)) return yield* new MediaFileUnavailable({ path: file, reason: 'outside-root' });
        if ((yield* disk.kind(file)) !== 'file')
          return yield* new MediaFileUnavailable({ path: file, reason: 'not-a-file' });
        return file;
      },
      Effect.catchTag('PathNotFound', (error) =>
        Effect.fail(new MediaFileUnavailable({ path: error.path, reason: 'missing' })),
      ),
    );

    const activeMedia = Effect.fn('MediaLibrary.activeMedia')(function* (id: MediaEntryId) {
      const media = yield* orUnavailable(findActiveMedia(db, id));
      if (!media) return yield* new MediaNotFound({ id });
      return { ...media, path: yield* fileInRoot(media.root.path, media.entry.relativePath) };
    });

    const artwork = Effect.fn('MediaLibrary.artwork')(function* (id: MediaEntryId) {
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

    const folderTracks = Effect.fn('MediaLibrary.folderTracks')((rootId: string, folderId: string | null) =>
      folderTrackIds(db, rootId, folderId),
    );

    const chapterStarts = Effect.fn('MediaLibrary.chapterStarts')(function* (id: MediaEntryId) {
      const rows = yield* orUnavailable(
        db
          .select({ startMs: mediaChapters.startMs })
          .from(mediaChapters)
          .where(eq(mediaChapters.mediaEntryId, id))
          .orderBy(asc(mediaChapters.position)),
      );
      return rows.map((row) => row.startMs / 1000);
    });

    return Service.of({ activeMedia, artwork, fileInRoot, folderTracks, chapterStarts });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(Disk.layer));

export * as MediaLibrary from './library';

import { Schema } from 'effect';
import { MediaRootId } from './ids';

export const MediaType = Schema.Literals(['video', 'music']);
export type MediaType = typeof MediaType.Type;

/** `POST /api/media-roots` body. The server canonicalizes the path and assigns everything else. */
export const CreateMediaRootRequest = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  mediaType: MediaType,
});
export interface CreateMediaRootRequest extends Schema.Schema.Type<typeof CreateMediaRootRequest> {}

export const MediaRootSummary = Schema.Struct({
  id: MediaRootId,
  path: Schema.String,
  displayName: Schema.String,
  mediaType: MediaType,
  displayOrder: Schema.Number,
});
export interface MediaRootSummary extends Schema.Schema.Type<typeof MediaRootSummary> {}

/** `201` response of `POST /api/media-roots`. */
export const CreateMediaRootResponse = Schema.Struct({ root: MediaRootSummary });
export interface CreateMediaRootResponse extends Schema.Schema.Type<typeof CreateMediaRootResponse> {}

export type DirectoryEntry = { readonly name: string; readonly path: string };

/** `GET /api/filesystem/directories` response and the media-folder picker's data. */
export type DirectoryListing = {
  readonly currentPath: string | null;
  readonly parentPath: string | null;
  readonly directories: readonly DirectoryEntry[];
};

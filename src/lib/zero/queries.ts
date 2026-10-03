import { defineQueries, defineQuery } from '@rocicorp/zero';
import { Schema } from 'effect';
import { MediaEntryId, MediaRootId, PlaylistId, ProfileId } from '$lib/shared/contracts/ids';
import { MediaType } from '$lib/shared/contracts/media-roots';
import { CONTINUE_WATCHING_LIMIT, RESUME_MIN_MS } from '$lib/shared/playback-state';
import { MUSIC_SEARCH_LIMIT, QUERY_ID_LIMIT, YOUTUBE_DOWNLOADS_LIMIT, likeContaining } from './limits';
import { zql } from './schema';

// Validators must stay synchronous: Zero rejects asynchronous Standard Schema validation.
const validator = Schema.toStandardSchemaV1;

const FolderArgs = validator(Schema.Struct({ rootId: MediaRootId, parentId: Schema.NullOr(MediaEntryId) }));
/** A bounded list of entry IDs; callers split longer lists (see `watchByIds` in the Zero data module). */
const EntryIds = Schema.Array(MediaEntryId).check(Schema.isMinLength(1), Schema.isMaxLength(QUERY_ID_LIMIT));

// Every query is bounded: by a limit, by one folder, playlist, or profile, or by a bounded ID list.
// Nothing synchronizes the whole library.

export const queries = defineQueries({
  profiles: {
    all: defineQuery(() => zql.profiles.orderBy('createdAt', 'asc')),
  },
  mediaRoots: {
    all: defineQuery(() => zql.mediaRoots.orderBy('displayOrder', 'asc')),
    byType: defineQuery(validator(Schema.Struct({ mediaType: MediaType })), ({ args }) =>
      zql.mediaRoots.where('mediaType', args.mediaType).orderBy('displayOrder', 'asc'),
    ),
  },
  mediaEntries: {
    byIds: defineQuery(validator(Schema.Struct({ ids: EntryIds })), ({ args }) =>
      zql.mediaEntries.where('id', 'IN', args.ids).where('deletedAt', 'IS', null),
    ),
    // Matches the title, artist, album, or file name; the first matches in album order.
    searchMusic: defineQuery(
      validator(Schema.Struct({ text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) })),
      ({ args }) => {
        const pattern = likeContaining(args.text);
        return zql.mediaEntries
          .where('deletedAt', 'IS', null)
          .where('kind', 'file')
          .where('isAudio', true)
          .where(({ cmp, or }) =>
            or(
              cmp('title', 'ILIKE', pattern),
              cmp('artist', 'ILIKE', pattern),
              cmp('album', 'ILIKE', pattern),
              cmp('name', 'ILIKE', pattern),
            ),
          )
          .orderBy('album', 'asc')
          .orderBy('trackNumber', 'asc')
          .limit(MUSIC_SEARCH_LIMIT);
      },
    ),
    children: defineQuery(FolderArgs, ({ args }) => {
      const query = zql.mediaEntries
        .where('mediaRootId', args.rootId)
        .where('deletedAt', 'IS', null)
        .where(({ cmp, or }) => or(cmp('kind', 'directory'), cmp('isVideo', true)));
      return args.parentId === null ? query.where('parentId', 'IS', null) : query.where('parentId', args.parentId);
    }),
    musicChildren: defineQuery(FolderArgs, ({ args }) => {
      const query = zql.mediaEntries
        .where('mediaRootId', args.rootId)
        .where('deletedAt', 'IS', null)
        .where(({ cmp, or }) => or(cmp('kind', 'directory'), cmp('isAudio', true)));
      return args.parentId === null ? query.where('parentId', 'IS', null) : query.where('parentId', args.parentId);
    }),
    byId: defineQuery(validator(Schema.Struct({ id: MediaEntryId })), ({ args }) =>
      zql.mediaEntries.where('id', args.id).where('deletedAt', 'IS', null).one(),
    ),
  },
  chapters: {
    forMedia: defineQuery(validator(Schema.Struct({ mediaEntryId: MediaEntryId })), ({ args }) =>
      zql.mediaChapters.where('mediaEntryId', args.mediaEntryId).orderBy('position', 'asc'),
    ),
  },
  youtubeDownloads: {
    recent: defineQuery(() => zql.youtubeDownloads.orderBy('createdAt', 'desc').limit(YOUTUBE_DOWNLOADS_LIMIT)),
  },
  playlists: {
    forProfile: defineQuery(validator(Schema.Struct({ profileId: ProfileId })), ({ args }) =>
      zql.playlists.where('profileId', args.profileId).orderBy('createdAt', 'asc'),
    ),
  },
  playlistItems: {
    forPlaylist: defineQuery(validator(Schema.Struct({ playlistId: PlaylistId })), ({ args }) =>
      zql.playlistItems.where('playlistId', args.playlistId).orderBy('position', 'asc'),
    ),
  },
  progress: {
    forMedia: defineQuery(validator(Schema.Struct({ profileId: ProfileId, mediaEntryId: MediaEntryId })), ({ args }) =>
      zql.playbackProgress.where('profileId', args.profileId).where('mediaEntryId', args.mediaEntryId).one(),
    ),
    forMediaIds: defineQuery(validator(Schema.Struct({ profileId: ProfileId, ids: EntryIds })), ({ args }) =>
      zql.playbackProgress.where('profileId', args.profileId).where('mediaEntryId', 'IN', args.ids),
    ),
    // Recently finished media: when this changes, up-next suggestions may change.
    recentlyWatched: defineQuery(validator(Schema.Struct({ profileId: ProfileId })), ({ args }) =>
      zql.playbackProgress
        .where('profileId', args.profileId)
        .where('watched', true)
        .orderBy('lastPlayedAt', 'desc')
        .limit(CONTINUE_WATCHING_LIMIT),
    ),
    // The ZQL form of hasResumableProgress() in $lib/shared/playback-state.
    continueWatching: defineQuery(validator(Schema.Struct({ profileId: ProfileId })), ({ args }) =>
      zql.playbackProgress
        .where('profileId', args.profileId)
        .where('watched', false)
        .where('positionMs', '>=', RESUME_MIN_MS)
        .orderBy('lastPlayedAt', 'desc')
        .limit(CONTINUE_WATCHING_LIMIT),
    ),
  },
});

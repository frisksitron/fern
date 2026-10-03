import { defineMutator, defineMutators, type Transaction } from '@rocicorp/zero';
import { Schema } from 'effect';
import { AVATARS } from '$lib/shared/constants';
import { planPlaylistAppend } from '$lib/music/playlists';
import {
  MediaEntryId,
  MediaRootId,
  PlaylistId,
  PlaylistItemId,
  ProfileId,
  TrackPlayId,
} from '$lib/shared/contracts/ids';
import { PlaylistName } from '$lib/shared/contracts/music';
import { isWatched } from '$lib/shared/playback-state';
import { zql } from './schema';

// Media roots are created and removed through /api/media-roots: creation needs filesystem checks,
// and removal must not race a running scan. Zero only synchronizes them.

// Zero runs these validators synchronously in the browser (optimistically) and on the server
// (authoritatively), passing the decoded output to the mutator, so they must stay synchronous.
const validator = Schema.toStandardSchemaV1;

const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Milliseconds;
const ProfileName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(50));
const AvatarKey = Schema.Literals(AVATARS);

/**
 * Locks a playlist for the rest of the transaction, on the server. Appends and reorders read the
 * playlist's positions and then write new ones; locking makes concurrent writes take turns, with
 * each other and with MCP, which locks the playlist the same way.
 */
async function lockPlaylist(tx: Transaction, playlistId: string) {
  if (tx.location === 'server') {
    await tx.dbTransaction.query('select 1 from playlists where id = $1 for update', [playlistId]);
  }
}

/**
 * Rejects a mutation whose row does not exist, on the server only. The browser's Zero store holds
 * just the rows some open query synchronized, so a row missing there proves nothing, and throwing
 * in the browser would drop the mutation before it reaches the server.
 */
function requireOnServer(tx: { readonly location: 'client' | 'server' }, row: unknown, message: string) {
  if (!row && tx.location === 'server') throw new Error(message);
}

export const mutators = defineMutators({
  profiles: {
    create: defineMutator(
      validator(Schema.Struct({ id: ProfileId, name: ProfileName, avatarKey: AvatarKey, now: Timestamp })),
      async ({ tx, args }) => {
        const { now, ...profile } = args;
        await tx.mutate.profiles.insert({
          ...profile,
          createdAt: now,
          updatedAt: now,
        });
      },
    ),
    update: defineMutator(
      validator(
        Schema.Struct({
          id: ProfileId,
          name: Schema.optional(ProfileName),
          avatarKey: Schema.optional(AvatarKey),
          now: Timestamp,
        }),
      ),
      async ({ tx, args }) => {
        const { now, ...profile } = args;
        await tx.mutate.profiles.update({ ...profile, updatedAt: now });
      },
    ),
    delete: defineMutator(validator(Schema.Struct({ id: ProfileId })), async ({ tx, args }) => {
      await tx.mutate.profiles.delete(args);
    }),
  },
  playlists: {
    create: defineMutator(
      validator(Schema.Struct({ id: PlaylistId, profileId: ProfileId, name: PlaylistName, now: Timestamp })),
      async ({ tx, args }) => {
        const { now, ...playlist } = args;
        await tx.mutate.playlists.insert({ ...playlist, createdAt: now, updatedAt: now });
      },
    ),
    delete: defineMutator(validator(Schema.Struct({ id: PlaylistId })), async ({ tx, args }) => {
      await tx.mutate.playlists.delete(args);
    }),
    rename: defineMutator(
      validator(Schema.Struct({ id: PlaylistId, name: PlaylistName, now: Timestamp })),
      async ({ tx, args }) => {
        await tx.mutate.playlists.update({ id: args.id, name: args.name, updatedAt: args.now });
      },
    ),
    addTracks: defineMutator(
      validator(
        Schema.Struct({
          playlistId: PlaylistId,
          tracks: Schema.Array(Schema.Struct({ id: PlaylistItemId, mediaEntryId: MediaEntryId })).check(
            Schema.isMinLength(1),
          ),
          now: Timestamp,
        }),
      ),
      async ({ tx, args }) => {
        await lockPlaylist(tx, args.playlistId);
        const items = await tx.run(zql.playlistItems.where('playlistId', args.playlistId));
        for (const track of planPlaylistAppend(items, args.tracks).added) {
          await tx.mutate.playlistItems.insert({ ...track, playlistId: args.playlistId, createdAt: args.now });
        }
      },
    ),
    removeTracks: defineMutator(
      validator(Schema.Struct({ ids: Schema.Array(PlaylistItemId).check(Schema.isMinLength(1)) })),
      async ({ tx, args }) => {
        for (const id of new Set(args.ids)) await tx.mutate.playlistItems.delete({ id });
      },
    ),
    reorder: defineMutator(
      validator(
        Schema.Struct({
          playlistId: PlaylistId,
          itemIds: Schema.Array(PlaylistItemId).check(Schema.isMinLength(1)),
        }),
      ),
      async ({ tx, args }) => {
        await lockPlaylist(tx, args.playlistId);
        const items = await tx.run(zql.playlistItems.where('playlistId', args.playlistId));
        const itemIds = new Set(items.map((item) => item.id));
        const order = new Set(args.itemIds);
        if (
          order.size !== args.itemIds.length ||
          order.size !== itemIds.size ||
          args.itemIds.some((id) => !itemIds.has(id))
        )
          throw new Error('Playlist order must contain every track in the playlist once');

        const positions = new Map(items.map((item) => [item.id, item.position]));
        for (const [position, id] of args.itemIds.entries()) {
          if (positions.get(id) !== position) await tx.mutate.playlistItems.update({ id, position });
        }
      },
    ),
  },
  mediaEntries: {
    reorder: defineMutator(
      validator(
        Schema.Struct({
          rootId: MediaRootId,
          parentId: Schema.NullOr(MediaEntryId),
          entryIds: Schema.Array(MediaEntryId).check(Schema.isMinLength(1)),
        }),
      ),
      async ({ tx, args }) => {
        if (new Set(args.entryIds).size !== args.entryIds.length)
          throw new Error('Media order contains duplicate entries');

        const rootEntries = zql.mediaEntries
          .where('mediaRootId', args.rootId)
          .where('deletedAt', 'IS', null)
          .where('kind', 'file')
          .where('isVideo', true);
        const siblings = await tx.run(
          args.parentId === null
            ? rootEntries.where('parentId', 'IS', null)
            : rootEntries.where('parentId', args.parentId),
        );
        const siblingIds = new Set(siblings.map((entry) => entry.id));
        if (siblingIds.size !== args.entryIds.length || args.entryIds.some((entryId) => !siblingIds.has(entryId))) {
          throw new Error('Media order must contain every video in the folder');
        }

        for (const [sortOrder, id] of args.entryIds.entries()) {
          await tx.mutate.mediaEntries.update({ id, sortOrder });
        }
      },
    ),
  },
  plays: {
    /** One listen to a song, sent by the music player once enough of it has played ($lib/music/plays). */
    record: defineMutator(
      validator(Schema.Struct({ id: TrackPlayId, profileId: ProfileId, mediaEntryId: MediaEntryId, now: Timestamp })),
      async ({ tx, args }) => {
        const track = await tx.run(
          zql.mediaEntries.where('id', args.mediaEntryId).where('isAudio', true).where('deletedAt', 'IS', null).one(),
        );
        requireOnServer(tx, track, 'Song does not exist');
        await tx.mutate.trackPlays.insert({
          id: args.id,
          profileId: args.profileId,
          mediaEntryId: args.mediaEntryId,
          playedAt: args.now,
        });
      },
    ),
  },
  progress: {
    remove: defineMutator(
      validator(Schema.Struct({ profileId: ProfileId, mediaEntryId: MediaEntryId })),
      async ({ tx, args }) => {
        await tx.mutate.playbackProgress.delete(args);
      },
    ),
    setWatched: defineMutator(
      validator(
        Schema.Struct({
          profileId: ProfileId,
          mediaEntryId: MediaEntryId,
          watched: Schema.Boolean,
          now: Timestamp,
        }),
      ),
      async ({ tx, args }) => {
        const current = await tx.run(
          zql.playbackProgress.where('profileId', args.profileId).where('mediaEntryId', args.mediaEntryId).one(),
        );
        const media = await tx.run(
          zql.mediaEntries.where('id', args.mediaEntryId).where('deletedAt', 'IS', null).one(),
        );
        requireOnServer(tx, media, 'Media does not exist');
        await tx.mutate.playbackProgress.upsert({
          profileId: args.profileId,
          mediaEntryId: args.mediaEntryId,
          watched: args.watched,
          positionMs: current?.positionMs ?? 0,
          durationMs: current?.durationMs ?? media?.durationMs ?? null,
          lastPlayedAt: args.now,
          updatedAt: args.now,
        });
      },
    ),
    save: defineMutator(
      validator(
        Schema.Struct({
          profileId: ProfileId,
          mediaEntryId: MediaEntryId,
          positionMs: Milliseconds,
          durationMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
          watched: Schema.optional(Schema.Boolean),
          now: Timestamp,
        }),
      ),
      async ({ tx, args }) => {
        const current = await tx.run(
          zql.playbackProgress.where('profileId', args.profileId).where('mediaEntryId', args.mediaEntryId).one(),
        );
        const media = await tx.run(
          zql.mediaEntries.where('id', args.mediaEntryId).where('deletedAt', 'IS', null).one(),
        );
        requireOnServer(tx, media, 'Media does not exist');
        const watched =
          Boolean(current?.watched) || Boolean(args.watched) || isWatched(args.positionMs, args.durationMs);
        await tx.mutate.playbackProgress.upsert({
          profileId: args.profileId,
          mediaEntryId: args.mediaEntryId,
          positionMs: args.positionMs,
          durationMs: args.durationMs ?? current?.durationMs ?? media?.durationMs ?? null,
          watched,
          lastPlayedAt: args.now,
          updatedAt: args.now,
        });
      },
    ),
  },
});

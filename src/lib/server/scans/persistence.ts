import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import {
  externalSubtitles,
  mediaChapters,
  mediaEntries,
  mediaRoots,
  mediaTracks,
  scanErrors,
  scanRuns,
} from '$lib/server/db/schema';
import {
  orUnavailable,
  type DatabaseUnavailable,
  type FernDatabase,
  type FernTransaction,
} from '$lib/server/db/service';
import type { NormalizedTrack, ProbeResult } from '$lib/server/media/probe';
import type { ScanCounts, ScanState } from '$lib/shared/contracts/scans';
import { PROBE_VERSION, type ExistingEntry, type PlannedEntry, type SubtitleAssociation } from './plan';
import { statesBefore } from './state';

/** Rows per multi-row statement: large enough to batch, small enough to stay well under parameter limits. */
const WRITE_BATCH_SIZE = 500;

function chunks<A>(items: readonly A[], size: number): A[][] {
  const result: A[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

type ScanErrorRow = {
  readonly mediaRootId: string | null;
  readonly relativePath: string | null;
  readonly stage: 'walk' | 'probe';
  readonly errorCode: string;
  readonly message: string;
};

export type ProbeOutcome =
  | { readonly id: string; readonly relativePath: string; readonly result: ProbeResult }
  | { readonly id: string; readonly relativePath: string; readonly error: string };

/** The statement that moves a scan to `to` only from a state allowed to reach it; for use in transactions. */
export function transitionScanStatement(
  db: FernDatabase | FernTransaction,
  scanId: string,
  to: ScanState,
  fields: Partial<typeof scanRuns.$inferInsert> = {},
) {
  return db
    .update(scanRuns)
    .set({ ...fields, state: to })
    .where(and(eq(scanRuns.id, scanId), inArray(scanRuns.state, statesBefore(to))))
    .returning({ id: scanRuns.id });
}

/** Moves a scan to `to` only from a state allowed to reach it. Returns whether the row changed. */
export function transitionScan(
  db: FernDatabase,
  scanId: string,
  to: ScanState,
  fields: Partial<typeof scanRuns.$inferInsert> = {},
) {
  return orUnavailable(transitionScanStatement(db, scanId, to, fields)).pipe(Effect.map((rows) => rows.length > 0));
}

export function loadScan(db: FernDatabase, scanId: string) {
  return orUnavailable(db.select().from(scanRuns).where(eq(scanRuns.id, scanId)).limit(1)).pipe(
    Effect.map((rows) => rows[0]),
  );
}

export function writeProgress(
  db: FernDatabase,
  scanId: string,
  progress: ScanCounts & { currentRootId: string | null; currentPath: string | null },
) {
  return orUnavailable(db.update(scanRuns).set(progress).where(eq(scanRuns.id, scanId)));
}

export function loadRoots(db: FernDatabase, rootId: string | null) {
  return orUnavailable(
    rootId
      ? db.select().from(mediaRoots).where(eq(mediaRoots.id, rootId))
      : db.select().from(mediaRoots).orderBy(mediaRoots.displayOrder, mediaRoots.displayName),
  );
}

/** One query for every stored entry of a root, instead of one per discovered file. */
export function loadExistingEntries(db: FernDatabase, rootId: string) {
  return orUnavailable(
    db
      .select({
        id: mediaEntries.id,
        relativePath: mediaEntries.relativePath,
        parentId: mediaEntries.parentId,
        name: mediaEntries.name,
        kind: mediaEntries.kind,
        extension: mediaEntries.extension,
        sizeBytes: mediaEntries.sizeBytes,
        mtimeMs: mediaEntries.mtimeMs,
        isVideo: mediaEntries.isVideo,
        isAudio: mediaEntries.isAudio,
        probeStatus: mediaEntries.probeStatus,
        probeVersion: mediaEntries.probeVersion,
        deletedAt: mediaEntries.deletedAt,
        artworkMediaEntryId: mediaEntries.artworkMediaEntryId,
      })
      .from(mediaEntries)
      .where(eq(mediaEntries.mediaRootId, rootId)),
  ) as Effect.Effect<ExistingEntry[], DatabaseUnavailable>;
}

/** Writes changed entries in order (parents first), a batch per statement. Returns the statement count. */
export function upsertEntries(db: FernDatabase, rootId: string, scanId: string, entries: readonly PlannedEntry[]) {
  const batches = chunks(entries, WRITE_BATCH_SIZE);
  return Effect.forEach(
    batches,
    (batch) =>
      orUnavailable(
        db
          .insert(mediaEntries)
          .values(
            batch.map((entry) => ({
              id: entry.id,
              mediaRootId: rootId,
              parentId: entry.parentId,
              relativePath: entry.relativePath,
              name: entry.name,
              kind: entry.kind,
              extension: entry.extension,
              sizeBytes: entry.sizeBytes,
              mtimeMs: entry.mtimeMs,
              isVideo: entry.isVideo,
              isAudio: entry.isAudio,
              probeStatus: entry.probeStatus,
              probeVersion: PROBE_VERSION,
              deletedAt: null,
            })),
          )
          .onConflictDoUpdate({
            target: [mediaEntries.mediaRootId, mediaEntries.relativePath],
            set: {
              parentId: sql`excluded.parent_id`,
              name: sql`excluded.name`,
              kind: sql`excluded.kind`,
              extension: sql`excluded.extension`,
              sizeBytes: sql`excluded.size_bytes`,
              mtimeMs: sql`excluded.mtime_ms`,
              isVideo: sql`excluded.is_video`,
              isAudio: sql`excluded.is_audio`,
              probeStatus: sql`excluded.probe_status`,
              probeVersion: sql`excluded.probe_version`,
              deletedAt: null,
              updatedAt: sql`now()`,
            },
          }),
      ),
    { discard: true },
  ).pipe(Effect.as(batches.length));
}

export function softDeleteEntries(db: FernDatabase, ids: readonly string[]) {
  return Effect.forEach(
    chunks(ids, WRITE_BATCH_SIZE),
    (batch) =>
      orUnavailable(
        db
          .update(mediaEntries)
          .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
          .where(and(inArray(mediaEntries.id, batch), isNull(mediaEntries.deletedAt))),
      ),
    { discard: true },
  );
}

function trackRows(entryId: string, tracks: readonly NormalizedTrack[]) {
  return tracks.map((track) => ({ id: randomUUID(), mediaEntryId: entryId, ...track }));
}

/** Stores one batch of probe results in a single transaction, replacing each entry's tracks and chapters. */
export function writeProbeOutcomes(
  db: FernDatabase,
  scanId: string,
  rootId: string,
  outcomes: readonly ProbeOutcome[],
) {
  return orUnavailable(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const succeeded = outcomes.filter((outcome) => 'result' in outcome);
        const failed = outcomes.filter((outcome) => 'error' in outcome);
        for (const { id, result } of succeeded) {
          yield* tx
            .update(mediaEntries)
            .set({
              durationMs: result.durationMs,
              container: result.container,
              videoCodec: result.videoCodec,
              audioCodecSummary: result.audioCodecSummary,
              audioBitrate: result.audioBitrate,
              audioSampleRate: result.audioSampleRate,
              audioBitDepth: result.audioBitDepth,
              audioChannels: result.audioChannels,
              audioChannelLayout: result.audioChannelLayout,
              width: result.width,
              height: result.height,
              title: result.title,
              artist: result.artist,
              album: result.album,
              albumArtist: result.albumArtist,
              trackNumber: result.trackNumber,
              probeStatus: 'ok',
              probeErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(mediaEntries.id, id));
        }
        const touched = outcomes.map((outcome) => outcome.id);
        if (touched.length) {
          yield* tx.delete(mediaTracks).where(inArray(mediaTracks.mediaEntryId, touched));
          yield* tx.delete(mediaChapters).where(inArray(mediaChapters.mediaEntryId, touched));
        }
        const tracks = succeeded.flatMap(({ id, result }) => trackRows(id, result.tracks));
        for (const batch of chunks(tracks, WRITE_BATCH_SIZE)) yield* tx.insert(mediaTracks).values(batch);
        const chapters = succeeded.flatMap(({ id, result }) =>
          result.chapters.map((chapter) => ({ mediaEntryId: id, ...chapter })),
        );
        for (const batch of chunks(chapters, WRITE_BATCH_SIZE)) yield* tx.insert(mediaChapters).values(batch);
        if (failed.length) {
          yield* tx
            .update(mediaEntries)
            .set({ probeStatus: 'failed', probeErrorCode: 'FFPROBE_FAILED', updatedAt: new Date() })
            .where(
              inArray(
                mediaEntries.id,
                failed.map((outcome) => outcome.id),
              ),
            );
          yield* tx.insert(scanErrors).values(
            failed.map((outcome) => ({
              id: randomUUID(),
              scanRunId: scanId,
              mediaRootId: rootId,
              relativePath: outcome.relativePath,
              stage: 'probe',
              errorCode: 'FFPROBE_FAILED',
              message: outcome.error,
            })),
          );
        }
      }),
    ),
  );
}

export function upsertSubtitles(db: FernDatabase, associations: readonly SubtitleAssociation[]) {
  return Effect.forEach(
    chunks(associations, WRITE_BATCH_SIZE),
    (batch) =>
      orUnavailable(
        db
          .insert(externalSubtitles)
          .values(batch.map((association) => ({ id: randomUUID(), ...association })))
          .onConflictDoUpdate({
            target: [externalSubtitles.mediaEntryId, externalSubtitles.relativePath],
            set: { mtimeMs: sql`excluded.mtime_ms`, deletedAt: null, updatedAt: sql`now()` },
          }),
      ),
    { discard: true },
  );
}

/** Applies artwork changes with one UPDATE … FROM (VALUES …) per batch. */
export function updateArtwork(
  db: FernDatabase,
  changes: ReadonlyArray<{ readonly id: string; readonly artworkId: string | null }>,
) {
  return Effect.forEach(
    chunks(changes, WRITE_BATCH_SIZE),
    (batch) =>
      orUnavailable(
        db.execute(sql`
          update ${mediaEntries}
          set artwork_media_entry_id = changes.artwork_id, updated_at = now()
          from (values ${sql.join(
            batch.map((change) => sql`(${change.id}::uuid, ${change.artworkId}::uuid)`),
            sql`, `,
          )}) as changes(id, artwork_id)
          where ${mediaEntries.id} = changes.id`),
      ),
    { discard: true },
  );
}

export function recordScanErrors(db: FernDatabase, scanId: string, rows: readonly ScanErrorRow[]) {
  if (!rows.length) return Effect.void;
  return Effect.forEach(
    chunks(rows, WRITE_BATCH_SIZE),
    (batch) =>
      orUnavailable(
        db.insert(scanErrors).values(batch.map((row) => ({ id: randomUUID(), scanRunId: scanId, ...row }))),
      ),
    { discard: true },
  );
}

/** A retried scan starts its error list afresh. */
export function clearScanErrors(db: FernDatabase, scanId: string) {
  return orUnavailable(db.delete(scanErrors).where(eq(scanErrors.scanRunId, scanId)));
}

export function markRootScanned(db: FernDatabase, rootId: string) {
  return orUnavailable(
    db
      .update(mediaRoots)
      .set({ lastScannedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(mediaRoots.id, rootId)),
  );
}

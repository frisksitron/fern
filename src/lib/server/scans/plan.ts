import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '$lib/shared/constants';
import type { DiscoveredItem } from './traversal';

/** Bump to re-probe every media file on the next scan (for example after changing what is extracted). */
export const PROBE_VERSION = 3;

type ProbeStatus = 'not_required' | 'pending' | 'ok' | 'failed';

/** The stored fields of an entry that a scan compares against the filesystem. */
export type ExistingEntry = {
  readonly id: string;
  readonly relativePath: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: string;
  readonly extension: string | null;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number;
  readonly isVideo: boolean;
  readonly isAudio: boolean;
  readonly probeStatus: string;
  readonly probeVersion: number;
  readonly deletedAt: Date | null;
  readonly artworkMediaEntryId: string | null;
};

export type PlannedEntry = {
  readonly id: string;
  readonly relativePath: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: 'directory' | 'file';
  readonly extension: string | null;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number;
  readonly isVideo: boolean;
  readonly isAudio: boolean;
  readonly probeStatus: ProbeStatus;
  /** New, changed, or previously deleted, so the row must be written. */
  readonly changed: boolean;
};

type EntryPlan = {
  /** Every discovered entry, parents before children. */
  readonly entries: readonly PlannedEntry[];
  /** Active rows whose files are gone. */
  readonly removedIds: readonly string[];
};

/**
 * Decides how to reconcile a root's stored entries with what traversal found. Entry IDs are stable:
 * an existing row keeps its ID. Only new, changed, or restored entries are marked for writing, and
 * media is marked for probing unless an unchanged file was already probed successfully by this version.
 */
export function planEntries(
  mediaType: 'video' | 'music',
  items: readonly DiscoveredItem[],
  existing: readonly ExistingEntry[],
): EntryPlan {
  const existingByPath = new Map(existing.map((entry) => [entry.relativePath, entry]));
  const idByPath = new Map<string, string>();
  const entries = items.map((item): PlannedEntry => {
    const stored = existingByPath.get(item.relativePath);
    const id = stored?.id ?? randomUUID();
    idByPath.set(item.relativePath, id);
    const isVideo = mediaType === 'video' && item.kind === 'file' && VIDEO_EXTENSIONS.has(item.extension ?? '');
    const isAudio = mediaType === 'music' && item.kind === 'file' && AUDIO_EXTENSIONS.has(item.extension ?? '');
    const fileChanged = !stored || stored.sizeBytes !== item.sizeBytes || stored.mtimeMs !== item.mtimeMs;
    // Failed probes are retried on every scan: failures are often transient (a network share
    // hiccup, a timeout), and a file that is still broken keeps being reported.
    const probeStatus: ProbeStatus = !(isVideo || isAudio)
      ? 'not_required'
      : fileChanged || stored.probeVersion !== PROBE_VERSION || stored.probeStatus !== 'ok'
        ? 'pending'
        : 'ok';
    const parentId = item.parentPath === null ? null : (idByPath.get(item.parentPath) ?? null);
    const changed =
      !stored ||
      fileChanged ||
      stored.deletedAt !== null ||
      stored.parentId !== parentId ||
      stored.name !== item.name ||
      stored.kind !== item.kind ||
      stored.extension !== item.extension ||
      stored.isVideo !== isVideo ||
      stored.isAudio !== isAudio ||
      stored.probeStatus !== probeStatus ||
      (probeStatus !== 'not_required' && stored.probeVersion !== PROBE_VERSION);
    return { ...item, id, parentId, isVideo, isAudio, probeStatus, changed };
  });
  const discovered = new Set(items.map((item) => item.relativePath));
  const removedIds = existing
    .filter((entry) => entry.deletedAt === null && !discovered.has(entry.relativePath))
    .map((entry) => entry.id);
  return { entries, removedIds };
}

const artworkExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Lower ranks win: cover, cover*, front, folder, albumart*large*, albumart*, then anything else. */
export function artworkRank(name: string) {
  const stem = path.parse(name).name.toLowerCase();
  if (stem === 'cover') return 0;
  if (stem.startsWith('cover')) return 1;
  if (stem === 'front') return 2;
  if (stem === 'folder') return 3;
  if (stem.startsWith('albumart') && stem.includes('large')) return 4;
  if (stem.startsWith('albumart')) return 5;
  return 6;
}

/**
 * The artwork each music folder and song should show: the best-ranked image in its folder or the
 * nearest ancestor folder with one. A song with an image of its own name beside it (`Mix.jpg` for
 * `Mix.opus`, as YouTube downloads are saved) shows that instead. Returns only entries whose stored
 * artwork differs.
 */
export function planArtwork(
  entries: readonly PlannedEntry[],
  storedArtwork: ReadonlyMap<string, string | null>,
): Array<{ readonly id: string; readonly artworkId: string | null }> {
  const parentOfDirectory = new Map(
    entries.filter((entry) => entry.kind === 'directory').map((entry) => [entry.id, entry.parentId]),
  );
  const artworkByFolder = new Map<string, string>();
  const ownArtwork = new Map<string, string>();
  const ownArtworkKey = (entry: PlannedEntry) => `${entry.parentId}/${path.parse(entry.name).name.toLowerCase()}`;
  const images = entries
    .filter((entry) => entry.kind === 'file' && artworkExtensions.has(entry.extension ?? ''))
    .sort((left, right) => artworkRank(left.name) - artworkRank(right.name) || left.name.localeCompare(right.name));
  for (const image of images) {
    if (image.parentId && !artworkByFolder.has(image.parentId)) artworkByFolder.set(image.parentId, image.id);
    if (!ownArtwork.has(ownArtworkKey(image))) ownArtwork.set(ownArtworkKey(image), image.id);
  }

  const changes: Array<{ id: string; artworkId: string | null }> = [];
  for (const entry of entries) {
    if (entry.kind !== 'directory' && !entry.isAudio) continue;
    let folderId: string | null = entry.kind === 'directory' ? entry.id : entry.parentId;
    while (folderId && !artworkByFolder.has(folderId)) folderId = parentOfDirectory.get(folderId) ?? null;
    const artworkId =
      (entry.isAudio ? ownArtwork.get(ownArtworkKey(entry)) : undefined) ??
      (folderId ? artworkByFolder.get(folderId)! : null);
    if ((storedArtwork.get(entry.id) ?? null) !== artworkId) changes.push({ id: entry.id, artworkId });
  }
  return changes;
}

export type SubtitleAssociation = {
  readonly mediaEntryId: string;
  readonly relativePath: string;
  readonly name: string;
  readonly format: string;
  readonly mtimeMs: number;
};

/**
 * Pairs `.srt` and `.vtt` files with a video in the same folder whose file name (without extension)
 * starts the subtitle's name, such as `Movie.en.srt` with `Movie.mp4`.
 */
export function planSubtitles(entries: readonly PlannedEntry[]): SubtitleAssociation[] {
  const videos = entries
    .filter((entry) => entry.isVideo)
    .map((entry) => ({
      id: entry.id,
      folder: path.posix.dirname(entry.relativePath),
      stem: path.basename(entry.name, entry.extension ?? ''),
    }));
  const associations: SubtitleAssociation[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || (entry.extension !== '.srt' && entry.extension !== '.vtt')) continue;
    const base = path.basename(entry.name, entry.extension);
    const folder = path.posix.dirname(entry.relativePath);
    const video = videos.find((candidate) => candidate.folder === folder && base.startsWith(candidate.stem));
    if (video)
      associations.push({
        mediaEntryId: video.id,
        relativePath: entry.relativePath,
        name: entry.name,
        format: entry.extension.slice(1),
        mtimeMs: entry.mtimeMs,
      });
  }
  return associations;
}

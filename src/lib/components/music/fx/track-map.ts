import { Option, Schema } from 'effect';
import { decodeTrackMap, TrackMapResponse, type TrackMap } from '$lib/shared/contracts/track-map';

/**
 * Tracks' maps (see `track-map.ts` in the shared contracts), which the server works out from the
 * song the first time one is asked for, and keeps. Each is fetched once and kept for the last few
 * tracks, so the next track's can be fetched ahead of time.
 */

const KEEP = 8;
/** Times to ask again while the server is busy with other songs. */
const RETRIES = 3;

const decode = Schema.decodeUnknownOption(TrackMapResponse);
const maps = new Map<string, Promise<TrackMap | null>>();

/** The track's map, or null if it has none (a file without audio, say) or it could not be fetched. */
export function trackMap(trackId: string) {
  let map = maps.get(trackId);
  if (!map) {
    const fetching = fetchMap(trackId).then((found) => {
      // Not kept, so it is asked for again next time.
      if (!found && maps.get(trackId) === fetching) maps.delete(trackId);
      return found;
    });
    map = fetching;
    maps.set(trackId, map);
    if (maps.size > KEEP) maps.delete(maps.keys().next().value!);
  }
  return map;
}

async function fetchMap(trackId: string): Promise<TrackMap | null> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/api/media/${trackId}/track-map`).catch(() => null);
    if (response?.status === 503 && attempt < RETRIES) {
      const seconds = Number(response.headers.get('retry-after')) || 2;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    if (!response?.ok) return null;
    const body = Option.getOrNull(decode(await response.json().catch(() => null)));
    const map = body && decodeTrackMap(body);
    // A file too short to measure has nothing to draw.
    return map?.calm.length ? map : null;
  }
}

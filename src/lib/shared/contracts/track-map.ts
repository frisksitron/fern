import { Schema } from 'effect';

/**
 * A map of a whole song, made on the server ahead of playback (see
 * `src/lib/server/track-maps/analysis.ts`): how loud its bass, mid, and treble are at each moment,
 * where each range hits, how calm it is, and where its peaks are. The FX page's effects compile it
 * into what they draw over the song.
 *
 * Everything is measured against the song itself, so a quiet ballad and a loud dance track both
 * use the whole range: a level of 1 is as loud as that range gets in that song, and its peaks are
 * its own big moments, where its sound fills out the most.
 */

/** Seconds per step of a track map. */
export const TRACK_MAP_STEP = 0.05;

export type Range = 'bass' | 'mid' | 'treble';

export const Peak = Schema.Struct({
  /** Seconds into the track where it hits, and where it ends. */
  start: Schema.Finite,
  end: Schema.Finite,
  /** 0.3 to 1: how far above the song's calmer parts it is. */
  strength: Schema.Finite,
});
export type Peak = typeof Peak.Type;

export type TrackMap = {
  /** In order, and never overlapping. */
  peaks: readonly Peak[];
  /** Per step: 0 to 1, how loud each range is against the whole song. */
  levels: Record<Range, Float32Array>;
  /** Per step: 0 to 1, how hard each range hits there, or 0 where it does not. */
  hits: Record<Range, Float32Array>;
  /** Per step: 0 to 1, how calm the song is there: quiet, or light and without bass. */
  calm: Float32Array;
};

/** A series of values from 0 to 1, one a step, as bytes (0 to 255) in base64. */
const Series = Schema.String;
const Ranges = Schema.Struct({ bass: Series, mid: Series, treble: Series });

/** `GET /api/media/:id/track-map`: the track's map, about a kilobyte for every 7 s of song. */
export const TrackMapResponse = Schema.Struct({
  peaks: Schema.Array(Peak),
  levels: Ranges,
  hits: Ranges,
  calm: Series,
});
export type TrackMapResponse = typeof TrackMapResponse.Type;

function toSeries(values: Float32Array) {
  const bytes = Uint8Array.from(values, (value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromSeries(series: string) {
  const binary = atob(series);
  return Float32Array.from({ length: binary.length }, (_, at) => binary.charCodeAt(at) / 255);
}

const ranges = <A, B>(of: Record<Range, A>, each: (value: A) => B): Record<Range, B> => ({
  bass: each(of.bass),
  mid: each(of.mid),
  treble: each(of.treble),
});

export function encodeTrackMap(map: TrackMap): TrackMapResponse {
  return {
    peaks: map.peaks,
    levels: ranges(map.levels, toSeries),
    hits: ranges(map.hits, toSeries),
    calm: toSeries(map.calm),
  };
}

export function decodeTrackMap(response: TrackMapResponse): TrackMap {
  return {
    peaks: response.peaks,
    levels: ranges(response.levels, fromSeries),
    hits: ranges(response.hits, fromSeries),
    calm: fromSeries(response.calm),
  };
}

import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { compileScore, ROWS } from '../../src/lib/components/music/fx/score';
import { loudnessMeter, mapSong, mapTrack, SAMPLE_RATE } from '../../src/lib/server/track-maps/analysis';
import {
  decodeTrackMap,
  encodeTrackMap,
  TRACK_MAP_STEP,
  TrackMapResponse,
  type TrackMap,
} from '../../src/lib/shared/contracts/track-map';

/**
 * 90 s of song: a quiet verse (a lone tone), a chorus from 30 s to 60 s (the tone louder over a bass
 * line, a kick every half second, and a hi-hat every quarter), and the verse again.
 */
function song() {
  let seed = 1;
  const noise = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  return Float32Array.from({ length: SAMPLE_RATE * 90 }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * 440 * time);
    if (time < 30 || time >= 60) return tone * 0.05;
    const [kick, hat] = [time % 0.5, time % 0.25];
    return (
      tone * 0.2 +
      Math.sin(2 * Math.PI * 80 * time) * 0.15 +
      Math.exp(-kick / 0.08) * Math.sin(2 * Math.PI * 60 * kick) * 0.6 +
      Math.exp(-hat / 0.03) * noise() * 0.15
    );
  });
}

/** The map of `samples`, written to the meter `chunk` bytes at a time. */
function mapOf(samples: Float32Array, chunk = Infinity) {
  const bytes = new Uint8Array(samples.buffer);
  const meter = loudnessMeter();
  for (let at = 0; at < bytes.length; at += Math.min(chunk, bytes.length)) meter.write(bytes.subarray(at, at + chunk));
  return mapSong(meter.finish());
}

const steps = (from: number, to: number) => [Math.round(from / TRACK_MAP_STEP), Math.round(to / TRACK_MAP_STEP)];
const count = (values: Float32Array, from: number, to: number) =>
  values.subarray(...steps(from, to)).filter((value) => value > 0).length;
const mean = (values: Float32Array, from: number, to: number) => {
  const part = values.subarray(...steps(from, to));
  return part.reduce((sum, value) => sum + value, 0) / part.length;
};

describe('song analysis', () => {
  const map = mapOf(song());

  it('finds the chorus as the peak, and its kicks and hi-hats', () => {
    expect(map.calm).toHaveLength(90 / TRACK_MAP_STEP);
    expect(map.peaks).toHaveLength(1);
    expect(map.peaks[0].start).toBeCloseTo(30, 0);
    expect(map.peaks[0].end).toBeCloseTo(60, 0);
    expect(count(map.hits.bass, 30, 60)).toBe(60);
    expect(count(map.hits.bass, 0, 30) + count(map.hits.bass, 60, 90)).toBe(0);
    expect(count(map.hits.treble, 30, 60)).toBeGreaterThanOrEqual(100);
  });

  it('is calm in the verses and not in the chorus', () => {
    expect(mean(map.calm, 5, 25)).toBeGreaterThan(0.9);
    expect(mean(map.calm, 35, 55)).toBeLessThan(0.1);
    expect(mean(map.levels.bass, 35, 55)).toBeGreaterThan(0.5);
  });

  it('comes out the same however the audio is split into chunks', () => {
    // Odd sizes split samples between chunks, as pipes do.
    expect(mapOf(song(), 65_531)).toEqual(map);
    expect(mapOf(song(), 3)).toEqual(map);
  });

  it('maps silence, and audio too short for a step, without peaks', () => {
    const silent = mapOf(new Float32Array(SAMPLE_RATE * 10));
    expect(silent.peaks).toEqual([]);
    expect([...silent.levels.bass, ...silent.hits.bass, ...silent.calm].every(Number.isFinite)).toBe(true);
    expect(mapOf(new Float32Array(100)).calm).toHaveLength(0);
  });
});

describe('mix analysis', () => {
  /** A DJ mix of two songs: the song, then the same song 12 dB quieter. */
  const loudness = (() => {
    const loud = song();
    const samples = new Float32Array(loud.length * 2);
    samples.set(loud);
    samples.set(
      song().map((sample) => sample / 4),
      loud.length,
    );
    const meter = loudnessMeter();
    meter.write(new Uint8Array(samples.buffer));
    return meter.finish();
  })();

  it('maps each chapter as a song of its own, so a quieter song is mapped like a loud one', () => {
    const map = mapTrack(loudness, [0, 90]);
    expect(map.calm).toHaveLength(180 / TRACK_MAP_STEP);
    expect(map.peaks.map((peak) => [Math.round(peak.start), Math.round(peak.end)])).toEqual([
      [30, 60],
      [120, 150],
    ]);
    expect(count(map.hits.bass, 120, 150)).toBe(60);
    expect(mean(map.levels.bass, 125, 145)).toBeCloseTo(mean(map.levels.bass, 35, 55), 1);
    expect(mean(map.calm, 125, 145)).toBeLessThan(0.1);
  });

  it('maps a track without chapters as one song, against its loudest parts', () => {
    const map = mapTrack(loudness);
    expect(map).toEqual(mapSong(loudness));
    // The quieter song is measured against the loud one, so its chorus never gets near the top.
    expect(mean(map.levels.bass, 125, 145)).toBeLessThan(mean(map.levels.bass, 35, 55) - 0.2);
  });

  it('measures a chapter too short to judge with the one before it', () => {
    const halves = mapTrack(loudness, [0, 90]);
    expect(mapTrack(loudness, [0, 10, 90])).toEqual(halves);
    expect(mapTrack(loudness, [0, 90, 175])).toEqual(halves);
  });
});

describe('track map wire format', () => {
  it('round-trips through JSON to within a byte per value', () => {
    const map = mapOf(song());
    const response = Schema.decodeUnknownSync(Schema.fromJsonString(TrackMapResponse))(
      JSON.stringify(encodeTrackMap(map)),
    );
    const decoded = decodeTrackMap(response);
    expect(decoded.peaks).toEqual(map.peaks);
    for (const [series, original] of [
      [decoded.levels.bass, map.levels.bass],
      [decoded.hits.treble, map.hits.treble],
      [decoded.calm, map.calm],
    ]) {
      expect(series).toHaveLength(original.length);
      series.forEach((value, step) => expect(Math.abs(value - original[step])).toBeLessThanOrEqual(1 / 510));
    }
  });
});

describe('compileScore', () => {
  /** Ten seconds of steady bass with a kick at 2 s, and a peak from 5 s to 8 s. */
  function steady(): TrackMap {
    const length = 10 / TRACK_MAP_STEP;
    const series = (value: number) => new Float32Array(length).fill(value);
    const kicks = series(0);
    kicks[2 / TRACK_MAP_STEP] = 0.9;
    return {
      peaks: [{ start: 5, end: 8, strength: 0.8 }],
      levels: { bass: series(0.8), mid: series(0.5), treble: series(0.5) },
      hits: { bass: kicks, mid: series(0), treble: series(0) },
      calm: series(0),
    };
  }
  const row = (table: Float32Array, step: number, index: number) =>
    [...table.subarray((step * ROWS + index) * 4, (step * ROWS + index + 1) * 4)].map(
      (value) => Math.round(value * 100) / 100,
    );

  it('holds the latest kick and peak at every step after them', () => {
    const { steps, table } = compileScore(steady());
    expect(steps).toBe(200);
    // Before the kick, none so far; from it on, when it started, how strong, and that it was the first.
    expect(row(table, 39, 3)).toEqual([-1e6, -1e6, 0, 0]);
    expect(row(table, 40, 3)).toEqual([2, 2, 0.9, 1]);
    expect(row(table, 199, 3)).toEqual([2, 2, 0.9, 1]);
    expect(row(table, 99, 5)).toEqual([-1e6, -1e6, 0, 0]);
    expect(row(table, 100, 5)).toEqual([5, 8, 0.8, 1]);
  });

  it('winds up for a peak in the seconds before it, and overflows through it', () => {
    const { table } = compileScore(steady());
    const [charge, overflow] = [(step: number) => row(table, step, 2)[3], (step: number) => row(table, step, 1)[3]];
    expect(charge(40)).toBe(0);
    expect(charge(95)).toBeGreaterThan(0.5);
    expect(charge(120)).toBe(0);
    expect(overflow(90)).toBe(0);
    expect(overflow(150)).toBeGreaterThan(0.7);
  });
});

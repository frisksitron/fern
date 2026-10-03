import { TRACK_MAP_STEP as STEP, type Peak, type TrackMap } from '$lib/shared/contracts/track-map';

/**
 * Works out a song's map (see `track-map.ts` in the shared contracts) from its samples, measuring
 * it as it is decoded and then finding its hits, calm stretches, and peaks.
 */

/** Samples a second the song is decoded at: plenty up to the treble, and a whole number a step. */
export const SAMPLE_RATE = 24_000;
/** Changes whenever the analysis does, so maps made before are made again. */
export const ANALYSIS_VERSION = 2;
/** Below this (dB) a step counts as silence. */
const SILENCE = -55;

/** A second-order Butterworth filter (from the Audio EQ Cookbook), run one sample at a time. */
class Filter {
  private readonly b0: number;
  private readonly b1: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(type: 'lowpass' | 'highpass', hz: number, rate: number) {
    const w = (2 * Math.PI * hz) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / Math.SQRT2;
    const a0 = 1 + alpha;
    this.b0 = (type === 'lowpass' ? 1 - cos : 1 + cos) / 2 / a0;
    this.b1 = (type === 'lowpass' ? 2 : -2) * this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  run(x: number) {
    const y = this.b0 * (x + this.x2) + this.b1 * this.x1 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Loudness in dB per `STEP`: in all, per range, and in the air above the treble. */
export type Loudness = Record<'total' | 'bass' | 'mid' | 'treble' | 'air', Float32Array>;

/**
 * Measures a song's loudness as it is decoded, from its samples mixed down to one channel as
 * little-endian 32-bit floats, `rate` a second, in chunks of any size: in dB per `STEP`, in all,
 * per range, and in the air above the treble (8 kHz up, where hi-hats and cymbals shine).
 */
export function loudnessMeter(rate = SAMPLE_RATE) {
  const [bass, midLow, midHigh] = [
    new Filter('lowpass', 150, rate),
    new Filter('highpass', 300, rate),
    new Filter('lowpass', 2_000, rate),
  ];
  const [treble, air] = [new Filter('highpass', 4_000, rate), new Filter('highpass', 8_000, rate)];
  const measured = {
    total: [] as number[],
    bass: [] as number[],
    mid: [] as number[],
    treble: [] as number[],
    air: [] as number[],
  };
  // The sums of squares in the step so far, and where it started and ends (in samples).
  const squares = { total: 0, bass: 0, mid: 0, treble: 0, air: 0 };
  let [sample, start, end] = [0, 0, Math.round(rate * STEP)];
  // The bytes of a sample split between chunks.
  const carry = new DataView(new ArrayBuffer(4));
  let carried = 0;

  function add(x: number) {
    const [low, mid, high, above] = [bass.run(x), midHigh.run(midLow.run(x)), treble.run(x), air.run(x)];
    squares.total += x * x;
    squares.bass += low * low;
    squares.mid += mid * mid;
    squares.treble += high * high;
    squares.air += above * above;
    if (++sample < end) return;
    for (const range of ['total', 'bass', 'mid', 'treble', 'air'] as const) {
      measured[range].push(10 * Math.log10(squares[range] / (end - start) + 1e-10));
      squares[range] = 0;
    }
    start = end;
    end = Math.round((measured.total.length + 1) * rate * STEP);
  }

  return {
    write(chunk: Uint8Array) {
      let at = 0;
      while (carried && carried < 4 && at < chunk.length) carry.setUint8(carried++, chunk[at++]);
      if (carried === 4) {
        add(carry.getFloat32(0, true));
        carried = 0;
      }
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (; at + 4 <= chunk.length; at += 4) add(view.getFloat32(at, true));
      while (at < chunk.length) carry.setUint8(carried++, chunk[at++]);
    },
    /** The loudness of every whole step written. */
    finish(): Loudness {
      return {
        total: Float32Array.from(measured.total),
        bass: Float32Array.from(measured.bass),
        mid: Float32Array.from(measured.mid),
        treble: Float32Array.from(measured.treble),
        air: Float32Array.from(measured.air),
      };
    },
  };
}

/** A song's map from its loudness (see `loudnessMeter`). */
export function mapSong(loudness: Loudness): TrackMap {
  const audible = loudness.total.map((value) => (value > SILENCE ? 1 : 0));
  const levels = {
    bass: normalise(loudness.bass, audible),
    mid: normalise(loudness.mid, audible),
    treble: normalise(loudness.treble, audible),
  };
  // How hard the music drives: the bass for half, the mids and treble a quarter each, so a chorus
  // counts whether it gets bigger in the bass or in the mids and treble (distorted guitars over the
  // same bass).
  const drive = loudness.total.map((_, step) =>
    Math.max(SILENCE, loudness.bass[step] * 0.5 + loudness.mid[step] * 0.25 + loudness.treble[step] * 0.25),
  );
  const peaks = findPeaks(loudness, drive, audible);
  return {
    peaks,
    levels,
    hits: { bass: findHits(levels.bass), mid: findHits(levels.mid), treble: findHits(levels.treble) },
    calm: findCalm(drive, levels, audible, peaks),
  };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function percentile(values: Float32Array, fraction: number) {
  const sorted = values.slice().sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** The mean of `values` over any stretch of steps, `from` up to `to`. */
function means(values: Float32Array) {
  const sums = new Float64Array(values.length + 1);
  values.forEach((value, step) => (sums[step + 1] = sums[step] + value));
  return (from: number, to: number) => (sums[to] - sums[from]) / Math.max(1, to - from);
}

/** The mean over `seconds` around each step. */
function smooth(values: Float32Array, seconds: number) {
  const sums = new Float64Array(values.length + 1);
  values.forEach((value, step) => (sums[step + 1] = sums[step] + value));
  const half = Math.round(seconds / STEP / 2);
  return values.map((_, step) => {
    const [from, to] = [Math.max(0, step - half), Math.min(values.length, step + half + 1)];
    return (sums[to] - sums[from]) / (to - from);
  });
}

/** dB to 0 to 1 against the song: 0 at its quietest tenth, 1 at the loudest it gets. */
function normalise(loudness: Float32Array, audible: Float32Array) {
  const heard = loudness.filter((_, step) => audible[step]);
  const low = percentile(heard, 0.1);
  // At least 9 dB, so a range that barely changes does not swing all the way.
  const high = Math.max(low + 9, percentile(heard, 0.98));
  return loudness.map((value, step) => (audible[step] ? clamp((value - low) / (high - low)) : 0));
}

/** Where a range jumps up within 150 ms, at the top of the jump: kicks in the bass, hi-hats in the treble. */
function findHits(level: Float32Array) {
  const rise = level.map((value, step) =>
    step < 3 ? 0 : value - Math.min(level[step - 1], level[step - 2], level[step - 3]),
  );
  return rise.map((value, step) =>
    value > 0.12 && level[step] > 0.3 && value >= rise[step - 1] && value > (rise[step + 1] ?? 0)
      ? clamp(0.2 + value * 2)
      : 0,
  );
}

/** Steps in a frame, the song's sections are found in: half a second. */
const FRAME = 10;
/** Frames in `seconds`, and steps. */
const frames = (seconds: number) => Math.round(seconds / (FRAME * STEP));
const steps = (seconds: number) => Math.round(seconds / STEP);

/** A stretch of the song between two places its sound changes, in frames. */
type Section = { from: number; to: number };
/**
 * Where the music lifts into a section: the step it hits, how full the sound is over the 16 s
 * after, and how much it lifts, as much as any range comes up over the 8 s before.
 */
type Lift = { section: Section; at: number; full: number; lift: number };

/**
 * The song's peaks: the moments it lifts into its fullest stretches. How loud the song is says
 * little about where these are: mastered loud, a whole song can be as loud as its chorus, and a
 * build-up as loud as its drop. What marks them is the sound filling out, the bass coming in under
 * it or the cymbals over it, and how far it lifts into that.
 *
 * Every section (see `sectionsOf`) starts with a lift, on the hit: the moment near its edge where
 * the sound fills out the most. The peaks start at the best of them, by how full the sound is
 * after and how much it lifts: only real lifts into full sound, at most one to every 50 s of song,
 * and none within 25 s of a better one, so a build-up gives way to its drop, and a pre-chorus to
 * its chorus. Each lasts through the full sections after it (over brief dips), 8 s to 40 s, until
 * the sound thins out or the next one comes in.
 */
function findPeaks(loudness: Loudness, drive: Float32Array, audible: Float32Array): Peak[] {
  const heard = framed(audible).map((share) => (share >= 0.5 ? 1 : 0));
  const { sections, ranges, fullness } = sectionsOf(loudness, heard);
  const full = means(fullness);
  const jump = jumps(fullness);
  const length = fullness.length;
  const lifts = sections.slice(1).map((section): Lift => {
    let at = section.from * FRAME;
    const [first, last] = [Math.max(steps(8), at - steps(1)), Math.min(length - steps(8), at + steps(3))];
    for (let step = first; step <= last; step++) if (jump[step] > jump[at]) at = step;
    const before = Math.max(0, at - steps(8));
    const lift = Math.max(...ranges.map((mean) => mean(at, Math.min(length, at + steps(8))) - mean(before, at)));
    return { section, at, full: full(at, Math.min(length, at + steps(16))), lift };
  });
  const score = ({ full, lift }: Lift) => full + Math.min(lift, 1) / 2;
  const most = Math.max(2, Math.round((heard.reduce((sum, frame) => sum + frame, 0) * FRAME * STEP) / 50));
  const starts: Lift[] = [];
  for (const lift of lifts
    .filter((lift) => lift.lift >= 0.5 && score(lift) >= 0.6)
    .sort((a, b) => score(b) - score(a))) {
    if (starts.length === most) break;
    if (starts.every((other) => Math.abs(other.at - lift.at) >= steps(25))) starts.push(lift);
  }
  starts.sort((a, b) => a.at - b.at);

  const top = Math.max(...lifts.map((lift) => lift.full));
  const quiet = percentile(
    framed(drive).filter((_, frame) => heard[frame]),
    0.1,
  );
  const mean = means(drive);
  const peaks: Peak[] = [];
  starts.forEach(({ section: first, at }, index) => {
    const next = starts[index + 1];
    let to = first.to * FRAME;
    for (const section of sections) {
      if (section.from < first.to || section.from * FRAME - at >= steps(40)) continue;
      const fullness = full(section.from * FRAME, section.to * FRAME);
      const long = section.to - section.from >= frames(6);
      if (section === next?.section || fullness < top - 1 || (long && fullness < top - 0.6)) break;
      if (fullness >= top - 0.6) to = section.to * FRAME;
    }
    const end = Math.min(Math.max(to, at + steps(8)), at + steps(40), next?.at ?? Infinity, length);
    if (end - at < steps(4)) return;
    const strength = Math.max(0.3, clamp((mean(at, end) - quiet) / 12));
    peaks.push({ start: at * STEP, end: end * STEP, strength });
  });
  return peaks;
}

/** Per frame, the mean of `values` (at least SILENCE). */
function framed(values: Float32Array) {
  return Float32Array.from({ length: Math.floor(values.length / FRAME) }, (_, frame) => {
    let sum = 0;
    for (let step = frame * FRAME; step < (frame + 1) * FRAME; step++) sum += Math.max(SILENCE, values[step]);
    return sum / FRAME;
  });
}

/**
 * The song cut into sections where its sound changes: where its bass, mid, treble, and air, each
 * against how it varies over the song, over the 4 s after a frame are furthest from the 4 s
 * before, among its bigger changes, and the biggest within 3 s either way. With each range so at
 * every step, and how full the sound is (all four, on average).
 */
function sectionsOf(loudness: Loudness, heard: Float32Array) {
  const fullness = new Float32Array(loudness.bass.length);
  const ranges: ReturnType<typeof means>[] = [];
  const perFrame = [loudness.bass, loudness.mid, loudness.treble, loudness.air].map((values, _, all) => {
    const known = framed(values).filter((_, frame) => heard[frame]);
    const mean = known.reduce((sum, value) => sum + value, 0) / Math.max(1, known.length);
    const spread =
      Math.sqrt(known.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, known.length)) || 1;
    const against = values.map((value) => (Math.max(SILENCE, value) - mean) / spread);
    against.forEach((value, step) => (fullness[step] += value / all.length));
    ranges.push(means(against));
    return means(framed(values).map((value) => (value - mean) / spread));
  });
  const count = heard.length;
  const change = Float32Array.from({ length: count }, (_, frame) => {
    const width = Math.min(frames(4), frame, count - frame);
    if (width < 2) return 0;
    return Math.hypot(...perFrame.map((mean) => mean(frame, frame + width) - mean(frame - width, frame)));
  });
  const threshold = Math.max(0.5, percentile(change, 0.6));
  const edges = [0];
  for (let frame = 1; frame < count - 1; frame++) {
    let biggest = change[frame] >= threshold;
    const [first, last] = [Math.max(0, frame - frames(3)), Math.min(count - 1, frame + frames(3))];
    for (let other = first; biggest && other <= last; other++)
      if (change[other] > change[frame] || (change[other] === change[frame] && other < frame)) biggest = false;
    if (biggest) edges.push(frame);
  }
  edges.push(count);
  const sections = edges.slice(0, -1).map((from, index): Section => ({ from, to: edges[index + 1] }));
  return { sections, ranges, fullness };
}

/** How much higher `values` are over the second after each step than over the second before it. */
function jumps(values: Float32Array) {
  const second = steps(1);
  const at = (index: number) => values[Math.min(values.length - 1, Math.max(0, index))];
  return values.map((_, step) => {
    let change = 0;
    for (let offset = 0; offset < second; offset++) change += at(step + offset) - at(step - 1 - offset);
    return change / second;
  });
}

/**
 * Calm where the song is well below its loud parts (from 3 dB under them, fully at 12 dB), or where
 * the bass drops out and only the lighter ranges are left.
 */
function findCalm(drive: Float32Array, levels: TrackMap['levels'], audible: Float32Array, peaks: Peak[]) {
  const broad = smooth(drive, 2);
  const loud = percentile(
    broad.filter((value) => value > SILENCE),
    0.9,
  );
  const bass = smooth(levels.bass, 2);
  const calm = broad.map((value, step) =>
    audible[step] ? clamp(Math.max((loud - value - 3) / 9, 1 - bass[step] / 0.3)) : 1,
  );
  for (const { start, end } of peaks) calm.fill(0, Math.floor(start / STEP), Math.ceil(end / STEP));
  return smooth(calm, 1);
}

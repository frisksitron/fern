import { TRACK_MAP_STEP as STEP, type Peak, type TrackMap } from '$lib/shared/contracts/track-map';

/**
 * A song's score: what happens in it over time, compiled from the song's map before it plays, for
 * the effects to draw. Their shaders read it at the playback position, or at any moment before it
 * (a ripple far out from the player shows a kick from a moment ago), so a moment of the song always
 * looks the same however it is reached, like a film of the song.
 *
 * It is a table of `ROWS` rows of four numbers per `STEP`, which the GPU gets as a texture:
 *
 * 0. `bass`, `mid`, `treble`: 0 to 1, falling smoothly like a meter's needle; and `calm`, easing
 *    in and out.
 * 1. `flare`, `pulse`, `glint`: bass, mid, and treble hits ringing out; and `overflow`, swelling
 *    into each peak, as strong as it is, and ebbing after it.
 * 2. `spun`: how far bass, mid, and treble have turned, a second at a time, faster as they are
 *    louder; and `charge`, from 0 a few seconds before a peak to 1 as it comes in (0 in a peak).
 * 3. The latest kick so far (a bass hit outside calm stretches): when it started and ends, how
 *    strong it is, and how many there have been. Then the same for:
 * 4. The latest snare (a mid hit outside calm stretches, at most four a second).
 * 5. The latest peak.
 * 6. The latest hi-hat (a treble hit, at most eight a second), calm stretches too.
 */
export type Score = { peaks: readonly Peak[]; steps: number; table: Float32Array };

export const ROWS = 7;
/** Seconds before a peak that the effects wind up for it. */
const CHARGE = 2.5;
/** When something that has not happened yet happened. */
const NEVER = -1e6;

export function compileScore(map: TrackMap): Score {
  const steps = map.calm.length;
  const power = new Float32Array(steps);
  for (const peak of map.peaks) power.fill(peak.strength, Math.ceil(peak.start / STEP), Math.ceil(peak.end / STEP));

  const fall = 1 - Math.exp(-STEP / 0.15);
  const follow = (levels: Float32Array) => {
    let level = 0;
    return levels.map((target) => (level = target > level ? target : level + (target - level) * fall));
  };
  const [bass, mid, treble] = [follow(map.levels.bass), follow(map.levels.mid), follow(map.levels.treble)];
  const ease = 1 - Math.exp(-STEP / 0.6);
  let settled = map.calm[0] ?? 0;
  const calm = map.calm.map((target) => (settled += (target - settled) * ease));
  const [swell, ebb] = [1 - Math.exp(-STEP / 0.25), 1 - Math.exp(-STEP / 1.5)];
  let flooded = 0;
  const overflow = power.map((target) => (flooded += (target - flooded) * (target > flooded ? swell : ebb)));
  /** Jumps to each hit and dies away over `seconds`. */
  const ringOut = (hits: Float32Array, seconds: number) => {
    const decay = Math.exp(-STEP / seconds);
    let value = 0;
    return hits.map((hit) => (value = Math.max(value * decay, hit)));
  };
  const [flare, pulse, glint] = [
    ringOut(map.hits.bass, 0.25),
    ringOut(map.hits.mid, 0.2),
    ringOut(map.hits.treble, 0.15),
  ];

  const table = new Float32Array(steps * ROWS * 4);
  const spun = [0, 0, 0];
  // The latest of each: when it started and ends, how strong it is, and how many so far.
  let [kick, snare, peak, hat] = [
    [NEVER, NEVER, 0, 0],
    [NEVER, NEVER, 0, 0],
    [NEVER, NEVER, 0, 0],
    [NEVER, NEVER, 0, 0],
  ];
  // Each step's row is written in place: a mix hours long has hundreds of thousands of steps.
  const write = (at: number, values: ArrayLike<number>) => {
    for (let index = 0; index < values.length; index++) table[at + index] = values[index];
  };
  let next = 0;
  /** The first peak that starts after the step, for its wind-up. */
  let upcoming = 0;
  for (let step = 0; step < steps; step++) {
    const time = step * STEP;
    const spin = 1 + overflow[step] * 0.5;
    spun[0] += STEP * (1 + bass[step] * 4) * spin;
    spun[1] += STEP * (1 + mid[step] * 4) * spin;
    spun[2] += STEP * (1 + treble[step] * 4) * spin;
    // Calm stretches stay calm: no kicks or snares.
    const lively = power[step] > 0 || calm[step] <= 0.6;
    const [kicked, snared, hatted] = [map.hits.bass[step], map.hits.mid[step], map.hits.treble[step]];
    if (kicked && lively && (power[step] || bass[step] >= 0.3)) kick = [time, time, kicked, kick[3] + 1];
    if (snared && lively && time - snare[0] >= 0.25) snare = [time, time, snared, snare[3] + 1];
    if (hatted && time - hat[0] >= 0.12) hat = [time, time, hatted, hat[3] + 1];
    for (; next < map.peaks.length && map.peaks[next].start < time + STEP / 2; next++) {
      const { start, end, strength } = map.peaks[next];
      peak = [start, end, strength, peak[3] + 1];
    }
    while (upcoming < map.peaks.length && map.peaks[upcoming].start <= time) upcoming++;
    const at = step * ROWS * 4;
    write(at, [bass[step], mid[step], treble[step], calm[step]]);
    write(at + 4, [flare[step], pulse[step], glint[step], overflow[step]]);
    write(at + 8, [spun[0], spun[1], spun[2], chargeAt(map.peaks, upcoming, time)]);
    write(at + 12, kick);
    write(at + 16, snare);
    write(at + 20, peak);
    write(at + 24, hat);
  }
  return { peaks: map.peaks, steps, table };
}

/**
 * The wind-up for the peak coming in: none inside a peak, and none if the next one (`upcoming`,
 * the first to start after `time`) is more than `CHARGE` seconds away. Peaks come in order and
 * never overlap, so only the one before and the one after count.
 */
function chargeAt(peaks: readonly Peak[], upcoming: number, time: number) {
  const current = peaks[upcoming - 1];
  if (current && time < current.end) return 0;
  const until = (peaks[upcoming]?.start ?? Infinity) - time;
  return until < CHARGE ? (1 - until / CHARGE) ** 2 : 0;
}

/** How strongly the background flashes at `time`: as each peak comes in, fading fast. */
export function flashAt({ peaks }: Score, time: number) {
  const peak = peaks.findLast((peak) => peak.start <= time);
  return peak ? (0.35 + (0.6 + peak.strength * 0.4) * 0.55) * Math.exp(-(time - peak.start) / 0.25) : 0;
}

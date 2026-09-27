import { describe, expect, it } from 'vitest';
import { PlayCounter, playThresholdMs } from '../../src/lib/music/plays';

/**
 * Plays from `fromMs` to `toMs`, reporting the playhead every `stepMs` as `timeupdate` does, with
 * the clock advancing in step. Returns how many plays counted.
 */
function listen(
  counter: PlayCounter,
  clock: { ms: number },
  fromMs: number,
  toMs: number,
  durationMs: number | null,
  stepMs = 250,
) {
  let plays = 0;
  for (let position = fromMs; position <= toMs; position += stepMs) {
    if (counter.advance(position, clock.ms, durationMs)) plays++;
    clock.ms += stepMs;
  }
  clock.ms -= stepMs;
  return plays;
}

describe('play counting', () => {
  it('needs half a song or four minutes of it, and ignores songs under 30 seconds', () => {
    expect(playThresholdMs(29_999)).toBeNull();
    expect(playThresholdMs(null)).toBeNull();
    expect(playThresholdMs(30_000)).toBe(15_000);
    expect(playThresholdMs(200_000)).toBe(100_000);
    expect(playThresholdMs(20 * 60_000)).toBe(240_000);
  });

  it('counts once, on the update that reaches the threshold', () => {
    const counter = new PlayCounter();
    const clock = { ms: 0 };
    expect(listen(counter, clock, 0, 99_750, 200_000)).toBe(0);
    clock.ms += 250;
    expect(counter.advance(100_000, clock.ms, 200_000)).toBe(true);
    clock.ms += 250;
    expect(listen(counter, clock, 100_250, 200_000, 200_000)).toBe(0);
  });

  it('counts listening in a background tab, where updates arrive seconds apart', () => {
    const counter = new PlayCounter();
    expect(listen(counter, { ms: 5_000 }, 0, 100_000, 200_000, 10_000)).toBe(1);
  });

  it('does not count seeking toward the end as listening', () => {
    const counter = new PlayCounter();
    const clock = { ms: 0 };
    expect(listen(counter, clock, 0, 10_000, 200_000)).toBe(0);
    // A jump without an interruption (as if `seeking` never fired) adds only the time that passed.
    clock.ms += 250;
    expect(listen(counter, clock, 190_000, 200_000, 200_000)).toBe(0);
    counter.interrupt();
    clock.ms += 250;
    expect(listen(counter, clock, 100_000, 179_000, 200_000)).toBe(0);
    clock.ms += 250;
    expect(listen(counter, clock, 179_250, 181_000, 200_000)).toBe(1);
  });

  it('does not count a stalled playhead while the clock runs', () => {
    const counter = new PlayCounter();
    const clock = { ms: 0 };
    for (let tick = 0; tick < 1_000; tick++, clock.ms += 250) {
      expect(counter.advance(10_000, clock.ms, 200_000)).toBe(false);
    }
  });

  it('allows for a faster playback rate, and only that much', () => {
    const counter = new PlayCounter();
    let plays = 0;
    // At double speed, the playhead moves 500 ms for every 250 ms of the clock.
    for (let clock = 0, position = 0; position <= 100_000; clock += 250, position += 500) {
      if (counter.advance(position, clock, 200_000, 2)) plays++;
    }
    expect(plays).toBe(1);
  });

  it('adds listening across pauses, and counts again after starting over', () => {
    const counter = new PlayCounter();
    const clock = { ms: 0 };
    listen(counter, clock, 0, 50_000, 200_000);
    counter.interrupt();
    clock.ms += 60_000;
    expect(listen(counter, clock, 50_000, 100_250, 200_000)).toBe(1);
    counter.reset();
    clock.ms += 250;
    expect(listen(counter, clock, 0, 100_000, 200_000)).toBe(1);
  });

  it('never counts a song too short to count', () => {
    const counter = new PlayCounter();
    expect(listen(counter, { ms: 0 }, 0, 20_000, 20_000)).toBe(0);
  });
});

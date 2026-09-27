import { get } from 'svelte/store';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  musicPlayer,
  nextTrack,
  playMusic,
  previousTrack,
  rememberMusicPosition,
  setMusicPlaying,
  toggleMusicPlayback,
} from '../../src/lib/client/music-player';
import type { MediaEntry } from '../../src/lib/zero/schema';

const track = (id: string) => ({ id, name: `${id}.flac` }) as MediaEntry;
const queue = [track('a'), track('b'), track('c')];
const state = () => get(musicPlayer);

beforeEach(() => {
  playMusic(queue, queue[1]);
  setMusicPlaying(true);
});

describe('music player', () => {
  it('leaves the playing flag to the audio element when a track is played again', () => {
    const request = state().playRequest;
    playMusic(queue, queue[1]);
    expect(state()).toMatchObject({ index: 1, position: 0, playRequest: request + 1, playing: true });
  });

  it('goes back a track early in a track, and starts the track over later on', () => {
    rememberMusicPosition(2);
    previousTrack();
    expect(state()).toMatchObject({ index: 0, position: 0 });

    playMusic(queue, queue[1]);
    rememberMusicPosition(42);
    previousTrack();
    expect(state()).toMatchObject({ index: 1, position: 0 });
  });

  it('starts the first track over instead of doing nothing', () => {
    playMusic(queue, queue[0]);
    const request = state().playRequest;
    previousTrack();
    expect(state()).toMatchObject({ index: 0, position: 0, playRequest: request + 1 });
  });

  it('stops after the last track unless it loops', () => {
    playMusic(queue, queue[2]);
    nextTrack();
    expect(state().index).toBe(2);
    playMusic(queue, queue[2], { loop: true });
    nextTrack();
    expect(state().index).toBe(0);
  });

  it('asks the player to pause or resume', () => {
    const request = state().toggleRequest;
    toggleMusicPlayback();
    expect(state().toggleRequest).toBe(request + 1);
  });
});

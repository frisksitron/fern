import { derived, writable } from 'svelte/store';
import type { MediaEntry } from '$lib/zero/schema';

type MusicPlayerState = {
  sourceQueue: readonly MediaEntry[];
  queue: readonly MediaEntry[];
  index: number;
  /** Counts requests to play the current track from `position`; the player acts on each new one. */
  playRequest: number;
  /** Counts requests to pause or resume; the player acts on each new one. */
  toggleRequest: number;
  /** Whether the audio plays. Only the player's audio element sets it, from its own events. */
  playing: boolean;
  playlistId: string | null;
  sourceHref: string | null;
  position: number;
  loop: boolean;
  shuffle: boolean;
};

export const musicPlayer = writable<MusicPlayerState>({
  sourceQueue: [],
  queue: [],
  index: -1,
  playRequest: 0,
  toggleRequest: 0,
  playing: false,
  playlistId: null,
  sourceHref: null,
  position: 0,
  loop: false,
  shuffle: false,
});

export const currentMusicTrackId = derived(musicPlayer, (state) => state.queue[state.index]?.id ?? null);
export const currentMusicPlaylistId = derived(musicPlayer, (state) => state.playlistId);
export const isMusicPlaying = derived(musicPlayer, (state) => state.playing);

function shuffled(queue: readonly MediaEntry[], firstTrackId?: string) {
  const result = [...queue];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  if (firstTrackId && result.length > 1 && result[0]?.id === firstTrackId) {
    const other = result.findIndex((track) => track.id !== firstTrackId);
    [result[0], result[other]] = [result[other], result[0]];
  }
  return result;
}

function shuffledFrom(queue: readonly MediaEntry[], track: MediaEntry) {
  return [track, ...shuffled(queue.filter((item) => item.id !== track.id))];
}

export function playMusic(
  queue: readonly MediaEntry[],
  track: MediaEntry,
  options: { loop?: boolean; playlistId?: string; sourceHref?: string } = {},
) {
  musicPlayer.update((state) => {
    const playbackQueue = state.shuffle ? shuffledFrom(queue, track) : queue;
    return {
      sourceQueue: queue,
      queue: playbackQueue,
      index: state.shuffle ? 0 : playbackQueue.findIndex((item) => item.id === track.id),
      playRequest: state.playRequest + 1,
      toggleRequest: state.toggleRequest,
      playing: state.playing,
      playlistId: options.playlistId ?? null,
      sourceHref: options.sourceHref ?? null,
      position: 0,
      loop: options.loop ?? false,
      shuffle: state.shuffle,
    };
  });
}

export function nextTrack() {
  musicPlayer.update((state) => {
    if (state.index < state.queue.length - 1) {
      return { ...state, index: state.index + 1, playRequest: state.playRequest + 1, position: 0 };
    }
    if (!state.loop || !state.queue.length) return state;
    const queue = state.shuffle ? shuffled(state.sourceQueue, state.queue[state.index]?.id) : state.sourceQueue;
    return { ...state, queue, index: 0, playRequest: state.playRequest + 1, position: 0 };
  });
}

/** Seconds into a track after which "previous" starts it over rather than going back. */
const RESTART_AFTER_SECONDS = 3;

/** Goes back a track, or starts the current one over once it has played a few seconds (or is first). */
export function previousTrack() {
  musicPlayer.update((state) => {
    const index = state.position > RESTART_AFTER_SECONDS || state.index <= 0 ? state.index : state.index - 1;
    return { ...state, index, playRequest: state.playRequest + 1, position: 0 };
  });
}

/** Pauses or resumes the current track. */
export function toggleMusicPlayback() {
  musicPlayer.update((state) => ({ ...state, toggleRequest: state.toggleRequest + 1 }));
}

export function toggleShuffle() {
  musicPlayer.update((state) => {
    const current = state.queue[state.index];
    if (!current) return { ...state, shuffle: !state.shuffle };
    if (state.shuffle) {
      return {
        ...state,
        queue: state.sourceQueue,
        index: state.sourceQueue.findIndex((track) => track.id === current.id),
        shuffle: false,
      };
    }
    return { ...state, queue: shuffledFrom(state.sourceQueue, current), index: 0, shuffle: true };
  });
}

/**
 * Follows a reordered playlist while it plays: the next track is the one after the current track in
 * the new order. A shuffled queue keeps its shuffle and picks up the new order when shuffle ends.
 */
export function reorderMusicQueue(playlistId: string, trackIds: readonly string[]) {
  musicPlayer.update((state) => {
    if (state.playlistId !== playlistId) return state;
    const rank = new Map(trackIds.map((id, index) => [id, index]));
    const sourceQueue = [...state.sourceQueue].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    );
    if (state.shuffle) return { ...state, sourceQueue };
    const current = state.queue[state.index];
    return {
      ...state,
      sourceQueue,
      queue: sourceQueue,
      index: current ? sourceQueue.findIndex((track) => track.id === current.id) : state.index,
    };
  });
}

export function setMusicPlaying(playing: boolean) {
  musicPlayer.update((state) => ({ ...state, playing }));
}

export function rememberMusicPosition(position: number) {
  musicPlayer.update((state) => ({ ...state, position }));
}

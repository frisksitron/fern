import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WatchController,
  type HlsFailure,
  type HlsPlayer,
  type MediaElement,
  type WatchData,
} from '../../src/lib/client/playback/watch-controller.svelte';
import type { MediaEntry, PlaybackProgress } from '../../src/lib/client/zero/data';

const rootId = '20000000-0000-4000-8000-000000000001';

function entry(id: string, name: string): MediaEntry {
  return {
    id,
    name,
    mediaRootId: rootId,
    parentId: null,
    kind: 'file',
    isVideo: true,
    isAudio: false,
    durationMs: 120_000,
    sortOrder: null,
  } as unknown as MediaEntry;
}

const current = entry('30000000-0000-4000-8000-000000000001', 'Episode 1.mp4');
const next = entry('30000000-0000-4000-8000-000000000002', 'Episode 2.mp4');

/** A media element that plays nothing: tests load, play, and seek it by hand. */
class FakeVideo extends EventTarget implements MediaElement {
  duration = Number.NaN;
  paused = true;
  readyState = 0;
  seekable = { length: 0, end: (_index: number) => 0 };
  textTracks: { mode: TextTrackMode }[] = [];
  src = '';
  nativeHls = false;
  error: { code: number } | null = null;
  seeks: number[] = [];
  listeners = 0;
  #currentTime = 0;

  get currentTime() {
    return this.#currentTime;
  }

  /** A seek by the controller; the fake finishes it on the next microtask. */
  set currentTime(seconds: number) {
    this.#currentTime = seconds;
    this.seeks.push(seconds);
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }

  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  /** Codecs this browser lacks, as `canPlayType` strings (a desktop browser lacks none). */
  missingCodecs: string[] = [];

  canPlayType(type: string) {
    if (type === 'application/vnd.apple.mpegurl') return this.nativeHls ? 'maybe' : '';
    return this.missingCodecs.some((codec) => type.includes(codec)) ? '' : 'probably';
  }

  /** The source's metadata arrived. */
  loaded(durationSeconds: number) {
    this.duration = durationSeconds;
    this.seekable = { length: 1, end: () => durationSeconds };
    this.readyState = 4;
    this.dispatchEvent(new Event('loadedmetadata'));
  }

  /** Playback reached `seconds`. */
  playTo(seconds: number) {
    this.#currentTime = seconds;
    this.dispatchEvent(new Event('timeupdate'));
  }

  override addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners++;
    super.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners--;
    super.removeEventListener(type, listener);
  }
}

class FakeHls implements HlsPlayer<FakeVideo> {
  url = '';
  media: FakeVideo | null = null;
  destroyed = false;
  recoveries = 0;
  #errorListener: (failure: HlsFailure) => void = () => undefined;
  loadSource(url: string) {
    this.url = url;
  }
  attachMedia(element: FakeVideo) {
    this.media = element;
  }
  onError(listener: (failure: HlsFailure) => void) {
    this.#errorListener = listener;
  }
  recoverMediaError() {
    this.recoveries++;
  }
  destroy() {
    this.destroyed = true;
  }
  fail(failure: Partial<HlsFailure>) {
    this.#errorListener({ fatal: true, kind: 'other', status: null, ...failure });
  }
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function directPlan(overrides: Record<string, unknown> = {}) {
  return Response.json({
    mode: 'direct',
    url: `/stream/${current.id}`,
    durationMs: 120_000,
    audioTracks: [],
    subtitleTracks: [],
    ...overrides,
  });
}

function setup(options: { progress?: Partial<PlaybackProgress>; routes?: Record<string, Route> } = {}) {
  const video = new FakeVideo();
  const hls: FakeHls[] = [];
  const saves: Parameters<WatchData['savePlaybackProgress']>[0][] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const navigations: string[] = [];
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  let watchers = 0;
  const watch = () => {
    watchers++;
    return () => void watchers--;
  };
  const routes: Record<string, Route> = {
    [`/api/playback/${current.id}/plan`]: () => directPlan(),
    [`/api/playback/${current.id}/session`]: () =>
      Response.json({ sessionId: 'a'.repeat(64), manifestUrl: `/hls/${'a'.repeat(64)}/master.m3u8` }),
    ...options.routes,
  };
  const controller = new WatchController<FakeVideo>(current.id, {
    profileId: 'profile-1',
    data: {
      loadMediaEntry: async () => current,
      watchMediaEntry: watch,
      loadChildren: async () => [next, current],
      watchChildren: watch,
      loadProgress: async () => (options.progress ? ({ ...options.progress } as PlaybackProgress) : undefined),
      watchProgress: watch,
      savePlaybackProgress: async (input) => void saves.push(input),
    },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return routes[url](init);
    },
    createHls: async () => {
      const player = new FakeHls();
      hls.push(player);
      return player;
    },
    navigate: async (url) => void navigations.push(url),
    document: page as unknown as Document,
  });
  return {
    controller,
    video,
    hls,
    saves,
    requests,
    navigations,
    page,
    watchers: () => watchers,
  };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean) {
  for (let turn = 0; turn < 100 && !condition(); turn++) await settle();
  expect(condition()).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WatchController', () => {
  it('plays a direct plan and resumes unwatched saved progress', async () => {
    const { controller, video } = setup({ progress: { positionMs: 30_000, watched: false } });
    const started = controller.start(video);
    await waitFor(() => video.src !== '');
    expect(video.src).toBe(`/stream/${current.id}`);
    expect(controller.loading).toBe(true);
    video.loaded(120);
    await started;
    expect(video.seeks).toEqual([30]);
    expect(controller.loading).toBe(false);
    expect(controller.entry?.name).toBe('Episode 1.mp4');
    expect(controller.nextEntry?.id).toBe(next.id);
    expect(controller.plan?.mode).toBe('direct');
  });

  it('starts from the beginning when saved progress is watched or barely started', async () => {
    for (const progress of [
      { positionMs: 30_000, watched: true },
      { positionMs: 500, watched: false },
    ]) {
      const { controller, video } = setup({ progress });
      await controller.start(video);
      expect(video.seeks).toEqual([]);
      controller.destroy();
    }
  });

  it('switches audio through an HLS session and keeps the position', async () => {
    const { controller, video, hls, requests } = setup();
    await controller.start(video);
    video.playTo(42);

    controller.chooseAudio(2);
    await waitFor(() => hls.length === 1);
    expect(hls[0]).toMatchObject({ url: `/hls/${'a'.repeat(64)}/master.m3u8`, media: video });
    const session = requests.find((request) => request.url.endsWith('/session'));
    expect(JSON.parse(String(session?.init?.body))).toEqual({ audioStream: 2 });

    video.loaded(120);
    await waitFor(() => !controller.loading);
    expect(video.seeks).toEqual([42]);
    expect(controller.selectedAudio).toBe(2);

    controller.chooseAudio(2);
    expect(requests.filter((request) => request.url.endsWith('/session'))).toHaveLength(1);
  });

  it('plays HLS natively when the browser supports it', async () => {
    const { controller, video, hls } = setup({
      routes: {
        [`/api/playback/${current.id}/plan`]: () =>
          Response.json({
            mode: 'hls',
            sessionUrl: `/api/playback/${current.id}/session`,
            durationMs: null,
            audioTracks: [],
            subtitleTracks: [],
          }),
      },
    });
    video.nativeHls = true;
    await controller.start(video);
    expect(video.src).toBe(`/hls/${'a'.repeat(64)}/master.m3u8`);
    expect(hls).toEqual([]);
  });

  it('asks for HLS in place of WebM the browser cannot play as-is (Safari has no Vorbis)', async () => {
    const plan = `/api/playback/${current.id}/plan?webm=false`;
    const { controller, video, requests } = setup({ routes: { [plan]: () => directPlan() } });
    video.missingCodecs = ['vorbis'];
    const started = controller.start(video);
    await waitFor(() => video.src !== '');
    video.loaded(120);
    await started;
    expect(requests.map((request) => request.url)).toContain(plan);
  });

  it('shows the server’s message for failed requests and the reason for unplayable media', async () => {
    const missing = setup({
      routes: {
        [`/api/playback/${current.id}/plan`]: () =>
          Response.json({ code: 'media.not_found', message: 'That media no longer exists.' }, { status: 404 }),
      },
    });
    await missing.controller.start(missing.video);
    expect(missing.controller).toMatchObject({ error: 'That media no longer exists.', loading: false });

    const unplayable = setup({
      routes: {
        [`/api/playback/${current.id}/plan`]: () =>
          Response.json({ mode: 'unplayable', reason: 'This file has no video or audio stream.' }),
      },
    });
    await unplayable.controller.start(unplayable.video);
    expect(unplayable.controller.error).toBe('This file has no video or audio stream.');

    const malformed = setup({ routes: { [`/api/playback/${current.id}/plan`]: () => Response.json({ mode: 'x' }) } });
    await malformed.controller.start(malformed.video);
    expect(malformed.controller.error).toBe('Playback failed');
  });

  describe('errors', () => {
    /** Starts an HLS session (an audio switch) and lands its resume seek, leaving it playing at `seconds`. */
    async function playingHls(seconds: number) {
      const context = setup();
      await context.controller.start(context.video);
      context.video.playTo(seconds);
      context.controller.chooseAudio(1);
      await waitFor(() => context.hls.length === 1);
      context.video.loaded(120);
      await waitFor(() => !context.controller.loading);
      return context;
    }

    it('ignores non-fatal hls.js errors', async () => {
      const { controller, hls } = await playingHls(30);
      hls[0].fail({ fatal: false, kind: 'network', status: 404 });
      expect(controller.error).toBe('');
      expect(hls[0].recoveries).toBe(0);
    });

    it('recovers a fatal media error once, then shows an error', async () => {
      const { controller, hls } = await playingHls(30);
      hls[0].fail({ kind: 'media' });
      expect(hls[0].recoveries).toBe(1);
      expect(controller.error).toBe('');

      hls[0].fail({ kind: 'media' });
      expect(controller).toMatchObject({ error: 'This video could not be played in this browser.', loading: false });
      expect(hls[0].destroyed).toBe(true);

      // Playback that moves on earns another recovery.
      const next = await playingHls(30);
      next.hls[0].fail({ kind: 'media' });
      next.video.playTo(45);
      next.hls[0].fail({ kind: 'media' });
      expect(next.hls[0].recoveries).toBe(2);
    });

    it('starts a new session at the current position when the session is gone, once', async () => {
      const { controller, hls, video, requests } = await playingHls(42);
      video.seeks.length = 0;
      hls[0].fail({ kind: 'network', status: 404 });
      await waitFor(() => hls.length === 2);
      expect(requests.filter((request) => request.url.endsWith('/session'))).toHaveLength(2);
      video.loaded(120);
      await waitFor(() => !controller.loading);
      expect(video.seeks).toEqual([42]);
      expect(controller.error).toBe('');
      expect(hls[0].destroyed).toBe(true);

      hls[1].fail({ kind: 'network', status: 409 });
      expect(controller).toMatchObject({ error: 'The video could not be loaded from the server.', loading: false });
      expect(requests.filter((request) => request.url.endsWith('/session'))).toHaveLength(2);
    });

    it('shows other fatal network and hls.js errors without retrying', async () => {
      const { controller, hls } = await playingHls(30);
      hls[0].fail({ kind: 'network', status: 500 });
      expect(controller.error).toBe('The video could not be loaded from the server.');
      expect(hls).toHaveLength(1);
    });

    it('shows an error when the media element fails, and retries from the current position', async () => {
      const { controller, video, requests } = setup();
      const started = controller.start(video);
      await waitFor(() => video.src !== '');
      video.loaded(120);
      await started;
      video.playTo(20);
      video.error = { code: 4 };
      video.dispatchEvent(new Event('error'));
      expect(controller).toMatchObject({ error: 'This video could not be played in this browser.', loading: false });

      video.seeks.length = 0;
      controller.retry();
      expect(controller.error).toBe('');
      await waitFor(() => requests.filter((request) => request.url.endsWith('/plan')).length === 2);
      await settle();
      video.loaded(120);
      await waitFor(() => !controller.loading);
      expect(video.seeks).toEqual([20]);
    });

    it('starts a new session when a natively played HLS session fails, once', async () => {
      const { controller, video, requests } = setup({
        routes: {
          [`/api/playback/${current.id}/plan`]: () =>
            Response.json({
              mode: 'hls',
              sessionUrl: `/api/playback/${current.id}/session`,
              durationMs: null,
              audioTracks: [],
              subtitleTracks: [],
            }),
        },
      });
      video.nativeHls = true;
      await controller.start(video);
      video.playTo(42);
      video.seeks.length = 0;

      video.dispatchEvent(new Event('error'));
      expect(controller.error).toBe('');
      await waitFor(() => requests.filter((request) => request.url.endsWith('/session')).length === 2);
      await settle();
      video.loaded(120);
      await waitFor(() => !controller.loading);
      expect(video.seeks).toEqual([42]);
      expect(controller.error).toBe('');

      video.error = { code: 4 };
      video.dispatchEvent(new Event('error'));
      expect(controller).toMatchObject({ error: 'This video could not be played in this browser.', loading: false });
      expect(requests.filter((request) => request.url.endsWith('/session'))).toHaveLength(2);
    });

    it('does not leave progress saving paused after a failure while switching source', async () => {
      const { controller, video, saves } = setup({
        routes: { [`/api/playback/${current.id}/session`]: () => Response.json({ message: 'Busy' }, { status: 503 }) },
      });
      await controller.start(video);
      video.playTo(5);
      controller.chooseAudio(1);
      await waitFor(() => controller.error !== '');
      const count = saves.length;
      video.pause();
      expect(saves).toHaveLength(count + 1);
    });
  });

  describe('progress', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    it('saves once playback starts, while playing, on pause, and when the page is hidden', async () => {
      const { controller, video, saves, page } = setup();
      await controller.start(video);
      video.playTo(0.5);
      expect(saves).toHaveLength(0);
      video.playTo(5);
      expect(saves.at(-1)).toMatchObject({ mediaEntryId: current.id, positionMs: 5_000, durationMs: 120_000 });

      video.playTo(15);
      vi.advanceTimersByTime(10_000);
      expect(saves.at(-1)).toMatchObject({ positionMs: 15_000 });

      video.playTo(20);
      video.pause();
      expect(saves.at(-1)).toMatchObject({ positionMs: 20_000 });
      const count = saves.length;
      vi.advanceTimersByTime(10_000);
      expect(saves).toHaveLength(count);

      page.visibilityState = 'hidden';
      page.dispatchEvent(new Event('visibilitychange'));
      expect(saves).toHaveLength(count + 1);
    });

    it('does not save position 0 while the resume seek is pending, even when the viewer leaves', async () => {
      const { controller, video, saves } = setup({ progress: { positionMs: 30_000, watched: false } });
      const started = controller.start(video);
      await waitFor(() => video.src !== '');
      expect(video.paused).toBe(false);
      video.pause();
      controller.destroy();
      await started;
      expect(saves).toEqual([]);
    });

    it('marks the media watched when it ends or the viewer skips to the next one', async () => {
      const { controller, video, saves, navigations } = setup();
      await controller.start(video);
      video.playTo(119);
      video.dispatchEvent(new Event('ended'));
      expect(saves.at(-1)).toMatchObject({ positionMs: 119_000, watched: true });

      await controller.skipToNext();
      expect(saves.at(-1)).toMatchObject({ watched: true });
      expect(navigations).toEqual([`/watch/${next.id}`]);
      expect(controller.skipping).toBe(true);
    });
  });

  it('shows one text subtitle at a time and lists only subtitles the browser can render', async () => {
    const subtitle = (streamIndex: number, codec: string) => ({
      streamIndex,
      kind: 'subtitle',
      codec,
      language: 'eng',
      title: null,
      isDefault: false,
      isForced: false,
      channels: null,
      channelLayout: null,
      bitrate: null,
      sampleRate: null,
      bitDepth: null,
      width: null,
      height: null,
    });
    const { controller, video } = setup({
      routes: {
        [`/api/playback/${current.id}/plan`]: () =>
          directPlan({ subtitleTracks: [subtitle(2, 'subrip'), subtitle(3, 'hdmv_pgs_subtitle'), subtitle(4, 'ass')] }),
      },
    });
    await controller.start(video);
    expect(controller.textSubtitleTracks.map((track) => ('streamIndex' in track ? track.streamIndex : null))).toEqual([
      2, 4,
    ]);
    video.textTracks = [{ mode: 'disabled' }, { mode: 'disabled' }];
    controller.chooseSubtitle(1);
    expect(video.textTracks.map((track) => track.mode)).toEqual(['disabled', 'showing']);
    controller.chooseSubtitle(null);
    expect(video.textTracks.map((track) => track.mode)).toEqual(['disabled', 'disabled']);
  });

  it('releases listeners, subscriptions, timers, and HLS on destroy, and saves one last time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { controller, video, hls, saves, watchers, page } = setup();
    await controller.start(video);
    controller.chooseAudio(1);
    await waitFor(() => hls.length === 1);
    video.loaded(120);
    await waitFor(() => !controller.loading);
    video.playTo(30);
    const saved = saves.length;
    expect(watchers()).toBe(3);

    controller.destroy();
    expect(saves).toHaveLength(saved + 1);
    expect(watchers()).toBe(0);
    expect(video.listeners).toBe(0);
    expect(hls[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(saves).toHaveLength(saved + 1);
  });

  it('abandons requests and subscribes to nothing when destroyed while loading', async () => {
    let aborted = false;
    const { controller, video, watchers } = setup({
      routes: {
        [`/api/playback/${current.id}/plan`]: (init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            }),
          ),
      },
    });
    const started = controller.start(video);
    await waitFor(() => watchers() === 3);
    controller.destroy();
    await started;
    expect(aborted).toBe(true);
    expect(controller.error).toBe('');
    expect(watchers()).toBe(0);
    expect(video.listeners).toBe(0);
  });
});

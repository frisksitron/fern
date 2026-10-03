import { Schema } from 'effect';
import type { MediaEntry, PlaybackProgress, QueryListener } from '$lib/client/zero/data';
import { readApiError } from '$lib/shared/contracts/api-error';
import { HlsSession, PlaybackPlan, type SubtitleTrack } from '$lib/shared/contracts/playback';
import { hasResumableProgress } from '$lib/shared/playback-state';
import { sortEntries } from '$lib/shared/sorting';

/** A plan the player can use. */
type PlayablePlan = Exclude<PlaybackPlan, { mode: 'unplayable' }>;

/** The parts of `HTMLVideoElement` the controller uses, so tests can supply a fake. */
export interface MediaElement {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly readyState: number;
  readonly seekable: { readonly length: number; end(index: number): number };
  readonly error?: { readonly code: number } | null;
  readonly textTracks: { readonly length: number; readonly [index: number]: { mode: TextTrackMode } };
  src: string;
  play(): Promise<void>;
  canPlayType(type: string): string;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** An hls.js error, reduced to what the controller decides on. */
export interface HlsFailure {
  /** hls.js retries what is not fatal on its own. */
  readonly fatal: boolean;
  readonly kind: 'network' | 'media' | 'other';
  /** The HTTP status of the failed request, when there was a response. */
  readonly status: number | null;
}

/** The parts of hls.js the controller uses. */
export interface HlsPlayer<Element extends MediaElement = MediaElement> {
  loadSource(url: string): void;
  attachMedia(element: Element): void;
  onError(listener: (failure: HlsFailure) => void): void;
  recoverMediaError(): void;
  destroy(): void;
}

/** Zero reads and writes for one media entry. */
export interface WatchData {
  loadMediaEntry(id: string): Promise<MediaEntry | undefined>;
  watchMediaEntry(id: string, listener: QueryListener<MediaEntry | undefined>): () => void;
  loadChildren(rootId: string, parentId: string | null): Promise<readonly MediaEntry[]>;
  watchChildren(rootId: string, parentId: string | null, listener: QueryListener<readonly MediaEntry[]>): () => void;
  loadProgress(profileId: string, mediaEntryId: string): Promise<PlaybackProgress | undefined>;
  watchProgress(
    profileId: string,
    mediaEntryId: string,
    listener: QueryListener<PlaybackProgress | undefined>,
  ): () => void;
  savePlaybackProgress(input: {
    profileId: string;
    mediaEntryId: string;
    positionMs: number;
    durationMs: number | null;
    watched?: boolean;
  }): Promise<unknown>;
}

/** The page's environment: the browser in production, fakes in tests. */
interface WatchDependencies<Element extends MediaElement = MediaElement> {
  readonly data: WatchData;
  readonly profileId: string;
  readonly fetch: typeof fetch;
  readonly createHls: () => Promise<HlsPlayer<Element>>;
  readonly navigate: (url: string) => Promise<void>;
  /** Saving on `visibilitychange` keeps progress when the tab is hidden or closed. */
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

/** How often progress is saved while media plays. */
const PROGRESS_SAVE_INTERVAL_MS = 10_000;

/**
 * Playback that gets this far past an automatic recovery has earned another one. Without the limit
 * a session that fails right after starting would restart forever.
 */
const RECOVERY_RESET_SECONDS = 10;

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
const textSubtitleCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
const decodePlan = Schema.decodeUnknownSync(PlaybackPlan);
const decodeSession = Schema.decodeUnknownSync(HlsSession);

/** What the viewer sees for an unrecoverable hls.js error. */
const hlsFailureMessages = {
  network: 'The video could not be loaded from the server.',
  media: 'This video could not be played in this browser.',
  other: 'Playback failed.',
} as const;

/** What the viewer sees when the media element itself reports an error (`MediaError.code`). */
function mediaErrorMessage(code: number | undefined) {
  if (code === 2) return 'The connection to the server was lost.';
  if (code === 3 || code === 4) return 'This video could not be played in this browser.';
  return 'Playback failed.';
}

/**
 * The plan query opting out of what this browser cannot play as-is, so the server sends HLS
 * instead: Safari has no Vorbis and most iPhones no AV1. Being cautious only costs a transcode.
 */
function capabilityQuery(video: MediaElement) {
  const can = (type: string) => video.canPlayType(type) !== '';
  const params = new URLSearchParams();
  if (!can('video/mp4; codecs="avc1.42E01E"')) params.set('h264', 'false');
  if (!can('audio/mp4; codecs="mp4a.40.2"')) params.set('aac', 'false');
  if (!['vp8, vorbis', 'vp9, opus', 'av01.0.05M.08, opus'].every((codecs) => can(`video/webm; codecs="${codecs}"`)))
    params.set('webm', 'false');
  return params.size ? `?${params}` : '';
}

/** Subtitles the browser can render as a text track. */
function isTextSubtitle(track: SubtitleTrack) {
  return track.kind === 'external' || textSubtitleCodecs.includes(track.codec);
}

export function subtitleLabel(track: SubtitleTrack) {
  return track.kind === 'external' ? track.name : (track.title ?? track.language ?? track.codec);
}

export function subtitleUrl(mediaId: string, track: SubtitleTrack) {
  return track.kind === 'external'
    ? `/api/subtitles/${track.id}`
    : `/api/media/${mediaId}/subtitles/${track.streamIndex}`;
}

/** The next video in the folder after `entry`, in display order. */
export function nextVideo(entry: MediaEntry, siblings: readonly MediaEntry[]) {
  const videos = sortEntries(siblings.filter((sibling) => sibling.kind === 'file' && sibling.isVideo));
  const index = videos.findIndex((sibling) => sibling.id === entry.id);
  return index < 0 ? null : (videos[index + 1] ?? null);
}

/** A failure whose message is meant for the viewer. */
class PlaybackError extends Error {}

/**
 * Playback for one media entry on the watch page: loads the entry and plan, attaches direct or HLS
 * playback, resumes saved progress, switches audio and subtitle tracks, and saves progress. The
 * page renders its state and forwards user choices. Everything it starts — requests, HLS, media
 * element listeners, timers, and Zero subscriptions — ends in `destroy()`.
 */
export class WatchController<Element extends MediaElement = MediaElement> {
  entry = $state<MediaEntry | null>(null);
  nextEntry = $state<MediaEntry | null>(null);
  plan = $state<PlayablePlan | null>(null);
  error = $state('');
  loading = $state(true);
  /** The chosen audio stream, or null for the file's default. */
  selectedAudio = $state<number | null>(null);
  /** The shown text subtitle, as an index into `textSubtitleTracks`, or null for none. */
  selectedSubtitle = $state<number | null>(null);
  skipping = $state(false);

  readonly #mediaId: string;
  readonly #deps: WatchDependencies<Element>;
  /** Aborted on `destroy()`; everything the controller starts checks it after each await. */
  readonly #lifetime = new AbortController();
  /** The current plan and session requests; replaced when the source changes. */
  #requests: AbortController | null = null;
  #video: Element | null = null;
  #hls: HlsPlayer<Element> | null = null;
  #saved: PlaybackProgress | null = null;
  #pendingResumeMs: number | null = null;
  #cancelResume: (() => void) | null = null;
  #resumePlaybackAfterAttach = true;
  #changingSource = false;
  #usingHls = false;
  /** Where playback was when an automatic recovery ran, until playback moves well past it. */
  #recoveredAt: number | null = null;
  #hasPlaybackStarted = false;
  #hasSavedProgress = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #cleanups: (() => void)[] = [];

  constructor(mediaId: string, deps: WatchDependencies<Element>) {
    this.#mediaId = mediaId;
    this.#deps = deps;
  }

  get textSubtitleTracks(): readonly SubtitleTrack[] {
    return this.plan?.subtitleTracks.filter(isTextSubtitle) ?? [];
  }

  get #destroyed() {
    return this.#lifetime.signal.aborted;
  }

  /** Loads the entry, its folder, and saved progress, then starts playback on `video`. */
  async start(video: Element) {
    this.#video = video;
    this.#listen(video, 'play', () => (this.#hasPlaybackStarted = true));
    this.#listen(video, 'error', () => {
      // hls.js reports its own element errors, with a way to recover.
      if (this.#hls) return;
      // A natively played HLS session reports a gone session or segment only as this error, with no status.
      if (this.#usingHls && this.#recoveredAt === null) this.#restartSession(video);
      else this.#fail(mediaErrorMessage(video.error?.code));
    });
    this.#listen(video, 'timeupdate', () => {
      if (this.#recoveredAt !== null && video.currentTime > this.#recoveredAt + RECOVERY_RESET_SECONDS)
        this.#recoveredAt = null;
      if (this.#hasSavedProgress || this.#cancelResume || video.currentTime < 1) return;
      this.#hasSavedProgress = true;
      void this.save();
    });
    this.#listen(video, 'pause', () => void this.save());
    this.#listen(video, 'seeked', () => void this.save());
    this.#listen(video, 'ended', () => void this.save(true));

    const entry = await this.#deps.data.loadMediaEntry(this.#mediaId);
    if (this.#destroyed) return;
    if (!entry) {
      this.error = 'This media is no longer available.';
      this.loading = false;
      return;
    }
    this.entry = entry;
    this.#cleanups.push(
      this.#deps.data.watchMediaEntry(entry.id, (data, resultType, queryError) => {
        if (data) this.entry = data;
        if (!data && resultType === 'complete') this.error = 'This media is no longer available.';
        if (resultType === 'error') this.error = queryError?.message ?? 'Could not synchronize this media.';
      }),
    );

    const siblings = await this.#deps.data.loadChildren(entry.mediaRootId, entry.parentId);
    if (this.#destroyed) return;
    this.nextEntry = nextVideo(entry, siblings);
    this.#cleanups.push(
      this.#deps.data.watchChildren(entry.mediaRootId, entry.parentId, (data, resultType, queryError) => {
        if (this.entry) this.nextEntry = nextVideo(this.entry, data);
        if (resultType === 'error') this.error = queryError?.message ?? 'Could not synchronize this folder.';
      }),
    );

    const { profileId } = this.#deps;
    if (profileId) {
      this.#saved = (await this.#deps.data.loadProgress(profileId, entry.id)) ?? null;
      if (this.#destroyed) return;
      this.#cleanups.push(
        this.#deps.data.watchProgress(profileId, entry.id, (data, resultType, queryError) => {
          this.#saved = data ?? null;
          if (resultType === 'error') console.error('Could not synchronize playback progress', queryError);
        }),
      );
    }

    await this.#loadPlan();
    if (this.#destroyed) return;
    this.#timer = setInterval(() => {
      if (!video.paused) void this.save();
    }, PROGRESS_SAVE_INTERVAL_MS);
    const page = this.#deps.document;
    if (page) this.#listen(page, 'visibilitychange', () => page.visibilityState === 'hidden' && void this.save());
  }

  /** Switches the audio stream. Playback continues from the current position through HLS. */
  chooseAudio(stream: number | null) {
    if (stream === this.selectedAudio) return;
    this.selectedAudio = stream;
    this.#recoveredAt = null;
    void this.#loadPlan({ forceHls: true, keepPosition: true });
  }

  /** Starts the source over from the current position after an error. */
  retry() {
    if (!this.entry || !this.error) return;
    this.#recoveredAt = null;
    void this.#loadPlan({ forceHls: this.#usingHls, keepPosition: true });
  }

  /** Shows one text subtitle track, or none. */
  chooseSubtitle(index: number | null) {
    this.selectedSubtitle = index;
    const tracks = this.#video?.textTracks;
    if (!tracks) return;
    for (let track = 0; track < tracks.length; track++) tracks[track].mode = 'disabled';
    if (index !== null && tracks[index]) tracks[index].mode = 'showing';
  }

  /** Marks this media watched and opens the next one in the folder. */
  async skipToNext() {
    const next = this.nextEntry;
    if (!next || this.skipping) return;
    this.skipping = true;
    await this.save(true);
    await this.#deps.navigate(`/watch/${next.id}`);
  }

  /** Saves the playback position. `ended` also marks the media watched. */
  async save(ended = false) {
    const video = this.#video;
    const entry = this.entry;
    const { profileId } = this.#deps;
    if (!video || !profileId || !entry || this.#changingSource || !Number.isFinite(video.currentTime)) return;
    // Until the resume seek lands the player sits at 0, which is not where the viewer stopped.
    if (this.#cancelResume) return;
    if (!ended && !this.#hasPlaybackStarted && video.currentTime < 1) return;
    try {
      await this.#deps.data.savePlaybackProgress({
        profileId,
        mediaEntryId: entry.id,
        positionMs: Math.round(video.currentTime * 1000),
        durationMs: entry.durationMs ?? (Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null),
        watched: ended || undefined,
      });
    } catch (cause) {
      console.error('Could not save playback progress', cause);
    }
  }

  /** Saves progress one last time and releases everything the controller started. */
  destroy() {
    if (this.#destroyed) return;
    void this.save();
    this.#lifetime.abort();
    this.#requests?.abort();
    clearInterval(this.#timer);
    this.#cancelResume?.();
    this.#hls?.destroy();
    this.#hls = null;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }

  #listen(
    target: Pick<MediaElement, 'addEventListener' | 'removeEventListener'>,
    type: string,
    listener: (event: Event) => void,
  ) {
    target.addEventListener(type, listener);
    this.#cleanups.push(() => target.removeEventListener(type, listener));
  }

  async #requestJson<A>(url: string, init: RequestInit, decode: (body: unknown) => A, failure: string): Promise<A> {
    const response = await this.#deps.fetch(url, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new PlaybackError(readApiError(body)?.message ?? failure);
    try {
      return decode(body);
    } catch {
      throw new PlaybackError(failure);
    }
  }

  /**
   * Stops playback and shows `message` in place of the player. Nothing it leaves running can
   * keep the spinner or the progress-saving pause alive.
   */
  #fail(message: string) {
    this.#requests?.abort();
    this.#cancelResume?.();
    this.#hls?.destroy();
    this.#hls = null;
    this.error = message;
    this.loading = false;
    this.#changingSource = false;
  }

  #onHlsError(hls: HlsPlayer<Element>, failure: HlsFailure) {
    const video = this.#video;
    if (!failure.fatal || hls !== this.#hls || !video) return;
    // One automatic recovery per stretch of playback; a second failure shows the error.
    if (this.#recoveredAt === null) {
      if (failure.kind === 'media') {
        this.#recoveredAt = video.currentTime;
        hls.recoverMediaError();
        return;
      }
      // The server no longer has the session or segment (it expired during a long pause, or the
      // server restarted).
      if (failure.kind === 'network' && (failure.status === 404 || failure.status === 409)) {
        this.#restartSession(video);
        return;
      }
    }
    this.#fail(hlsFailureMessages[failure.kind]);
  }

  /** Starts a new HLS session where playback stopped; the one automatic recovery for a gone session. */
  #restartSession(video: Element) {
    this.#recoveredAt = video.currentTime;
    // `#loadPlan` reads the position before its first await, so the old player can go now. Left
    // running, it keeps retrying the gone session, and its next error would end this recovery.
    void this.#loadPlan({ forceHls: true, keepPosition: true });
    this.#hls?.destroy();
    this.#hls = null;
  }

  /**
   * Loads the plan and attaches its source. `forceHls` plays through an HLS session whatever the
   * plan says; `keepPosition` resumes from the current position instead of the saved progress.
   */
  async #loadPlan({ forceHls = false, keepPosition = false } = {}) {
    const video = this.#video;
    if (!video) return;
    this.#requests?.abort();
    const requests = new AbortController();
    this.#requests = requests;
    const { signal } = requests;
    if (keepPosition) {
      if (Number.isFinite(video.currentTime) && video.currentTime > 0)
        this.#pendingResumeMs = Math.round(video.currentTime * 1000);
      this.#resumePlaybackAfterAttach = true;
      this.#changingSource = true;
    }
    this.loading = true;
    this.error = '';
    try {
      const plan = await this.#requestJson(
        `/api/playback/${this.#mediaId}/plan${capabilityQuery(video)}`,
        { signal },
        decodePlan,
        'Playback failed',
      );
      if (plan.mode === 'unplayable') throw new PlaybackError(plan.reason);
      this.plan = plan;
      if (forceHls || plan.mode === 'hls') {
        const session = await this.#requestJson(
          `/api/playback/${this.#mediaId}/session`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ audioStream: this.selectedAudio }),
            signal,
          },
          decodeSession,
          'Could not start playback.',
        );
        await this.#attach(video, session.manifestUrl, true, signal);
      } else await this.#attach(video, plan.url, false, signal);
    } catch (cause) {
      // A newer source or `destroy()` replaced this one; its outcome no longer matters.
      if (signal.aborted) return;
      this.error = cause instanceof PlaybackError ? cause.message : 'Playback failed';
      this.#hls?.destroy();
      this.#hls = null;
    } finally {
      if (this.#requests === requests) {
        this.loading = false;
        this.#changingSource = false;
      }
    }
  }

  async #attach(video: Element, url: string, isHls: boolean, signal: AbortSignal) {
    this.#hls?.destroy();
    this.#hls = null;
    this.#cancelResume?.();
    this.#usingHls = isHls;
    const positionMs = this.#pendingResumeMs ?? this.#saved?.positionMs ?? 0;
    // After an audio-track switch, resume from the current position even if the saved progress is watched.
    const watched = this.#pendingResumeMs === null && Boolean(this.#saved?.watched);
    const resume = hasResumableProgress({ positionMs, watched })
      ? this.#resumeAt(video, positionMs / 1000)
      : Promise.resolve();
    if (isHls && !video.canPlayType(HLS_MIME_TYPE)) {
      const hls = await this.#deps.createHls();
      if (signal.aborted) {
        hls.destroy();
        return;
      }
      this.#hls = hls;
      hls.onError((failure) => this.#onHlsError(hls, failure));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else video.src = url;
    const play = this.#resumePlaybackAfterAttach ? video.play().catch(() => undefined) : Promise.resolve();
    this.#resumePlaybackAfterAttach = false;
    await resume;
    await play;
  }

  /**
   * Seeks to `targetSeconds` once the source can reach it. Seeking too early is ignored by the
   * browser, so this retries on each loading event until a seek lands near the target.
   */
  #resumeAt(video: MediaElement, targetSeconds: number) {
    return new Promise<void>((resolve) => {
      const events = ['loadedmetadata', 'durationchange', 'progress', 'canplay', 'seeked', 'timeupdate'];
      let requested = false;
      const finish = () => {
        events.forEach((event) => video.removeEventListener(event, attempt));
        this.#cancelResume = null;
        resolve();
      };
      const attempt = (event: Event) => {
        if (requested) {
          if (event.type !== 'seeked') return;
          if (Math.abs(video.currentTime - targetSeconds) < 1 && video.readyState >= 2) {
            this.#pendingResumeMs = null;
            finish();
            return;
          }
          requested = false;
        }
        const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
        if (seekableEnd < targetSeconds && (!Number.isFinite(video.duration) || targetSeconds >= video.duration - 2))
          return;
        requested = true;
        video.currentTime = targetSeconds;
      };
      events.forEach((event) => video.addEventListener(event, attempt));
      this.#cancelResume = finish;
    });
  }
}

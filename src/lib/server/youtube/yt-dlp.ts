/** Prefixes of the lines Fern asks yt-dlp to print, so they stand out from anything else it prints. */
const markers = { info: '[fern:info]', progress: '[fern:progress]', saved: '[fern:saved]' } as const;

/** What yt-dlp reports while it downloads, parsed from the lines `ytDlpArgs` asks it to print. */
export type YtDlpEvent =
  | {
      readonly type: 'info';
      readonly title: string | null;
      readonly channel: string | null;
      readonly durationMs: number | null;
    }
  | { readonly type: 'progress'; readonly downloadedBytes: number; readonly totalBytes: number | null }
  | { readonly type: 'saved'; readonly path: string };

type DownloadOptions = {
  readonly url: string;
  /** The YouTube library. The audio is saved as `<channel>/<title> [<video ID>].opus` with a `.jpg` cover beside it. */
  readonly libraryPath: string;
  /** Partial files. Kept between attempts, so a retried download resumes. */
  readonly stagingPath: string;
  /** yt-dlp runs JavaScript to answer YouTube's challenges; the Node.js running Fern does it. */
  readonly nodePath: string;
  /** FFmpeg's directory or executable, when it is not on the PATH. */
  readonly ffmpegLocation: string | null;
};

/**
 * Arguments that save a video's best Opus audio as is (no re-encoding), with its title, channel,
 * and chapters embedded and its thumbnail as cover art. The user's yt-dlp configuration is ignored.
 */
export function ytDlpArgs(options: DownloadOptions): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    '--encoding',
    'utf-8',
    '--no-js-runtimes',
    '--js-runtimes',
    `node:${options.nodePath}`,
    '--newline',
    '--progress',
    '--progress-template',
    `download:${markers.progress} %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s`,
    '--print',
    `before_dl:${markers.info} %(.{title,channel,uploader,duration})j`,
    '--print',
    `after_move:${markers.saved} %(filepath)s`,
    // --print would otherwise only simulate the download.
    '--no-simulate',
    '--format',
    'bestaudio[acodec=opus]/bestaudio',
    '--extract-audio',
    '--audio-format',
    'opus',
    '--embed-metadata',
    '--embed-chapters',
    '--write-thumbnail',
    '--convert-thumbnails',
    'jpg',
    // Names that also work on Windows and SMB shares, and the time of download as the file time.
    '--windows-filenames',
    '--no-mtime',
    '--paths',
    `home:${options.libraryPath}`,
    '--paths',
    `temp:${options.stagingPath}`,
    '--output',
    '%(channel,uploader|YouTube)s/%(title)s [%(id)s].%(ext)s',
    ...(options.ffmpegLocation ? ['--ffmpeg-location', options.ffmpegLocation] : []),
    '--',
    options.url,
  ];
}

const count = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** One line of yt-dlp's output as an event, or null for lines Fern did not ask for. */
export function parseYtDlpLine(line: string): YtDlpEvent | null {
  const trimmed = line.trim();
  if (trimmed.startsWith(markers.progress)) {
    const [downloaded, total] = trimmed.slice(markers.progress.length).trim().split(/\s+/);
    const downloadedBytes = count(downloaded);
    return downloadedBytes === null ? null : { type: 'progress', downloadedBytes, totalBytes: count(total) };
  }
  if (trimmed.startsWith(markers.saved)) {
    const path = trimmed.slice(markers.saved.length).trim();
    return path ? { type: 'saved', path } : null;
  }
  if (trimmed.startsWith(markers.info)) {
    try {
      const info = JSON.parse(trimmed.slice(markers.info.length)) as Record<string, unknown>;
      const seconds = typeof info.duration === 'number' && info.duration >= 0 ? info.duration : null;
      return {
        type: 'info',
        title: text(info.title),
        channel: text(info.channel) ?? text(info.uploader),
        durationMs: seconds === null ? null : Math.round(seconds * 1000),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Splits output into lines as it arrives; a line split across chunks is held until it is complete. */
export function lineReader(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let pending = '';
  const emit = (text: string) => {
    const lines = `${pending}${text}`.split(/\r?\n|\r/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) onLine(line);
  };
  return {
    push: (chunk: Uint8Array) => emit(decoder.decode(chunk, { stream: true })),
    end: () => {
      emit(`${decoder.decode()}\n`);
    },
  };
}

const reasons: ReadonlyArray<readonly [RegExp, string]> = [
  [/private video/i, 'This video is private.'],
  [/confirm your age|age[- ]restricted/i, 'YouTube only plays this video to signed-in adults.'],
  [/not a bot/i, 'YouTube asked Fern to prove it is not a bot. Try again later.'],
  [/members[- ]only|join this channel/i, 'This video is for channel members only.'],
  [/live event will begin|premieres in/i, 'This video has not started yet.'],
  [/is live|live stream/i, 'Live streams can be downloaded once they have ended.'],
];

/**
 * Why a download failed, safe to show: a known reason, or YouTube's own message (from an `ERROR:`
 * line about the video). Anything else, such as a failed post-processing step that names files,
 * stays in the log.
 */
export function describeYtDlpFailure(stderr: string): string {
  const errors = stderr.split(/\r?\n/).filter((line) => line.startsWith('ERROR:'));
  for (const [pattern, reason] of reasons) if (errors.some((line) => pattern.test(line))) return reason;
  // Extractor errors look like `ERROR: [youtube] <video ID>: Video unavailable. …`.
  const message = errors
    .map((line) => /^ERROR: \[[\w:]+\] [\w-]+: (.+)$/.exec(line)?.[1]?.trim())
    .find((found) => found);
  return message ? message.slice(0, 300) : 'yt-dlp could not download this video.';
}

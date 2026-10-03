import { describe, expect, it } from 'vitest';
import { describeYtDlpFailure, lineReader, parseYtDlpLine, ytDlpArgs } from '../../src/lib/server/youtube/yt-dlp';
import { youtubeVideoId, youtubeWatchUrl } from '../../src/lib/shared/youtube';

describe('youtubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=rBarjCP_KUs', 'rBarjCP_KUs'],
    ['https://youtube.com/watch?v=rBarjCP_KUs&t=120s', 'rBarjCP_KUs'],
    ['https://m.youtube.com/watch?v=rBarjCP_KUs', 'rBarjCP_KUs'],
    ['https://music.youtube.com/watch?v=rBarjCP_KUs&list=RDAMVM', 'rBarjCP_KUs'],
    ['https://www.youtube.com/watch?v=rBarjCP_KUs&list=PL123', 'rBarjCP_KUs'],
    ['https://youtu.be/rBarjCP_KUs?si=share', 'rBarjCP_KUs'],
    ['https://www.youtube.com/live/rBarjCP_KUs', 'rBarjCP_KUs'],
    ['https://www.youtube.com/shorts/rBarjCP_KUs', 'rBarjCP_KUs'],
    ['https://www.youtube-nocookie.com/embed/rBarjCP_KUs', 'rBarjCP_KUs'],
    ['  youtube.com/watch?v=rBarjCP_KUs  ', 'rBarjCP_KUs'],
  ])('reads the video of %s', (link, videoId) => {
    expect(youtubeVideoId(link)).toBe(videoId);
  });

  it.each([
    '',
    'not a link',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/watch?v=short',
    'https://example.com/watch?v=rBarjCP_KUs',
    'https://youtube.com.example.com/watch?v=rBarjCP_KUs',
    'javascript:alert(1)//youtube.com/watch?v=rBarjCP_KUs',
  ])('rejects %j', (link) => {
    expect(youtubeVideoId(link)).toBeNull();
  });

  it('downloads from the canonical watch link', () => {
    expect(youtubeWatchUrl('rBarjCP_KUs')).toBe('https://www.youtube.com/watch?v=rBarjCP_KUs');
  });
});

describe('yt-dlp', () => {
  it('saves Opus audio with chapters and a cover into the library, ignoring user configuration', () => {
    const args = ytDlpArgs({
      url: 'https://www.youtube.com/watch?v=rBarjCP_KUs',
      libraryPath: '/downloads',
      stagingPath: '/downloads/.downloading/1',
      nodePath: '/usr/local/bin/node',
      ffmpegLocation: null,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--ignore-config',
        '--no-playlist',
        '--embed-chapters',
        '--embed-metadata',
        '--write-thumbnail',
        'home:/downloads',
        'temp:/downloads/.downloading/1',
        'node:/usr/local/bin/node',
      ]),
    );
    expect(args.slice(args.indexOf('--audio-format'), args.indexOf('--audio-format') + 2)).toEqual([
      '--audio-format',
      'opus',
    ]);
    expect(args).not.toContain('--ffmpeg-location');
    // The link comes last, after `--`, so it can never be read as an option.
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=rBarjCP_KUs']);
  });

  it('parses the lines Fern asks for and ignores the rest', () => {
    expect(
      parseYtDlpLine('[fern:info] {"title": "overtime", "channel": "Chrysalis", "uploader": "x", "duration": 6976}'),
    ).toEqual({ type: 'info', title: 'overtime', channel: 'Chrysalis', durationMs: 6_976_000 });
    expect(
      parseYtDlpLine('[fern:info] {"title": null, "channel": null, "uploader": "Someone", "duration": null}'),
    ).toEqual({ type: 'info', title: null, channel: 'Someone', durationMs: null });
    expect(parseYtDlpLine('[fern:progress] 1024 122223283')).toEqual({
      type: 'progress',
      downloadedBytes: 1024,
      totalBytes: 122_223_283,
    });
    expect(parseYtDlpLine('[fern:progress] 2048 NA')).toEqual({
      type: 'progress',
      downloadedBytes: 2048,
      totalBytes: null,
    });
    expect(parseYtDlpLine('[fern:saved] /downloads/Chrysalis/overtime [rBarjCP_KUs].opus')).toEqual({
      type: 'saved',
      path: '/downloads/Chrysalis/overtime [rBarjCP_KUs].opus',
    });
    expect(parseYtDlpLine('[youtube] rBarjCP_KUs: Downloading webpage')).toBeNull();
    expect(parseYtDlpLine('[fern:info] {broken')).toBeNull();
    expect(parseYtDlpLine('[fern:progress] NA NA')).toBeNull();
  });

  it('reassembles lines and characters split across chunks', () => {
    const lines: string[] = [];
    const reader = lineReader((line) => lines.push(line));
    const text = Buffer.from('[fern:progress] 1 2\r\n[fern:saved] /d/Ünïcode ｜ mix.opus\n[fern:progress] 3');
    // Split inside the multi-byte "｜".
    const cut = text.indexOf(Buffer.from('｜')) + 1;
    reader.push(text.subarray(0, cut));
    reader.push(text.subarray(cut));
    expect(lines).toEqual(['[fern:progress] 1 2', '[fern:saved] /d/Ünïcode ｜ mix.opus']);
    reader.end();
    expect(lines.at(-1)).toBe('[fern:progress] 3');
  });

  it('explains failures without passing on arbitrary output', () => {
    expect(describeYtDlpFailure('ERROR: [youtube] abc: Private video. Sign in if you have access')).toBe(
      'This video is private.',
    );
    expect(describeYtDlpFailure('ERROR: [youtube] abcdefghijk: Video unavailable. This video has been removed')).toBe(
      'Video unavailable. This video has been removed',
    );
    expect(describeYtDlpFailure('WARNING: x\nERROR: Postprocessing: Conversion failed for /downloads/a.opus')).toBe(
      'yt-dlp could not download this video.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  describeYtDlpFailure,
  libraryRelativePath,
  parseYtDlpLine,
  ytDlpArgs,
} from '../../src/lib/server/youtube/yt-dlp';
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

  it('names files so they stay visible, below the library, and within file name limits', () => {
    const args = ytDlpArgs({
      url: 'https://www.youtube.com/watch?v=rBarjCP_KUs',
      libraryPath: '/downloads',
      stagingPath: '/downloads/.downloading/1',
      nodePath: '/usr/local/bin/node',
      ffmpegLocation: null,
    });
    // Leading dots and spaces are stripped from every part of the name.
    const replace = args.indexOf('--replace-in-metadata');
    expect(args.slice(replace, replace + 4)).toEqual([
      '--replace-in-metadata',
      'title,channel,uploader',
      '^[.\\s]+',
      '',
    ]);
    expect(new RegExp(args[replace + 2]!).test('  ..hidden')).toBe(true);
    expect('  ..hidden'.replace(new RegExp(args[replace + 2]!), '')).toBe('hidden');
    // Each name is cut to bytes, not characters, and ends well below 255 bytes with its ID and extension.
    expect(args[args.indexOf('--output') + 1]).toBe('%(channel,uploader|YouTube).100B/%(title).180B [%(id)s].%(ext)s');
  });

  it('accepts only files below the library that scans can see', () => {
    const library = path.resolve('/downloads');
    const inside = (...parts: string[]) => path.join(library, ...parts);
    expect(libraryRelativePath(library, inside('Chrysalis', 'Late Mix [rBarjCP_KUs].opus'))).toBe(
      'Chrysalis/Late Mix [rBarjCP_KUs].opus',
    );
    expect(libraryRelativePath(library, inside('Late...Mix [rBarjCP_KUs].opus'))).toBe('Late...Mix [rBarjCP_KUs].opus');
    // Outside the library, or the library itself.
    expect(libraryRelativePath(library, path.resolve('/elsewhere/a.opus'))).toBeNull();
    expect(libraryRelativePath(library, inside('..', 'a.opus'))).toBeNull();
    expect(libraryRelativePath(library, `${library}-other${path.sep}a.opus`)).toBeNull();
    expect(libraryRelativePath(library, library)).toBeNull();
    // Dot parts: hidden folders and files are skipped by scans.
    expect(libraryRelativePath(library, inside('.hidden', 'a.opus'))).toBeNull();
    expect(libraryRelativePath(library, inside('.downloading', '1', 'a.opus'))).toBeNull();
    expect(libraryRelativePath(library, inside('Chrysalis', '.a.opus'))).toBeNull();
    expect(libraryRelativePath(library, inside('Chrysalis', '..', '..', 'a.opus'))).toBeNull();
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
    expect(parseYtDlpLine('[fern:info] {"title": "  ", "uploader": " Someone ", "duration": -1}')).toEqual({
      type: 'info',
      title: null,
      channel: 'Someone',
      durationMs: null,
    });
    expect(parseYtDlpLine('[fern:progress] NA NA')).toBeNull();
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

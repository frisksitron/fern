import { it, expect } from 'vitest';
import { canDirectPlay } from '../../src/lib/server/media/playback-plan';
it.each([
  [{ container: 'mp4', videoCodec: 'h264', audioCodecSummary: 'aac' }, true],
  [{ container: 'matroska', videoCodec: 'h264', audioCodecSummary: 'aac' }, false],
  [{ container: 'mp4', videoCodec: 'hevc', audioCodecSummary: 'aac' }, false],
  [{ container: 'webm', videoCodec: 'vp9', audioCodecSummary: 'opus' }, true],
])('plans representative codecs', (media, expected) => expect(canDirectPlay(media)).toBe(expected));

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { MediaProbe } from '../../src/lib/server/media/probe';
import { MediaProcess } from '../../src/lib/server/media/process';

/** The real MediaProbe over an ffprobe that prints `output`. */
const probeOf = (output: unknown) =>
  MediaProbe.Service.use((probe) => probe.probe('/library/file.mov')).pipe(
    Effect.provide(
      MediaProbe.layer.pipe(
        Layer.provide(
          Layer.mock(MediaProcess.Service, {
            run: () => Effect.succeed({ stdout: Buffer.from(JSON.stringify(output)), stderr: '', durationMs: 1 }),
          }),
        ),
      ),
    ),
  );

describe('MediaProbe normalization', () => {
  it.effect('keeps ordinary values', () =>
    Effect.gen(function* () {
      const result = yield* probeOf({
        format: { duration: '12.5', format_name: 'mov,mp4', tags: { track: '3/12' } },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, bit_rate: '5000000' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '128000' },
        ],
      });
      expect(result).toMatchObject({
        durationMs: 12_500,
        trackNumber: 3,
        width: 1920,
        height: 1080,
        audioBitrate: 128_000,
        audioSampleRate: 48_000,
        audioChannels: 2,
      });
      expect(result.tracks[0]).toMatchObject({ streamIndex: 0, bitrate: 5_000_000 });
    }),
  );

  it.effect('drops numbers a PostgreSQL integer column cannot store', () =>
    Effect.gen(function* () {
      const result = yield* probeOf({
        format: { duration: '10', format_name: 'mov', bit_rate: '2800000000', tags: { track: '-4/9' } },
        streams: [
          // ProRes can run past 2^31 bits per second.
          { index: 0, codec_type: 'video', codec_name: 'prores', width: 4096, height: -1, bit_rate: '2800000000' },
          {
            index: 1,
            codec_type: 'audio',
            codec_name: 'pcm_s24le',
            channels: 99_999_999_999,
            sample_rate: '-48000',
            bit_rate: '2147483648',
            bits_per_raw_sample: '3000000000',
          },
        ],
      });
      expect(result.trackNumber).toBeNull();
      expect(result.height).toBe(null);
      expect(result.width).toBe(4096);
      expect(result.tracks[0]).toMatchObject({ bitrate: null, height: null, width: 4096 });
      expect(result.tracks[1]).toMatchObject({ channels: null, sampleRate: null, bitrate: null, bitDepth: null });
      expect(result).toMatchObject({ audioBitrate: null, audioSampleRate: null, audioChannels: null });
    }),
  );

  it.effect('accepts the largest integer and rejects the next one', () =>
    Effect.gen(function* () {
      const result = yield* probeOf({
        format: { format_name: 'mp3', tags: { track: '2147483647' } },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'mp3', bit_rate: '2147483648', sample_rate: 2147483647 },
        ],
      });
      expect(result.trackNumber).toBe(2_147_483_647);
      expect(result.audioSampleRate).toBe(2_147_483_647);
      expect(result.audioBitrate).toBeNull();
    }),
  );

  it.effect('ignores fractional dimensions and streams with unusable indexes', () =>
    Effect.gen(function* () {
      const result = yield* probeOf({
        format: { format_name: 'mkv' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920.5, height: 1080 },
          { index: -1, codec_type: 'audio', codec_name: 'aac' },
          { index: 3_000_000_000, codec_type: 'audio', codec_name: 'aac' },
        ],
      });
      expect(result.tracks).toHaveLength(1);
      expect(result).toMatchObject({ width: null, height: 1080 });
    }),
  );

  it.effect('drops durations and chapters a bigint column cannot hold', () =>
    Effect.gen(function* () {
      const negative = yield* probeOf({ format: { duration: '-5' }, streams: [] });
      expect(negative.durationMs).toBeNull();
      const huge = yield* probeOf({
        format: { duration: '1e30' },
        streams: [],
        chapters: [
          { start_time: '0', end_time: '1e30' },
          { start_time: '0', end_time: '5', tags: { title: 'Fine' } },
        ],
      });
      expect(huge.durationMs).toBeNull();
      expect(huge.chapters).toEqual([{ position: 0, startMs: 0, endMs: 5000, title: 'Fine' }]);
    }),
  );

  it.effect('drops NUL characters from tags, which a text column rejects', () =>
    Effect.gen(function* () {
      const result = yield* probeOf({
        format: { duration: '10', tags: { TITLE: 'Song\u0000', artist: 'Ar\u0000tist' } },
        streams: [{ index: 0, codec_type: 'audio', codec_name: 'flac', tags: { language: 'en\u0000g' } }],
        chapters: [{ start_time: '0', end_time: '5', tags: { title: 'Intro\u0000' } }],
      });
      expect(result).toMatchObject({ title: 'Song', artist: 'Artist' });
      expect(result.tracks[0]).toMatchObject({ language: 'eng' });
      expect(result.chapters[0]).toMatchObject({ title: 'Intro' });
    }),
  );
});

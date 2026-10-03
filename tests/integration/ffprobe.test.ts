import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { MediaProbe } from '../../src/lib/server/media/probe';
import { MediaProcess } from '../../src/lib/server/media/process';
import { testConfig } from '../support/config';

const media = MediaProcess.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    testConfig({
      FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
      FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
    }),
  ),
);

/** Runs FFmpeg to generate a fixture. */
const ffmpeg = (...args: string[]) =>
  MediaProcess.Service.use((process) =>
    process.run({
      program: 'ffmpeg',
      args: ['-y', '-hide_banner', '-loglevel', 'error', ...args],
      timeout: '30 seconds',
    }),
  );

/** A temporary directory for the test's fixtures, removed when the test ends. */
const fixtures = FileSystem.FileSystem.use((fs) => fs.makeTempDirectoryScoped({ prefix: 'fern-ffprobe-' }));

layer(Layer.mergeAll(MediaProbe.layer.pipe(Layer.provideMerge(media)), NodeServices.layer), {
  excludeTestServices: true,
  timeout: '30 seconds',
})('MediaProbe on real files', (it) => {
  it.effect(
    'normalizes generated direct-play fixture',
    () =>
      Effect.gen(function* () {
        const file = path.join(yield* fixtures, 'direct-play.mp4');
        yield* ffmpeg(
          ...['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440'],
          ...['-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file],
        );
        const result = yield* MediaProbe.Service.use((probe) => probe.probe(file));
        expect(result.videoCodec).toBe('h264');
        expect(result.audioCodecSummary).toContain('aac');
        expect(result.audioSampleRate).toBeGreaterThan(0);
        expect(result.audioChannels).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThan(2500);
        expect(result.tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
      }),
    30_000,
  );

  it.effect('reports broken media', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(yield* fixtures, 'broken.avi');
      yield* fs.writeFileString(file, 'This intentionally broken fixture tests probe errors.');
      const error = yield* MediaProbe.Service.use((probe) => probe.probe(file)).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'ProbeFailed', cause: { _tag: 'ProcessExited' } });
    }),
  );

  it.effect(
    'reads chapters, and the tags Opus files keep on their audio stream',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fixtures;
        // A mix as yt-dlp saves one: Ogg Opus with its title, artist, and chapters embedded.
        const metadata = path.join(directory, 'mix.txt');
        yield* fs.writeFileString(
          metadata,
          [
            ';FFMETADATA1',
            'title=Late Mix',
            'artist=Chrysalis',
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            'START=0',
            'END=1200',
            'title=Intro',
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            'START=1200',
            'END=5000',
            'title=Second Song',
            '',
          ].join('\n'),
        );
        const mix = path.join(directory, 'mix.opus');
        yield* ffmpeg(
          ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-i', metadata],
          ...['-map_metadata', '1', '-map_chapters', '1', '-c:a', 'libopus', mix],
        );

        const result = yield* MediaProbe.Service.use((probe) => probe.probe(mix));
        expect(result).toMatchObject({ title: 'Late Mix', artist: 'Chrysalis', audioCodecSummary: 'opus' });
        // The last chapter ends after the audio does, so it is cut at the file's duration.
        expect(result.chapters).toEqual([
          { position: 0, startMs: 0, endMs: 1200, title: 'Intro' },
          { position: 1, startMs: 1200, endMs: result.durationMs, title: 'Second Song' },
        ]);
      }),
    30_000,
  );
});

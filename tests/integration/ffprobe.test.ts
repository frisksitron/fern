import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MediaProcessRunner } from '../../src/lib/server/media/process-runner';
import { probeMedia } from '../../src/lib/server/media/probe';
import { testConfig } from '../support/config';

const runner = MediaProcessRunner.layer.pipe(
  Layer.provide(testConfig({ FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe' })),
);
const probe = (file: string) => Effect.runPromise(Effect.result(Effect.provide(probeMedia(file), runner)));

let fixtures: string;

beforeAll(async () => {
  fixtures = await mkdtemp(path.join(tmpdir(), 'fern-ffprobe-'));
  const result = spawnSync(
    process.env.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      path.join(fixtures, 'direct-play.mp4'),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`FFmpeg fixture generation failed: ${result.stderr || result.error}`);
  await writeFile(path.join(fixtures, 'broken.avi'), 'This intentionally broken fixture tests probe errors.');
}, 30000);

afterAll(async () => {
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
});

it('normalizes generated direct-play fixture', { timeout: 30000 }, async () => {
  const outcome = await probe(path.join(fixtures, 'direct-play.mp4'));
  if (outcome._tag !== 'Success') throw new Error('probe failed');
  const result = outcome.success;
  expect(result.videoCodec).toBe('h264');
  expect(result.audioCodecSummary).toContain('aac');
  expect(result.audioSampleRate).toBeGreaterThan(0);
  expect(result.audioChannels).toBeGreaterThan(0);
  expect(result.durationMs).toBeGreaterThan(2500);
  expect(result.tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
});

it('reports broken media', { timeout: 30000 }, async () => {
  expect(await probe(path.join(fixtures, 'broken.avi'))).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ProbeFailed', cause: { _tag: 'ProcessExited' } },
  });
});

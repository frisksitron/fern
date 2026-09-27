import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = path.resolve('mock-media');
await mkdir(path.join(root, 'Anime', 'Demo Show'), { recursive: true });
await mkdir(path.join(root, 'Movies'), { recursive: true });
function ff(args) {
  const r = spawnSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('FFmpeg fixture generation failed');
}
ff([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440',
  '-t',
  '45',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  path.join(root, 'Movies', 'Direct Play Demo.mp4'),
]);
ff([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=24',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=660',
  '-t',
  '45',
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:a',
  '-metadata:s:a:0',
  'language=jpn',
  '-metadata:s:a:1',
  'language=eng',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-c:a',
  'aac',
  path.join(root, 'Anime', 'Demo Show', '01 - Multi Audio.mkv'),
]);
await writeFile(
  path.join(root, 'Movies', 'Direct Play Demo.en.srt'),
  '1\n00:00:01,000 --> 00:00:05,000\nWelcome to Fern.\n\n2\n00:00:06,000 --> 00:00:10,000\nThis is a local subtitle.\n',
);
await writeFile(
  path.join(root, 'Movies', 'Broken Sample.avi'),
  'This intentionally broken fixture tests probe errors.',
);
console.log(`Mock media created in ${root}`);

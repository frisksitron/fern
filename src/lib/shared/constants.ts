export const VIDEO_EXTENSIONS = new Set([
  '.mkv',
  '.mp4',
  '.m4v',
  '.webm',
  '.mov',
  '.avi',
  '.mpeg',
  '.mpg',
  '.ts',
  '.m2ts',
]);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav']);
export const AVATARS = Array.from({ length: 10 }, (_, i) => `avatar-${String(i + 1).padStart(2, '0')}`);

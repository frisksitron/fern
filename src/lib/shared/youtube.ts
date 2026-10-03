const videoIdPattern = /^[\w-]{11}$/;
const youtubeHosts = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

/**
 * The video a YouTube link points to, or null when the text is not a link to one video. Accepts
 * watch, share (`youtu.be`), live, shorts, and embed links; a playlist link with a video in it
 * means that video.
 */
export function youtubeVideoId(text: string): string | null {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const candidate =
    host === 'youtu.be'
      ? segments[0]
      : !youtubeHosts.has(host)
        ? undefined
        : segments[0] === 'watch'
          ? url.searchParams.get('v')
          : ['live', 'shorts', 'embed', 'v'].includes(segments[0] ?? '')
            ? segments[1]
            : undefined;
  return candidate && videoIdPattern.test(candidate) ? candidate : null;
}

/** The canonical link to a video, the one Fern downloads from. */
export function youtubeWatchUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

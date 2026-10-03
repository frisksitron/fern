import type { HlsPlayer } from './watch-controller.svelte';

/**
 * hls.js with a fragment load policy that outlasts the server: a segment can wait up to 20 s for a
 * transcode slot, then encode for 30 s and again for 30 s on a retry, while hls.js gives up on a
 * first byte after 10 s. A timeout retries twice, not the default four, as each can take this long.
 */
export async function createHlsPlayer(): Promise<HlsPlayer<HTMLVideoElement>> {
  const { default: Hls } = await import('hls.js');
  const hls = new Hls({
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 90_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
      },
    },
  });
  return {
    loadSource: (url) => hls.loadSource(url),
    attachMedia: (element) => hls.attachMedia(element),
    onError: (listener) =>
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const status = data.response?.code ?? null;
        // 404 and 409 mean the server dropped the session. hls.js would still retry a fragment that
        // answers 404 with backoff for about 30 s (no `shouldRetry` stops that), so report it as fatal at once.
        const gone = data.type === Hls.ErrorTypes.NETWORK_ERROR && (status === 404 || status === 409);
        listener({
          fatal: data.fatal || gone,
          kind:
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'network'
              : data.type === Hls.ErrorTypes.MEDIA_ERROR
                ? 'media'
                : 'other',
          status,
        });
      }),
    recoverMediaError: () => hls.recoverMediaError(),
    destroy: () => hls.destroy(),
  };
}

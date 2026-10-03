import { StartYouTubeDownloadResponse, type StartYouTubeDownloadRequest } from '$lib/shared/contracts/youtube';
import { request, requestJson } from './api';

/** Queues a YouTube video's audio for download. Its progress reaches the page through Zero. */
export async function startYouTubeDownload(url: string): Promise<string> {
  const body: StartYouTubeDownloadRequest = { url };
  const started = await requestJson(
    '/api/youtube/downloads',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    StartYouTubeDownloadResponse,
    'Could not start the download.',
  );
  return started.downloadId;
}

export async function retryYouTubeDownload(id: string): Promise<void> {
  await request(
    `/api/youtube/downloads/${encodeURIComponent(id)}/retry`,
    { method: 'POST' },
    'Could not retry the download.',
  );
}

/** Removes a download from the list, stopping it if it runs. A saved song stays in the library. */
export async function dismissYouTubeDownload(id: string): Promise<void> {
  await request(
    `/api/youtube/downloads/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Could not remove the download.',
  );
}

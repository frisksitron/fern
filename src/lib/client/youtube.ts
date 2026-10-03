import { Schema } from 'effect';
import { readApiError } from '$lib/shared/contracts/api-error';
import { StartYouTubeDownloadResponse, type StartYouTubeDownloadRequest } from '$lib/shared/contracts/youtube';

const decodeStarted = Schema.decodeUnknownSync(StartYouTubeDownloadResponse);

async function failure(response: Response, fallback: string) {
  return new Error(readApiError(await response.json().catch(() => null))?.message ?? fallback);
}

/** Queues a YouTube video's audio for download. Its progress reaches the page through Zero. */
export async function startYouTubeDownload(url: string): Promise<string> {
  const request: StartYouTubeDownloadRequest = { url };
  const response = await fetch('/api/youtube/downloads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response, 'Could not start the download.');
  return decodeStarted(await response.json()).downloadId;
}

export async function retryYouTubeDownload(id: string): Promise<void> {
  const response = await fetch(`/api/youtube/downloads/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  if (!response.ok) throw await failure(response, 'Could not retry the download.');
}

/** Removes a download from the list, stopping it if it runs. A saved song stays in the library. */
export async function dismissYouTubeDownload(id: string): Promise<void> {
  const response = await fetch(`/api/youtube/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await failure(response, 'Could not remove the download.');
}

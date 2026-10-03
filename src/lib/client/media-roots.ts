import {
  CreateMediaRootResponse,
  type CreateMediaRootRequest,
  type MediaRootSummary,
  type MediaType,
} from '$lib/shared/contracts/media-roots';
import { request, requestJson } from './api';

/**
 * Asks the server to add a media folder, and returns it as the server stored it. The server
 * canonicalizes and validates the path; the new root reaches other pages through Zero.
 */
export async function addMediaRoot(path: string, mediaType: MediaType): Promise<MediaRootSummary> {
  const body: CreateMediaRootRequest = { path, mediaType };
  const created = await requestJson(
    '/api/media-roots',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    CreateMediaRootResponse,
    'Could not add media folder.',
  );
  return created.root;
}

/**
 * Removes a media folder and everything indexed in it; the files themselves are untouched. The
 * server refuses while a scan is running. The removal reaches the browser through Zero.
 */
export async function removeMediaRoot(id: string): Promise<void> {
  await request(`/api/media-roots/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not remove media folder.');
}

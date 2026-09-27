import { Schema } from 'effect';
import { readApiError } from '$lib/shared/contracts/api-error';
import {
  CreateMediaRootResponse,
  type CreateMediaRootRequest,
  type MediaRootSummary,
  type MediaType,
} from '$lib/shared/contracts/media-roots';

const decodeCreated = Schema.decodeUnknownSync(CreateMediaRootResponse);

/**
 * Asks the server to add a media folder, and returns it as the server stored it. The server
 * canonicalizes and validates the path; the new root reaches other pages through Zero.
 */
export async function addMediaRoot(path: string, mediaType: MediaType): Promise<MediaRootSummary> {
  const request: CreateMediaRootRequest = { path, mediaType };
  const response = await fetch('/api/media-roots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return decodeCreated(body).root;
  throw new Error(readApiError(body)?.message ?? 'Could not add media folder.');
}

/**
 * Removes a media folder and everything indexed in it; the files themselves are untouched. The
 * server refuses while a scan is running. The removal reaches the browser through Zero.
 */
export async function removeMediaRoot(id: string): Promise<void> {
  const response = await fetch(`/api/media-roots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (response.ok) return;
  const error = readApiError(await response.json().catch(() => null));
  throw new Error(error?.message ?? 'Could not remove media folder.');
}

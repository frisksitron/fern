import type { MediaEntry, MediaRoot } from '$lib/zero/schema';

export type MediaFolderSnapshot = {
  rootId: string | null;
  folderId: string | null;
  roots: MediaRoot[];
  entries: MediaEntry[];
  folder: MediaEntry | null;
  trail: MediaEntry[];
};

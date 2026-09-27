import { createContext } from 'svelte';
import { isMusicBrowsePath } from '$lib/music/paths';

const storageKey = 'fern:last-music-files-path';

export class BrowseMemory {
  href = $state('/music');

  restore() {
    const saved = sessionStorage.getItem(storageKey);
    if (saved && isMusicBrowsePath(saved)) this.href = saved;
  }

  remember(pathname: string) {
    if (!isMusicBrowsePath(pathname)) return;
    this.href = pathname;
    sessionStorage.setItem(storageKey, pathname);
  }
}

export const [getBrowseMemory, setBrowseMemory] = createContext<BrowseMemory>();

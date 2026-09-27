import { createContext } from 'svelte';
import { goto } from '$app/navigation';
import { clearProfileCookie } from '$lib/client/profile';
import { watchPlaylists, watchProfiles, type Playlist } from '$lib/client/zero/data';

/** The music section's shared state: the profile's playlists and the current message. */
export class MusicCatalog {
  playlists = $state<readonly Playlist[]>([]);
  message = $state('');

  constructor(playlists: readonly Playlist[]) {
    this.playlists = playlists;
  }

  connect(profileId: string) {
    const cleanups = [
      watchProfiles((data, resultType) => {
        if (resultType === 'complete' && !data.some((profile) => profile.id === profileId)) {
          clearProfileCookie();
          void goto('/');
        }
      }),
      watchPlaylists(profileId, (data, resultType) => {
        if (resultType === 'complete') this.playlists = data;
      }),
    ];
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }
}

export const [getMusicCatalog, setMusicCatalog] = createContext<MusicCatalog>();

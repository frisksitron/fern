import { goto } from '$app/navigation';

/** The FX page: the playing song's visual effect, with only the player in front of it. */
export const MUSIC_FX_PATH = '/music/fx';

/** Whether the FX page was opened from another page, which leaving it goes back to. */
let openedFromPage = false;

export function openMusicFx() {
  openedFromPage = true;
  void goto(MUSIC_FX_PATH);
}

/** Back to the page it was opened from, or to the music section if it was opened directly. */
export function closeMusicFx() {
  if (openedFromPage) history.back();
  else void goto('/music');
  openedFromPage = false;
}

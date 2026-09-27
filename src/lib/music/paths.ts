export function isMusicBrowsePath(pathname: string) {
  if (pathname === '/music') return true;
  if (!pathname.startsWith('/music/')) return false;
  if (pathname === '/music/search' || pathname.startsWith('/music/search/')) return false;
  if (pathname === '/music/playlist' || pathname.startsWith('/music/playlist/')) return false;
  return true;
}

function playlistIdFromPath(pathname: string) {
  return pathname.match(/^\/music\/playlist\/([^/]+)/)?.[1] ?? null;
}

export function parseMusicBrowsePath(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'music' || parts.length < 2) return { root: null, folder: null };
  return { root: parts[1], folder: parts[2] ?? null };
}

export function musicRoute(pathname: string, savedBrowseHref: string) {
  const browsing = isMusicBrowsePath(pathname);
  return {
    browsing,
    searching: pathname === '/music/search',
    browseHref: browsing ? pathname : savedBrowseHref,
    activePlaylistId: playlistIdFromPath(pathname),
  };
}

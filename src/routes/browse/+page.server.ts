import { runLoad } from '$lib/server/http';
import { loadBrowseSnapshot } from '$lib/server/library/browse';
import { loadContinueWatching } from '$lib/server/library/continue-watching';
import { libraryPageFailure } from '$lib/server/library/http';
import { CONTINUE_WATCHING_DEPENDENCY } from '$lib/shared/browse-data';
import type { PageServerLoad } from './$types';

// The continue-watching row is on the video home only, and reloads on its own when progress changes.
export const load: PageServerLoad = async ({ locals, request, depends }) => {
  depends(CONTINUE_WATCHING_DEPENDENCY);
  const [browse, continueWatching] = await Promise.all([
    runLoad(request, loadBrowseSnapshot(locals.profileId!), libraryPageFailure('/browse')),
    runLoad(request, loadContinueWatching(locals.profileId!), libraryPageFailure('/browse')),
  ]);
  return { browse, continueWatching };
};

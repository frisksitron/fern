import { runLoad } from '$lib/server/http';
import { libraryPageFailure } from '$lib/server/library/http';
import { loadMusicShell } from '$lib/server/library/music';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, request }) => ({
  musicShell: await runLoad(request, loadMusicShell(locals.profileId!), libraryPageFailure('/music')),
});

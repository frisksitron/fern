import { Effect } from 'effect';
import { runLoad } from '$lib/server/http';
import { loadBrowseSnapshot } from '$lib/server/library/browse';
import { libraryPageFailure, rootParam } from '$lib/server/library/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, request }) => ({
  browse: await runLoad(
    request,
    Effect.flatMap(rootParam(params.root), (rootId) => loadBrowseSnapshot(locals.profileId!, rootId)),
    libraryPageFailure('/browse'),
  ),
});

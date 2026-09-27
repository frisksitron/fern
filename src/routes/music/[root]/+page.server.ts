import { Effect } from 'effect';
import { runLoad } from '$lib/server/http';
import { loadMediaFolder } from '$lib/server/library/folders';
import { libraryPageFailure, rootParam } from '$lib/server/library/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request }) => ({
  folder: await runLoad(
    request,
    Effect.flatMap(rootParam(params.root), (rootId) => loadMediaFolder('music', rootId)),
    libraryPageFailure('/music'),
  ),
});

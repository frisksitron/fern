import { Effect } from 'effect';
import { runLoad } from '$lib/server/http';
import { loadMediaFolder } from '$lib/server/library/folders';
import { folderParam, libraryPageFailure, rootParam } from '$lib/server/library/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, request }) => ({
  folder: await runLoad(
    request,
    Effect.gen(function* () {
      const rootId = yield* rootParam(params.root);
      return yield* loadMediaFolder('music', rootId, yield* folderParam(rootId, params.folder));
    }),
    libraryPageFailure('/music'),
  ),
});

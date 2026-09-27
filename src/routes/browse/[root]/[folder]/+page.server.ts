import { Effect } from 'effect';
import { runLoad } from '$lib/server/http';
import { loadBrowseSnapshot } from '$lib/server/library/browse';
import { folderParam, libraryPageFailure, rootParam } from '$lib/server/library/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, request }) => ({
  browse: await runLoad(
    request,
    Effect.gen(function* () {
      const rootId = yield* rootParam(params.root);
      const folderId = yield* folderParam(rootId, params.folder);
      return yield* loadBrowseSnapshot(locals.profileId!, rootId, folderId);
    }),
    libraryPageFailure('/browse'),
  ),
});

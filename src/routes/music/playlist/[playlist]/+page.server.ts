import { Effect } from 'effect';
import { runLoad } from '$lib/server/http';
import { libraryPageFailure, playlistParam } from '$lib/server/library/http';
import { loadPlaylistPage } from '$lib/server/library/music';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, request }) =>
  runLoad(
    request,
    Effect.flatMap(playlistParam(params.playlist), (playlistId) => loadPlaylistPage(locals.profileId!, playlistId)),
    libraryPageFailure('/music'),
  );

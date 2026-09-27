import { redirect } from '@sveltejs/kit';
import { runLoad } from '$lib/server/http';
import { loadMediaFolder } from '$lib/server/library/folders';
import { libraryPageFailure } from '$lib/server/library/http';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request }) => {
  if (url.searchParams.get('view') === 'search') {
    const query = url.searchParams.get('q');
    const target = new URL('/music/search', url.origin);
    if (query) target.searchParams.set('q', query);
    redirect(303, `${target.pathname}${target.search}`);
  }
  return { folder: await runLoad(request, loadMediaFolder('music'), libraryPageFailure('/music')) };
};

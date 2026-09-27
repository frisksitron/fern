import { runLoad } from '$lib/server/http';
import { loadMediaRoots } from '$lib/server/library/folders';
import { databaseUnavailable } from '$lib/server/public-errors';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request }) => ({
  roots: await runLoad(request, loadMediaRoots(null), () => databaseUnavailable),
});

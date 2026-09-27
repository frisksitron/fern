import { runLoad } from '$lib/server/http';
import { loadProfiles } from '$lib/server/library/profiles';
import { databaseUnavailable } from '$lib/server/public-errors';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request }) => ({
  profiles: await runLoad(request, loadProfiles(), () => databaseUnavailable),
});

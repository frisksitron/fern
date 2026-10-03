import { respond } from '$lib/server/http';
import { browseFailure } from '$lib/server/media-roots/http';
import { MediaRoots } from '$lib/server/media-roots/service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url }) =>
  respond(
    request,
    MediaRoots.Service.use((mediaRoots) => mediaRoots.listDirectories(url.searchParams.get('path'))),
    { success: (listing) => Response.json(listing), failure: browseFailure },
  );

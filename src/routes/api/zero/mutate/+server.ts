import { respond } from '$lib/server/http';
import { ZeroServer } from '$lib/server/zero/service';
import type { RequestHandler } from './$types';

/** Zero's push endpoint: runs client mutations authoritatively. Mutator errors are reported in the body. */
export const POST: RequestHandler = ({ request }) =>
  respond(
    request,
    ZeroServer.use((zero) => zero.mutate(request)),
    { success: (result) => Response.json(result), failure: (error: never) => error },
  );

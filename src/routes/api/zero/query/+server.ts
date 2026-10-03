import { respond } from '$lib/server/http';
import { ZeroServer } from '$lib/server/zero/service';
import type { RequestHandler } from './$types';

/** Zero's query endpoint: transforms named queries into ZQL for zero-cache. */
export const POST: RequestHandler = ({ request }) =>
  respond(
    request,
    ZeroServer.Service.use((zero) => zero.query(request)),
    { success: (result) => Response.json(result), failure: (error: never) => error },
  );

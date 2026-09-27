import { Effect, Schema } from 'effect';
import { readJsonBody, respond } from '$lib/server/http';
import { createMediaRootFailure } from '$lib/server/media-roots/http';
import { MediaRoots } from '$lib/server/media-roots/service';
import { CreateMediaRootRequest, type CreateMediaRootResponse } from '$lib/shared/contracts/media-roots';
import type { RequestHandler } from './$types';

const decodeRequest = Schema.decodeUnknownEffect(CreateMediaRootRequest);

export const POST: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const command = yield* readJsonBody(request, decodeRequest);
      const mediaRoots = yield* MediaRoots;
      return yield* mediaRoots.create(command);
    }),
    {
      success: (root) => Response.json({ root } satisfies CreateMediaRootResponse, { status: 201 }),
      failure: createMediaRootFailure,
    },
  );

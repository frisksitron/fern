import { redirect } from '@sveltejs/kit';
import { Effect } from 'effect';
import type { PageServerLoad } from './$types';
import { runLoad } from '$lib/server/http';
import { browseFailure } from '$lib/server/media-roots/http';
import { MediaRoots } from '$lib/server/media-roots/service';

type MediaFolderType = 'video' | 'music';

function mediaFolderType(value: string | null): MediaFolderType {
  if (value === 'video' || value === 'music') return value;
  redirect(303, '/settings/media');
}

export const load: PageServerLoad = async ({ url, request }) => {
  const type = mediaFolderType(url.searchParams.get('type'));
  const requested = url.searchParams.get('path');
  return runLoad(
    request,
    MediaRoots.use((mediaRoots) => mediaRoots.listDirectories(requested)).pipe(
      Effect.map((listing) => ({ type, error: null, ...listing })),
      // The picker shows why a folder cannot be opened next to the path the user typed.
      Effect.catch((error) =>
        Effect.succeed({
          type,
          error: browseFailure(error).message,
          currentPath: requested,
          parentPath: null,
          directories: [],
        }),
      ),
    ),
    (error: never) => error,
  );
};

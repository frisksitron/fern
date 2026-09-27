import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { Option, Schema } from 'effect';
import { runLoad } from '$lib/server/http';
import { profileExists } from '$lib/server/library/profiles';
import { databaseUnavailable } from '$lib/server/public-errors';
import { disposeAppRuntime, startAppRuntime } from '$lib/server/runtime';
import { ProfileId } from '$lib/shared/contracts/ids';

const state = globalThis as typeof globalThis & { __fernShutdown?: boolean };
if (!state.__fernShutdown) {
  state.__fernShutdown = true;
  // Shutdown order: stop accepting requests and let open ones finish, then
  // dispose the runtime, which interrupts scoped work (a running scan hands its job back, FFmpeg
  // processes are stopped), runs finalizers, and finally closes the database pools.
  // In production adapter-node handles SIGTERM and SIGINT: it stops accepting connections, waits
  // up to SHUTDOWN_TIMEOUT seconds for open requests, and then emits `sveltekit:shutdown`.
  if (dev) {
    process.once('SIGTERM', disposeAppRuntime);
    process.once('SIGINT', disposeAppRuntime);
  } else process.once('sveltekit:shutdown', disposeAppRuntime);
}

export const init: ServerInit = async () => {
  await startAppRuntime();
};

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);
const profileSections = ['/browse', '/watch', '/music'];

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.profileId = null;
  const cookie = event.cookies.get('profileId');
  const profileId = Option.getOrNull(decodeProfileId(cookie));
  if (cookie !== undefined && profileId === null) event.cookies.delete('profileId', { path: '/' });

  const { pathname } = event.url;
  if (profileSections.some((section) => pathname === section || pathname.startsWith(`${section}/`))) {
    if (!profileId) redirect(303, '/');
    if (!(await runLoad(event.request, profileExists(profileId), () => databaseUnavailable))) {
      event.cookies.delete('profileId', { path: '/' });
      redirect(303, '/');
    }
    event.locals.profileId = profileId;
  }
  if (pathname === '/' && profileId) redirect(303, '/browse');
  return resolve(event);
};

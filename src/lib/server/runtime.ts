import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { FernConfig } from './config';
import { Database } from './db/service';
import { loggingLayer } from './logging';
import { MediaLibrary } from './media/library';
import { MediaRoots } from './media-roots/service';
import { Health } from './operations/health';
import { Playback } from './playback/service';
import { ScanEvents } from './scans/events';
import { Scans } from './scans/service';
import { Thumbnails } from './thumbnails/service';
import { TrackMaps } from './track-maps/service';
import { Transcoding } from './transcoding/service';
import { YouTubeDownloads } from './youtube/service';
import { ZeroServer } from './zero/service';

// Each `defaultLayer` wires its own dependencies. Layers are memoized by reference, so a dependency
// several services share (configuration, the database pool, the process runner, the scan worker,
// and the scan event hub that the scanner publishes to and event streams subscribe to) is built
// once for the whole runtime.
const AppLayer = Layer.mergeAll(
  // The platform services, for routes that serve files.
  NodeServices.layer,
  Database.defaultLayer,
  MediaRoots.defaultLayer,
  MediaLibrary.defaultLayer,
  Playback.defaultLayer,
  Scans.defaultLayer,
  ScanEvents.defaultLayer,
  Transcoding.defaultLayer,
  Thumbnails.defaultLayer,
  TrackMaps.defaultLayer,
  Health.defaultLayer,
  YouTubeDownloads.defaultLayer,
  ZeroServer.defaultLayer,
  // Logging applies to everything the runtime runs, including layer construction.
).pipe(Layer.provide(loggingLayer.pipe(Layer.provide(FernConfig.defaultLayer))));

/** Services available to route handlers and page loads. */
export type AppServices = Layer.Success<typeof AppLayer>;

type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

const state = globalThis as typeof globalThis & { __fernRuntime?: AppRuntime; __fernRuntimeStarted?: boolean };

// Vite re-evaluates this module in development when it or a dependency changes. The previous
// runtime is disposed so services, pools, and background fibers are never duplicated, and the new
// one is built only after that finishes, so the old scan worker has released its lock and job.
const previousDisposal = state.__fernRuntime?.dispose();
const AfterPreviousRuntime = Layer.effectDiscard(Effect.promise(async () => previousDisposal));

/** The one long-lived runtime for the server. Route handlers run programs on it; services never do. */
export const appRuntime: AppRuntime = ManagedRuntime.make(AppLayer.pipe(Layer.provide(AfterPreviousRuntime)));
state.__fernRuntime = appRuntime;

/**
 * Builds the application layer now rather than on the first request, so background work such as
 * the scan worker starts with the server and resumes scans accepted before a restart.
 */
export async function startAppRuntime() {
  state.__fernRuntimeStarted = true;
  await appRuntime.context();
}

// A runtime replaced during development starts again if the previous one had been started.
if (state.__fernRuntimeStarted) void startAppRuntime();

/**
 * Interrupts runtime-owned work and runs finalizers: a running scan hands its job back, FFmpeg
 * processes stop, and the database pools close last. Call during shutdown.
 */
export async function disposeAppRuntime() {
  await state.__fernRuntime?.dispose();
}

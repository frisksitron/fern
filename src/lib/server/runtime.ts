import { Effect, Layer, ManagedRuntime } from 'effect';
import { FernConfig, FernConfigLive } from './config';
import { Database } from './db/service';
import { loggingLayer } from './logging';
import { MediaLibrary } from './media/library';
import { MediaRoots } from './media-roots/service';
import { Health } from './operations/health';
import { Playback } from './playback/service';
import { ScanEvents } from './scans/events';
import { Scans } from './scans/service';
import { Thumbnails } from './thumbnails/service';
import { Transcoding } from './transcoding/service';
import { ZeroServer } from './zero/service';

/** Services available to route handlers and page loads. */
export type AppServices =
  Database | MediaRoots | MediaLibrary | Playback | Scans | ScanEvents | Transcoding | Thumbnails | Health | ZeroServer;

// Each service's `layer` wires its own dependencies. Layers are shared by reference, so a
// dependency used by several services (the process runner, the scan worker) is built once. The
// root supplies what everything shares: configuration, the database, and the scan event hub, which
// the scanner publishes to and event streams subscribe to.
const Infrastructure = Layer.mergeAll(Database.layer, ScanEvents.layer).pipe(Layer.provideMerge(FernConfigLive));

// Logging applies to everything the runtime runs, including layer construction.
const Logging = Layer.unwrap(FernConfig.use((config) => Effect.succeed(loggingLayer(config)))).pipe(
  Layer.provide(FernConfigLive),
);

const AppLayer: Layer.Layer<AppServices> = Layer.mergeAll(
  MediaRoots.layer,
  MediaLibrary.layer,
  Playback.layer,
  Scans.layer,
  Transcoding.layer,
  Thumbnails.layer,
  Health.layer,
  ZeroServer.layer,
).pipe(Layer.provideMerge(Infrastructure), Layer.provide(Logging));

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

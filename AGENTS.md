# Agent workflow

During normal development, make changes incrementally and rely on Vite hot reload. Do not restart the local development environment unless it is stopped, unresponsive, or the change specifically requires a restart. Do not stop the local environment merely to run end-to-end tests.

Do not run checks, automated tests, Playwright, or create screenshots after every small change. Batch validation and run it only when the user asks, or immediately before pushing to a remote Git repository.

Before a remote push, run the relevant checks and tests. For user-visible changes, run the relevant Playwright tests and store current screenshots under `test-results/screenshots/`.

# Effect

The server is written with Effect 4. Use the installed version as the source of truth, not memory of Effect 2 or 3: `node_modules/effect/AGENTS.md` and the runnable examples in `node_modules/effect/ai-docs/src/` come with the package, and the module sources are in `node_modules/effect/src/`. Check them, or nearby Fern code, before using an API you are unsure of.

## Service modules

A service module has flat top-level exports and re-exports itself as a namespace at the bottom:

```ts
// src/lib/server/media/library.ts
export interface Interface {
  readonly activeMedia: (id: MediaEntryId) => Effect.Effect<ActiveMedia, MediaNotFound | DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/MediaLibrary') {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;

    const activeMedia = Effect.fn('MediaLibrary.activeMedia')(function* (id: MediaEntryId) {
      ...
    });

    return Service.of({ activeMedia });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer));

export * as MediaLibrary from './library';
```

Callers import the namespace: `import { MediaLibrary } from '$lib/server/media/library'`, then `yield* MediaLibrary.Service` and `MediaLibrary.defaultLayer`.

- `layer` needs the service's dependencies; `defaultLayer` provides the production ones. Layers are memoized by reference, so a dependency several services share (the database, configuration, the scan event hub) is built once per runtime.
- Tests build the service from `layer` and provide fakes. Never try to replace a dependency inside a `defaultLayer`.
- Write the `Interface` out, with the expected errors in each method's type. Service keys are `@fern/<Name>`.
- Yield dependencies once while building the layer and close over them; methods never yield services.
- Bind a service to a name before calling it. Never `yield* (yield* Foo.Service).bar()`.
- Only service modules get the namespace re-export. Pure helpers, schemas, and error classes are ordinary named exports, imported by name (also from a service module: `import { Database, orUnavailable } from '$lib/server/db/service'`).
- Read models (page loads, MCP tools) that only query the database are plain functions over `query((db) => ...)` rather than services; name the reusable ones with `Effect.fn`.
- No `export namespace`, no `import * as` of Fern modules, and no import aliases.

## Writing effects

- Use `Effect.gen` for inline multi-step code and `Effect.fn('Service.method')` for service methods and named workflows (it adds a span and better stack traces). Use `Effect.fnUntraced` for internal helpers and hot paths. Do not write functions that only return an `Effect.gen`.
- Pass extra combinators to `Effect.fn` as further arguments instead of wrapping it in `.pipe(...)`.
- Fail early with `return yield* new SomeError(...)`.
- Use `Effect.void` rather than `Effect.succeed(undefined)`, `Effect.callback` for callback APIs, and `Effect.cached` when concurrent callers should share one in-flight computation.
- Keep synchronous helpers synchronous: return an `Effect` only when the helper does effectful work.
- Run background loops with `Effect.forever`, `Effect.repeat`, or `Effect.schedule`, forked with `Effect.forkScoped` from the layer that owns them, so disposing the runtime stops them.
- Use `Clock` and `DateTime` instead of `Date.now()` in Effect code that tests may want to control.

## Errors

- Expected failures are `Schema.TaggedError` classes on the error channel. Use `Schema.Defect()` for a field holding an unknown cause.
- `Effect.die` is for defects: bugs, broken invariants, and failures of Fern's own caches that no client can act on. User input, missing files, unreachable shares, and an unavailable database are expected failures.
- Translate external failures at the edge with `Effect.try`, `Effect.tryPromise`, `Effect.mapError`, `Effect.catchTag`, `Effect.catchTags`, and `Effect.catchReason`. Never swallow interruption: check `Cause.hasInterruptsOnly` before recovering from a whole `Cause`.
- Services know nothing about HTTP. Each domain's `http.ts` maps its errors to a `PublicError` with an exhaustive `switch` on `_tag`; routes pass that mapping to `respond` or `runLoad`.

## Platform

- Effect code uses Effect's platform services from `NodeServices.layer`: `FileSystem.FileSystem` instead of `node:fs/promises`, and `ChildProcessSpawner` only through `MediaProcess` (`src/lib/server/media/process.ts`). `node:path` is fine for pure path arithmetic.
- The one exception is `Disk` (`src/lib/server/platform/disk.ts`), which stays on Node's API for typed directory entries and Windows' permission errors; its comment explains why. Don't move it to Effect's `FileSystem` without measuring.
- PostgreSQL is reached through `Database.Service`. Wrap statements in `orUnavailable` so connection failures become `DatabaseUnavailable` and anything else is a defect.
- Settings come from `FernConfig.Service`; services never read `process.env`.

## Runtime boundary

One `ManagedRuntime` (`src/lib/server/runtime.ts`) owns every service. Routes run a program through `respond` or `runLoad` (`src/lib/server/http.ts`); MCP tools and Zero's endpoints run on the same runtime. Services never run effects themselves (no `runPromise` inside services). For a single call at the boundary, use `Foo.Service.use((foo) => foo.bar())` instead of a one-line `Effect.gen`.

## Front end

Svelte and Zero run the browser; Effect runs the server. Client code (`src/lib/client`, `src/lib/components`, `src/lib/music`, `src/lib/zero`, and `.svelte` files) imports only `Schema` and `Option` from Effect:

- Decode untrusted data (API responses, server-sent events, drag-and-drop payloads) with `Schema.decodeUnknownOption` and the contracts in `src/lib/shared/contracts/`. Call the API through `request` and `requestJson` (`src/lib/client/api.ts`), which turn failures into messages users can read.
- Zero query and mutator arguments are validated with `Schema.toStandardSchemaV1`, and those schemas must stay synchronous.
- No `Effect`, `Stream`, `Layer`, or services in the browser: async work is `async`/`await`, state lives in runes, and shared data comes from Zero. Simple values such as a stored volume need plain checks, not a schema.

## Schema

- Validate untrusted data with Effect Schema, decoding at the edge. IDs are branded schemas in `src/lib/shared/contracts/ids.ts`.
- Parse JSON with `Schema.fromJsonString(...)` rather than `JSON.parse` inside `try`/`catch`.
- Use the `Predicate` module instead of hand-written type guards such as `isRecord`.

## Tests

- Test Effect code with `@effect/vitest`: `it.effect` runs with `TestClock`; `it.live` uses the real clock, filesystem, and processes; `layer(...)` shares one layer across a `describe` block (pass `excludeTestServices: true` when its tests need real time).
- Layers are memoized across a `layer(...)` block, including ones a test provides itself: wrap a layer in `Layer.fresh` when a test needs its own instance.
- Build the service under test from its `layer` plus fakes. Use `Layer.mock` for partial stubs, so calling a method the test did not stub fails loudly; shared fakes live in `tests/support/`.
- Keep test bodies in `Effect.gen`. No `ManagedRuntime`, ad hoc `Effect.runPromise` wrappers, or `try`/`catch` around effects; assert failures with `Effect.flip` or `Effect.exit`.
- Wait for a published signal (a `Deferred`, a state change, an event) rather than sleeping.

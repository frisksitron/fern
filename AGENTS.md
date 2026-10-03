# Agent notes

Setup, checks, and commit conventions are in `CONTRIBUTING.md`. This file lists what the code doesn't tell you.

## Workflow

- Rely on Vite hot reload. Don't restart or stop the dev environment unless it is broken or a change needs it (dependency upgrades do), and not just to run e2e tests.
- Don't run checks, tests, or Playwright after every change. Run them when asked, and before a push: then run the relevant checks, and for user-visible changes the relevant Playwright tests, storing current screenshots under `test-results/screenshots/`.
- The dev database holds the user's real library. Never scan all roots or reset it; e2e uses its own Playwright profile and roots under `.cache/e2e/`, and `pnpm test:db` uses disposable databases.
- A push to `main` publishes the Docker image that self-hosters pull. Don't push without being asked.

## Effect

The server uses Effect 4. Don't trust memory of Effect 2 or 3: check `node_modules/effect/AGENTS.md`, the examples in `node_modules/effect/ai-docs/src/`, or the sources in `node_modules/effect/src/`.

Service modules all have the shape of `src/lib/server/media/library.ts`: an `Interface`, a `Service` keyed `@fern/<Name>`, a `layer` that needs its dependencies, a `defaultLayer` that wires the production ones, and `export * as Name from './file'`. Callers import the namespace. Read models that only query the database are plain functions over `query((db) => ...)`, not services.

- Expected failures are `Schema.TaggedError`s; `Effect.die` is only for bugs. Services know nothing about HTTP: each domain's `http.ts` maps its errors to public ones.
- Never swallow interruption: check `Cause.hasInterruptsOnly` before recovering from a whole `Cause`. `Effect.ignore` doesn't catch defects in Effect 4.
- Settings come from `FernConfig`; services don't read `process.env`.
- `Disk` (`src/lib/server/platform/disk.ts`) stays on `node:fs` on purpose; its comment says why.
- Browser code imports only `Schema` and `Option` from Effect, and calls the API through `src/lib/client/api.ts`. Zero's argument schemas must stay synchronous.

Effect 4 traps:

- Service keys are Effects: call one with `Foo.Service.use((foo) => foo.bar())`. There is no `.asEffect()`.
- Point-free `Effect.forever` fails as an `Effect.fn` combinator; write `(effect) => Effect.forever(effect)`.
- `Schema.UnknownFromJsonString` isn't exported; use `Schema.fromJsonString(Schema.Unknown)`.

## Tests

- `@effect/vitest`: `it.effect` runs on `TestClock`, `it.live` on real time. Layers are memoized across a `layer(...)` block, including ones a test provides; wrap one in `Layer.fresh` when a test needs its own instance.
- `Layer.mock` can't stub Drizzle's client; use `noDatabase` from `tests/support/fakes.ts`.
- Shared work (`makeSharedWork` in `src/lib/server/media/work.ts`) keeps running 15 seconds after its last waiter leaves. Tests that expect it to stop at once provide `SharedWorkGrace` as `'0 millis'` or advance `TestClock`.
- Wait for a published signal (a `Deferred`, a state change, an event) rather than sleeping.

# Contributing to Fern

Thanks for helping out. Fern is deliberately small: a fast, filesystem-first LAN media streamer. Before starting a large feature, open an issue to check that it fits.

## Setup

You need Docker with Compose, Node 24, pnpm, and FFmpeg. Postgres and Zero run in Docker; the app runs on the host so Vite can hot-reload.

```sh
pnpm install
pnpm mockmedia
docker compose -f docker-compose.dev.yml up -d postgres --wait
pnpm dbmigrate
docker compose -f docker-compose.dev.yml up -d --wait
pnpm dev
```

Open `http://127.0.0.1:5173`, create a profile, open **Media settings**, add the absolute `mock-media` path, and scan. Stop the app with Ctrl+C and the containers with `docker compose -f docker-compose.dev.yml down`.

Development needs no `.env` file; the defaults point at the dev containers. The server also reads `DATABASE_URL`, `PUBLIC_ZERO_URL`, `HLS_CACHE_DIR`, `THUMBNAIL_CACHE_DIR`, `TRACK_MAP_CACHE_DIR`, `FFMPEG_PATH`, and `FFPROBE_PATH`, which `docker-compose.yml` sets for you; their defaults are in `src/lib/server/config.ts`. To try the production image from the clone, build it under the published name with `docker build -t ghcr.io/frisksitron/fern:latest .`, then run `docker compose up -d`; `docker-compose.yml` deliberately has no `build:` entry, because tools such as Compose Manager, Portainer, and Dockge rebuild any service that has one instead of pulling it.

## Checks and tests

```sh
pnpm format          # Prettier (write); CI runs pnpm format:check
pnpm check           # svelte-check and TypeScript
pnpm test            # unit, path-security, and real ffprobe integration tests
pnpm test:db         # PostgreSQL tests against disposable databases
pnpm build
pnpm e2e             # Playwright against pnpm dev and the dev database
```

`pnpm test` verifies path containment, sorting, playback state/planning, fixture generation, and real ffprobe normalization. It does not need Docker.

`pnpm test:db` needs the dev Postgres container (or `TEST_DATABASE_URL` pointing at a server where the user may create databases). It migrates a fresh template database from empty, clones one database per test file, and drops them afterwards, so it never touches the dev `fern` database or a running dev server.

`pnpm e2e` expects the dev services and `pnpm dev` to already be running. It seeds a Playwright profile and two mock videos into that database.

Before opening a pull request, run everything CI runs: `format:check`, `check`, `test`, `test:db`, `build`, and `e2e`. For user-visible changes, add or update a Playwright test and include screenshots in the pull request. When CI passes on `main`, it publishes the Docker image `ghcr.io/frisksitron/fern` as `latest` and `sha-<commit>`.

## Code organization

| Path                  | Contents                                                                             |
| --------------------- | ------------------------------------------------------------------------------------ |
| `src/routes/`         | SvelteKit pages and API endpoints; thin adapters over server services                |
| `src/lib/server/`     | Server services by domain: library, media, playback, scans, transcoding, MCP, and DB |
| `src/lib/client/`     | Browser state and the typed Zero data boundary                                       |
| `src/lib/components/` | Svelte components                                                                    |
| `src/lib/shared/`     | Code and contracts shared by client and server                                       |
| `src/lib/music/`      | Music domain logic: tracks, playlists, matching, play counts                         |
| `src/lib/zero/`       | Zero schema (generated), named queries, and custom mutators                          |
| `migrations/`         | Drizzle SQL migrations                                                               |
| `tests/`              | `unit`, `integration`, `db`, and `e2e` suites                                        |
| `scripts/`            | Mock media, E2E seeding, and helper scripts                                          |

### Server

The server is built with [Effect](https://effect.website) v4. One `ManagedRuntime` (`src/lib/server/runtime.ts`) owns every service, background fiber, FFmpeg process, and database pool; it starts with the server and is disposed on shutdown. Services are `Context.Service` classes whose `layer` wires their dependencies.

Everything a request does runs as an Effect program on that runtime: API routes through `respond`, page loads through `runLoad`, and MCP tools and Zero's endpoints likewise (`src/lib/server/http.ts`). Route parameters and bodies are decoded with Effect Schema at the edge, and every typed failure maps exhaustively to a public error code or, for pages, a redirect. PostgreSQL is reached through Drizzle v1's Effect driver on `@effect/sql-pg`; connection failures become `DatabaseUnavailable` (`503`), and anything else unexpected is a logged defect (`500`).

`tests/unit/dependency-boundaries.test.ts` enforces a few rules:

- Validate with Effect Schema. Zod is only for the MCP adapter (`src/lib/server/mcp/`).
- Reach PostgreSQL only through the Database service (`src/lib/server/db/service.ts`), except for Zero's mutation pool.
- SvelteKit `redirect` and `error` belong in `src/lib/server/http.ts`, not the server data layer.
- Spawn FFmpeg and ffprobe only through `src/lib/server/media/process-runner.ts`.

### Zero synchronization

PostgreSQL is authoritative. Zero synchronizes only the client-facing profile, media-root, library-display, playlist, playback-progress, and play-count columns listed in the `fern_data` publication. Probe details, tracks, subtitles, scan runs, and scan errors stay server-side because playback and scanning read them through SvelteKit endpoints.

Named queries and replay-safe custom mutators live in `src/lib/zero/`. Svelte components use the typed application boundary in `src/lib/client/zero/data.ts`; that module owns materialized-view cleanup, complete one-shot reads, client-generated IDs, and mutation-result handling. Browse routes server-render a compact initial snapshot so hard refreshes have content on first paint; Zero takes over after hydration.

## Database changes

1. Edit `src/lib/server/db/schema.ts`.
2. Run `pnpm dbgenerate` to create a migration in `migrations/`.
3. If Zero-synced tables or columns changed, run `pnpm zerogenerate` to regenerate `src/lib/zero/schema.ts`, and update the `fern_data` publication in the same migration. `pnpm test:db` fails if the publication and the generated Zero schema disagree.

CI fails if the checked-in migrations or Zero schema don't match the Drizzle schema.

## Style

Prettier formats everything (single quotes, 120 columns). Match the surrounding code's naming, idioms, and comment density.

## Commits

Each commit is one complete change that passes the checks on its own. Generated files belong with the change that caused them: a schema edit, its migration, and the regenerated Zero schema go in the same commit.

Subjects follow [Conventional Commits](https://www.conventionalcommits.org): `type(area): summary`. Write the summary as a lowercase instruction with no period, and keep the whole line under about 72 characters.

```text
feat(music): add shuffle to playlists
fix(scans): stop following symlinks outside the media root
```

| Type       | Use for                                                   |
| ---------- | --------------------------------------------------------- |
| `feat`     | Something new a user can see or do                        |
| `fix`      | A bug fix                                                 |
| `perf`     | Faster or lighter, with the same behavior                 |
| `refactor` | Restructured code, with the same behavior                 |
| `test`     | Tests only                                                |
| `docs`     | Documentation only                                        |
| `build`    | Dependencies, the Dockerfile, and Compose files           |
| `ci`       | GitHub Actions workflows                                  |
| `chore`    | Anything else that doesn't change how Fern runs or builds |

The area is the part of Fern the commit touches, usually named after its folder: `music`, `watch`, `browse`, `settings`, `profiles`, `playback`, `transcoding`, `scans`, `library`, `media-roots`, `zero`, `db`, `mcp`, or `deploy`. Leave it out when a commit spans the whole app.

If the reason for the change isn't obvious from the diff, add a body after a blank line that explains why, wrapped at 72 characters. When a change makes self-hosters do something by hand, such as editing `.env` or their Compose file, mark it with `!` after the area (`feat(deploy)!: ...`) and say what they need to do in a `BREAKING CHANGE:` footer.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

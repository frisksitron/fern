# Fern

Fern streams the movies, shows, and music in your folders to any browser on your home network. It plays your files as they are: no metadata scraping, no renaming, nothing to curate. Everyone in the house gets a profile with their own progress and playlists, and videos the browser can't play are transcoded on the fly.

Fern has no logins, so run it only on a network you trust.

## Self-hosting

You need Docker with Compose. For media on a NAS, mount the share on the host first; Fern only ever reads your files (YouTube downloads go to a folder of their own).

```sh
mkdir fern && cd fern
curl -fsSLO https://raw.githubusercontent.com/frisksitron/fern/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/frisksitron/fern/main/.env.example -o .env
# Edit .env and set MEDIA_PATH to your media folder.
docker compose up -d
```

Open `http://<your server>:8080`, create a profile, then add `/media` under **Media settings** and scan.

To update, run `docker compose pull && docker compose up -d`.

Fern runs as user `fern` (uid 100, gid 101) inside the container. A folder you mount at `/downloads` must be writable by that uid/gid (for example `sudo chown 100:101 /path/to/downloads`); your media folder only needs to be readable. The cache and downloads volumes Compose creates are set up for it already.

### Configuration

Compose reads `.env`. Only `MEDIA_PATH` is required.

| Variable              | Purpose                                                                                                      | Default  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| `MEDIA_PATH`          | Folder with your media, mounted read-only at `/media`                                                        | required |
| `DOWNLOADS_PATH`      | Folder for songs downloaded from YouTube, mounted at `/downloads`; must be writable by uid 100 / gid 101     | a volume |
| `PORT`                | Port Fern is served on                                                                                       | 8080     |
| `FERN_VERSION`        | Image tag of `ghcr.io/frisksitron/fern`: `latest` (follows `main`) or `sha-<commit>`                         | `latest` |
| `POSTGRES_PASSWORD`   | Database password shared by Fern's containers. Postgres isn't reachable from outside the Compose network.    | `fern`   |
| `ZERO_ADMIN_PASSWORD` | Password for zero-cache's admin inspector                                                                    | `fern`   |
| `BROWSE_ROOTS`        | Folders (inside the container) the media picker may show; media roots must be inside one. Separate with `:`. | `/media` |

Tuning:

| Variable                        | Purpose                                                                                         | Default |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| `HLS_CACHE_MAX_BYTES`           | Transcoding cache size target                                                                   | 50 GiB  |
| `HLS_CACHE_MAX_AGE_HOURS`       | Transcoding cache age target                                                                    | 72      |
| `THUMBNAIL_CACHE_MAX_BYTES`     | Progress-thumbnail cache size target                                                            | 1 GiB   |
| `THUMBNAIL_CACHE_MAX_AGE_HOURS` | Progress-thumbnail cache idle-age target                                                        | 168     |
| `TRACK_MAP_CACHE_MAX_BYTES`     | Music-analysis cache size target (for the visual effects)                                       | 256 MiB |
| `TRACK_MAP_CACHE_MAX_AGE_HOURS` | Music-analysis cache idle-age target                                                            | 2160    |
| `MAX_CONCURRENT_TRANSCODES`     | Concurrent on-demand segment transcodes                                                         | 2       |
| `TRANSCODE_MAX_WAITING`         | Segment requests that may wait for a transcode slot; more are answered `503` with `Retry-After` | 8       |
| `TRANSCODE_THREADS`             | CPU threads for each software transcode                                                         | 2       |
| `TRANSCODE_ACCELERATOR`         | H.264 encoder: `auto`, `nvenc`, `qsv`, or `software`                                            | `auto`  |
| `SCAN_PROBE_CONCURRENCY`        | ffprobe processes a scan runs at once                                                           | 4       |
| `LOG_LEVEL`                     | Lowest log level written: `Trace`, `Debug`, `Info`, `Warn`, or `Error`                          | `Info`  |
| `LOG_FORMAT`                    | `json` (one object per line, with fields such as `requestId` and `scanId`) or `pretty`          | `json`  |
| `SHUTDOWN_TIMEOUT`              | Seconds open requests get to finish when Fern stops                                             | 10      |

### YouTube

Paste a YouTube link under **Music → YouTube** and Fern saves the video's audio to its own YouTube library: Opus, as YouTube serves it, with the video's cover and chapters. A DJ set's chapters show as marks on the seek bar and in a chapter list, and previous and next skip between its songs, also from the lock screen. The image includes [yt-dlp](https://github.com/yt-dlp/yt-dlp); YouTube changes often, so if downloads start failing, update Fern.

### Health checks

- `GET /health/live`: the server is running
- `GET /health/ready`: PostgreSQL, FFmpeg, and ffprobe all work, and the cache and downloads folders are writable (`503` with the failing checks otherwise)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

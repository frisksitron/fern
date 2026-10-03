FROM node:24-alpine AS build
RUN npm install --global pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
# yt-dlp saves the audio of YouTube videos. YouTube changes often and breaks older versions, so bump
# this to the latest release (and its yt-dlp_musllinux checksum from SHA2-256SUMS) when downloads fail.
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=f3dec9cfeaf304cec98290fe41c6ad465d4b747d302473559643e7af24929722
ADD --checksum=sha256:${YTDLP_SHA256} --chmod=755 \
  https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_musllinux /usr/local/bin/yt-dlp
# /downloads exists in the image so a named volume mounted there starts out writable by fern.
RUN apk add --no-cache ffmpeg intel-media-driver onevpl-intel-gpu && addgroup -S fern && adduser -S fern -G fern \
  && mkdir /downloads && chown fern:fern /downloads
WORKDIR /app
COPY --from=build --chown=fern:fern /app/build ./build
COPY --from=build --chown=fern:fern /app/node_modules ./node_modules
COPY --from=build --chown=fern:fern /app/package.json ./package.json
COPY --from=build --chown=fern:fern /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=fern:fern /app/migrations ./migrations
COPY --from=build --chown=fern:fern /app/src/lib/server/db/schema.ts ./src/lib/server/db/schema.ts
USER fern
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node","-e","fetch('http://127.0.0.1:3000/health/live').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","build"]

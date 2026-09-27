FROM node:24-alpine AS build
RUN npm install --global pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
RUN apk add --no-cache ffmpeg intel-media-driver onevpl-intel-gpu && addgroup -S fern && adduser -S fern -G fern
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

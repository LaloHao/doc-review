# revision-tesis: the web app (Node, pdf.js). Runs as an unprivileged user with a
# read-only root file system; the only writable path is /data (STORAGE_TYPE=fs
# PDFs, or the embedded PGlite database when DATABASE_URL is not Postgres).

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod && find node_modules -name "*.map" -delete

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
RUN useradd --uid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown 10001 /data
USER 10001
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=America/Mexico_City
EXPOSE 8080
HEALTHCHECK NONE
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]

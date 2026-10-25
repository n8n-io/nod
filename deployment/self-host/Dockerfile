FROM docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32 AS docker

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN pnpm exec vite build && pnpm prune --prod && pnpm store prune

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node deployment/self-host/healthcheck.mjs ./healthcheck.mjs
RUN mkdir -p /var/lib/nod/workspaces && chown -R node:node /var/lib/nod
USER node
ENV NODE_ENV=production
ENV NOD_ENVIRONMENT=production
ENV NOD_DATA_ROOT=/var/lib/nod
ENV NOD_HOST=0.0.0.0
EXPOSE 4310
CMD ["node", "--import", "tsx", "src/server/index.ts"]

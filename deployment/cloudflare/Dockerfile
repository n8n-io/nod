FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npx vite build

FROM node:24.21.0-bookworm-slim
WORKDIR /app
ARG OTTO_RELEASE=local
ENV OTTO_RELEASE=$OTTO_RELEASE
ENV OTTO_IMAGE_RELEASE=$OTTO_RELEASE
ENV NODE_ENV=production PORT=4310 HOST=0.0.0.0 OTTO_DATA_ROOT=/data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4310
CMD ["node", "--import", "tsx", "src/server/index.ts"]

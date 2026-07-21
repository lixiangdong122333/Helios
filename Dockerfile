# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HELIOS_TRANSPORT=http

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 48080
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "http"]

FROM node:22.22.0-bookworm-slim AS node-binary

# Shared dependency cache. This stage never ships in a runtime image.
FROM node-binary AS dependencies
WORKDIR /connect
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Backend compilation is independent of frontend assets and public base path.
FROM dependencies AS server-build
COPY tsconfig.json ./
COPY apps/api ./apps/api
COPY apps/runner/src ./apps/runner/src
COPY packages/sdk ./packages/sdk
COPY scripts/build-runtime.mjs scripts/setup-admin.mjs scripts/identity-proof-profile.mjs ./scripts/
RUN npm run build:runtime

FROM dependencies AS web-build
ARG EULAB_ADMIN_BASE_PATH=/
ENV EULAB_ADMIN_BASE_PATH=${EULAB_ADMIN_BASE_PATH}
COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY apps/demo/src ./apps/demo/src
COPY packages/sdk ./packages/sdk
COPY assets/brand ./assets/brand
COPY plugins/wordpress/eulab-connect ./plugins/wordpress/eulab-connect
COPY scripts/sync-brand.mjs scripts/build-wordpress-installer.mjs ./scripts/
COPY scripts/wordpress-installer ./scripts/wordpress-installer
RUN npm run brand:sync && npx tsc -p apps/web/tsconfig.json && npx vite build --config apps/web/vite.config.ts && node scripts/build-wordpress-installer.mjs

# Fresh production install: no compiler, test/browser tooling or React runtime.
FROM node-binary AS production-dependencies
WORKDIR /connect
COPY package.json package-lock.json ./
COPY scripts/prune-runtime-deps.mjs /tmp/prune-runtime-deps.mjs
RUN npm ci --omit=dev --no-audit --no-fund && node /tmp/prune-runtime-deps.mjs /connect/node_modules

FROM node-binary AS provider-dependencies
WORKDIR /opt/openwa
COPY apps/runner/package.json apps/runner/package-lock.json apps/runner/.npmrc ./
COPY scripts/prune-runtime-deps.mjs /tmp/prune-runtime-deps.mjs
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev --omit=peer --no-audit --no-fund && node /tmp/prune-runtime-deps.mjs /opt/openwa/node_modules

# Only the Node executable is copied: npm, npx, Yarn and build tools stay behind.
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /usr/sbin/nologin --create-home node
COPY --from=node-binary /usr/local/bin/node /usr/local/bin/node
WORKDIR /connect
ENV NODE_ENV=production
USER node

FROM runtime-base AS server-runtime
COPY --from=production-dependencies /connect/node_modules ./node_modules

FROM server-runtime AS api
COPY --from=server-build /connect/dist/runtime/api.mjs ./api.mjs
CMD ["node","api.mjs"]

FROM server-runtime AS bootstrap
COPY --from=server-build /connect/dist/runtime/bootstrap.mjs ./bootstrap.mjs
CMD ["node","bootstrap.mjs"]

FROM server-runtime AS migrate
COPY --from=server-build /connect/dist/runtime/migrate.mjs ./migrate.mjs
COPY infra/postgres ./infra/postgres
CMD ["node","migrate.mjs"]

FROM server-runtime AS runner-base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium zstd zip unzip && rm -rf /var/lib/apt/lists/*
COPY --from=provider-dependencies /opt/openwa/node_modules /opt/openwa/node_modules
RUN ln -s /opt/openwa/node_modules/@eulab /connect/node_modules/@eulab \
 && ln -s /opt/openwa/node_modules/qrcode /connect/node_modules/qrcode \
 && mkdir /profiles && chown node:node /profiles
ENV CHROMIUM_PATH=/usr/bin/chromium OPENWA_PROFILE_DIR=/profiles
USER node

FROM runner-base AS runner
COPY --from=server-build /connect/dist/runtime/runner.mjs ./runner.mjs
CMD ["node","runner.mjs"]

FROM nginx:1.28.0-alpine AS web
COPY --from=web-build /connect/dist/web /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf

FROM nginx:1.28.0-alpine AS web-production
COPY --from=web-build /connect/dist/web /usr/share/nginx/html/admin
COPY infra/production/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY infra/production/web-config.js /usr/share/nginx/html/admin/config.js

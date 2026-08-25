# DeepSeek Harness plugin migrator. Build context is the repo root.
# Pins: Node 24 (dsh needs >=22.19), @deepseek-ai/dsh CLI, anchored-standard modes.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_CLI_VERSION=0.1.1-rc.2
# Optional file:// or https:// tarball if npm does not publish this rc.
ARG DSH_TARBALL=
ARG DEBIAN_MIRROR=
ARG NPM_REGISTRY=

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN set -eux; \
  if [ -n "$DEBIAN_MIRROR" ]; then \
    sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends git ca-certificates python3 make g++; \
  rm -rf /var/lib/apt/lists/*

# Global dsh + modes change rarely; keep them above COPY src so CLI edits rebuild quickly.
RUN set -eux; \
  if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
  if [ -n "$DSH_TARBALL" ]; then \
    npm install -g --omit=dev "$DSH_TARBALL"; \
  else \
    npm install -g --omit=dev "@deepseek-ai/dsh@${DSH_CLI_VERSION}"; \
  fi

RUN git clone --depth 1 https://github.com/xiaobright/dsh-anchored-standard.git /opt/dsh-anchored-standard

WORKDIR /opt/dsh-migrate
COPY package.json package-lock.json tsconfig.json ./
RUN set -eux; \
  if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
  if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY src ./src
COPY container ./container

RUN set -eux; \
  npm run build; \
  npm prune --omit=dev; \
  chmod +x /opt/dsh-migrate/container/setup-profile.sh /opt/dsh-migrate/container/entrypoint.sh; \
  DSH_HOME=/opt/dsh-home DSH_ANCHORED_STANDARD=/opt/dsh-anchored-standard \
    /opt/dsh-migrate/container/setup-profile.sh; \
  ln -sf /opt/dsh-migrate/dist/src/cli.js /usr/local/bin/dsh-migrate; \
  chmod +x /opt/dsh-migrate/dist/src/cli.js /opt/dsh-migrate/container/entrypoint.sh

ENV DSH_HOME=/opt/dsh-home
ENV DSH_MIGRATE_APP_ROOT=/opt/dsh-migrate
ENV DSH_ANCHORED_STANDARD=/opt/dsh-anchored-standard

WORKDIR /github/workspace
ENTRYPOINT ["/opt/dsh-migrate/container/entrypoint.sh"]

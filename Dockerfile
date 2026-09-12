# DeepSeek Harness plugin migrator. Build context is the repo root.
# Pins: Node 24 (dsh needs >=22.19), @deepseek-ai/dsh CLI.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_CLI_VERSION=0.1.1-rc.2
# Optional file:// or https:// tarball if npm does not publish this rc.
ARG DSH_TARBALL=
ARG DEBIAN_MIRROR=
ARG NPM_REGISTRY=
# Optional browser-download mirror (Playwright honors it as an env var).
ARG PLAYWRIGHT_DOWNLOAD_HOST=

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# apt's defaults assume a fast, reliable route: one attempt with short timeouts,
# which turns a momentarily slow mirror into a failed build. Raise its own retry
# and timeout budget before the first fetch — apt's documented knobs, not a
# security bypass.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "120";\nAcquire::https::Timeout "120";\n' \
      > /etc/apt/apt.conf.d/99-network-resilience

RUN set -eux; \
  if [ -n "$DEBIAN_MIRROR" ]; then \
    sed -i "s|http://deb.debian.org/debian|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends git ca-certificates python3 make g++; \
  rm -rf /var/lib/apt/lists/*

# Global dsh changes rarely; keep it above COPY src so CLI edits rebuild quickly.
RUN set -eux; \
  if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
  if [ -n "$DSH_TARBALL" ]; then \
    npm install -g --omit=dev "$DSH_TARBALL"; \
  else \
    npm install -g --omit=dev "@deepseek-ai/dsh@${DSH_CLI_VERSION}"; \
  fi

# Headless Chromium for the agent-authored end-to-end suite. Browsers live in a
# shared path so a plugin's own playwright resolves them without re-downloading;
# the system libraries come from --with-deps.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eux; \
  npm install -g playwright@1.61.1; \
  if [ -n "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi; \
  apt-get update; \
  playwright install --with-deps chromium || playwright install --with-deps chromium; \
  rm -rf /var/lib/apt/lists/*

# The community upgrade knowledge, pinned to the same commit this repository's
# vendor/dsh-plugin-upgrade-skill submodule pins. It is cloned rather than
# copied from the submodule because a Docker action's build context does not
# carry submodules. scripts/verify-skills-pin.ts fails when the two drift.
ARG UPGRADE_SKILL_COMMIT=ecab245c6c1831c51b0240aca13573b94a6e525e
RUN git clone --filter=blob:none --no-checkout https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill.git /opt/dsh-migrate/vendor/upgrade-skill \
  && git -C /opt/dsh-migrate/vendor/upgrade-skill fetch --depth 1 origin "$UPGRADE_SKILL_COMMIT" \
  && git -C /opt/dsh-migrate/vendor/upgrade-skill checkout --detach FETCH_HEAD \
  && rm -rf /opt/dsh-migrate/vendor/upgrade-skill/.git

WORKDIR /opt/dsh-migrate
COPY package.json package-lock.json tsconfig.json ./
RUN set -eux; \
  if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
  if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY src ./src
COPY container ./container

# typescript is a runtime dependency so mechanical typecheck can use the
# bundled tsc. Plugins without a local compiler must not fall through to
# `npx tsc` (the unrelated placeholder package). prune keeps production deps.
RUN set -eux; \
  npm run build; \
  npm prune --omit=dev; \
  chmod +x /opt/dsh-migrate/container/setup-profile.sh /opt/dsh-migrate/container/entrypoint.sh; \
  DSH_HOME=/opt/dsh-home /opt/dsh-migrate/container/setup-profile.sh; \
  ln -sf /opt/dsh-migrate/dist/src/cli.js /usr/local/bin/dsh-migrate; \
  chmod +x /opt/dsh-migrate/dist/src/cli.js /opt/dsh-migrate/container/entrypoint.sh

ENV DSH_HOME=/opt/dsh-home
ENV DSH_MIGRATE_APP_ROOT=/opt/dsh-migrate

WORKDIR /github/workspace
ENTRYPOINT ["/opt/dsh-migrate/container/entrypoint.sh"]

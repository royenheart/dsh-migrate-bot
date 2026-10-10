# The preview image: one pinned dsh and the launcher that starts a preview's
# two `dsh web` processes. The build context is this directory:
#
#   docker build --build-arg DSH_VERSION=0.2.0-rc.2 -t dsh-migrate-preview:0.2.0-rc.2 deploy-service/preview-image
#
# The tag names the dsh version, so DSH_IMAGE pins what every preview runs.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.2.0-rc.2
ARG NPM_REGISTRY=

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends git ca-certificates; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dsh
RUN set -eux; \
  if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
  npm install --prefix /opt/dsh --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}"; \
  npm cache clean --force; \
  /opt/dsh/node_modules/.bin/dsh --version

COPY launcher.mjs /opt/dsh-preview/launcher.mjs

ENV DSH_BIN=/opt/dsh/node_modules/.bin/dsh \
    DSH_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
LABEL org.opencontainers.image.description="dsh-migrate preview instance: dsh ${DSH_VERSION} and the preview launcher"
# The service passes --user; this is the default for a container started by hand.
USER node
WORKDIR /plugin
ENTRYPOINT ["node", "/opt/dsh-preview/launcher.mjs"]
CMD ["serve"]

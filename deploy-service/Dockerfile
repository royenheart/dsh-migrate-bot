# The reference deploy service. The build context is the repository root,
# because the service compiles the Action's own client modules from src/:
#
#   docker build -f deploy-service/Dockerfile -t dsh-migrate-deploy-service .
#
# The image holds the service and the Docker CLI; the preview image
# (preview-image/Dockerfile) is built separately and named by DSH_IMAGE.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS build
WORKDIR /opt/dsh-migrate
# The root manifest only for `"type": "module"`, which is how TypeScript reads src/.
COPY package.json ./package.json
COPY src ./src
COPY deploy-service/package.json deploy-service/package-lock.json ./deploy-service/
RUN npm --prefix deploy-service ci --no-fund --no-audit
COPY deploy-service ./deploy-service
RUN npm --prefix deploy-service run build && npm --prefix deploy-service prune --omit=dev

FROM ${NODE_IMAGE}
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends git ca-certificates; \
  rm -rf /var/lib/apt/lists/*
# The CLI only: the daemon is the host's, reached through the socket that
# compose.yaml mounts into this container and into no other.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/deploy-service
COPY --from=build /opt/dsh-migrate/deploy-service/package.json ./package.json
COPY --from=build /opt/dsh-migrate/deploy-service/node_modules ./node_modules
COPY --from=build /opt/dsh-migrate/deploy-service/dist ./dist
COPY deploy-service/preview-image/launcher.mjs ./preview-image/launcher.mjs
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? '8080') + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/deploy-service/dist/src/main.js"]

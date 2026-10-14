FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# The plugin's package manager, which the verifier installs it with.
RUN npm install -g pnpm@11.24.0

# The target release, with the dependencies it had when the author migrated.
RUN npm install -g --before=2026-09-10T09:54:39Z @deepseek-ai/dsh@0.1.5-rc.1

WORKDIR /app
COPY fixture /app/fixture
RUN git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -q -m baseline

FROM node:24-bookworm

# ripgrep: the plugin's build gate (scripts/check-harness-compat.mjs) lists Harness sources with rg.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The target release, with the dependencies it had when the author migrated.
RUN npm install -g --before=2026-09-24T18:45:44Z @deepseek-ai/dsh@0.1.7-rc.2

# The Harness source of the target release, which the plugin's build compares its recorded baseline against.
RUN git clone -q --depth 1 --branch dsh-v0.1.7-rc.2 https://github.com/deepseek-ai/deepseek-harness /opt/deepseek-harness \
    && test "$(git -C /opt/deepseek-harness rev-parse HEAD)" = 477b4f420553e8a52c2fbccc464d7561b239c443 \
    && rm -rf /opt/deepseek-harness/.git
ENV DSHX_HARNESS=/opt/deepseek-harness

WORKDIR /app
COPY fixture /app/fixture
RUN git init -q && git add -A && git -c user.email=bench@local -c user.name=bench commit -q -m baseline

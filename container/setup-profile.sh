#!/usr/bin/env bash
# Install the migrate profile into $DSH_HOME.
set -euo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$DSH_HOME/profiles/migrate"
cp -R "$ROOT/container/profile/." "$DSH_HOME/profiles/migrate/"

# Home-level fallback if the process env is unset (first boot / dump-config).
cat > "$DSH_HOME/settings.yaml" <<'EOF'
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max
llm-deepseek:
  thinking: enabled
  reasoningEffort: max
EOF

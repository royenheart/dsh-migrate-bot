#!/usr/bin/env bash
# Install the migrate profile and anchored-standard modes into $DSH_HOME.
set -euo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRESET_SRC="${DSH_ANCHORED_STANDARD:-/opt/dsh-anchored-standard}"

mkdir -p "$DSH_HOME/profiles/migrate" "$DSH_HOME/.agent-presets"
cp -R "$ROOT/container/profile/." "$DSH_HOME/profiles/migrate/"

install_mode() {
  local src="$1"
  local dest_id="$2"
  if [[ -d "$src" ]]; then
    mkdir -p "$DSH_HOME/.agent-presets/$dest_id"
    cp -R "$src/." "$DSH_HOME/.agent-presets/$dest_id/"
  fi
}

if [[ -d "$PRESET_SRC/preset" ]]; then
  install_mode "$PRESET_SRC/preset" anchored-standard
  install_mode "$PRESET_SRC/zero-anchored-standard" zero-anchored-standard
  install_mode "$PRESET_SRC/whoami-standard" whoami-standard
  install_mode "$PRESET_SRC/eternal-minimal" eternal-minimal
  install_mode "$PRESET_SRC/wire-think-standard" wire-think-standard
  install_mode "$PRESET_SRC/combo-anchored" combo-anchored
else
  echo "dsh-migrate: anchored-standard sources missing at $PRESET_SRC (agent mode mount will be skipped)" >&2
fi

if [[ ! -d "$DSH_HOME/.agent-presets/anchored-standard" ]]; then
  echo "dsh-migrate: warning: preset id 'anchored-standard' was not installed" >&2
fi

# Home-level fallback if the process env is unset (first boot / dump-config).
cat > "$DSH_HOME/settings.yaml" <<'EOF'
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
  reasoningEffort: max
llm-deepseek:
  thinking: enabled
  reasoningEffort: max
agent-presets:
  default: anchored-standard
EOF

#!/usr/bin/env bash
# Map GitHub Action INPUT_* env vars onto the CLI. Local docker runs can pass
# `run|check-config` args directly; those win over INPUT_*.
set -euo pipefail

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
if [[ -d "$workspace" ]]; then
  cd "$workspace"
fi

if command -v git >/dev/null 2>&1; then
  git config --global --add safe.directory "$workspace" >/dev/null 2>&1 || true
  git config --global --add safe.directory '*' >/dev/null 2>&1 || true
fi

export DSH_HOME="${DSH_HOME:-/opt/dsh-home}"
export DSH_MIGRATE_APP_ROOT="${DSH_MIGRATE_APP_ROOT:-/opt/dsh-migrate}"
export DSH_MIGRATE_HOME="${DSH_MIGRATE_HOME:-$workspace/.dsh-migrate}"

args=("$@")
if [[ ${#args[@]} -eq 0 || ( "${args[0]}" != run && "${args[0]}" != check-config ) ]]; then
  args=(run "${args[@]}")
fi

resolve_workdir() {
  local input="${INPUT_WORKDIR:-.}"
  if [[ "$input" = /* ]]; then
    printf '%s\n' "$input"
    return
  fi
  printf '%s\n' "$workspace/$input"
}

if [[ ! " ${args[*]} " =~ " --workdir " ]]; then
  workdir="$(resolve_workdir)"
  args+=(--workdir "$workdir")
fi

if [[ -n "${INPUT_CONFIG:-}" && ! " ${args[*]} " =~ " --config " ]]; then
  args+=(--config "$INPUT_CONFIG")
fi
if [[ -n "${INPUT_DSH_VERSION:-}" && ! " ${args[*]} " =~ " --dsh-version " ]]; then
  args+=(--dsh-version "$INPUT_DSH_VERSION")
fi
if [[ -n "${INPUT_API_KEY_ENV:-}" && ! " ${args[*]} " =~ " --api-key-env " ]]; then
  args+=(--api-key-env "$INPUT_API_KEY_ENV")
fi
if [[ "${INPUT_MECHANICAL_ONLY:-false}" == [Tt]rue ]]; then
  if [[ ! " ${args[*]} " =~ " --mechanical-only " ]]; then
    args+=(--mechanical-only)
  fi
fi
if [[ "${INPUT_SKIP_GITHUB:-false}" == [Tt]rue ]]; then
  if [[ ! " ${args[*]} " =~ " --skip-github " ]]; then
    args+=(--skip-github)
  fi
fi
if [[ "${INPUT_FORCE:-false}" == [Tt]rue ]]; then
  if [[ ! " ${args[*]} " =~ " --force " ]]; then
    args+=(--force)
  fi
fi

cli="${DSH_MIGRATE_CLI:-/opt/dsh-migrate/dist/src/cli.js}"
exec node "$cli" "${args[@]}"

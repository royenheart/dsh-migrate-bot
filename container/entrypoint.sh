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
if [[ ${#args[@]} -eq 0 || ( "${args[0]}" != run && "${args[0]}" != check-config && "${args[0]}" != refresh-badge && "${args[0]}" != feedback && "${args[0]}" != command ) ]]; then
  args=(run "${args[@]}")
fi
if [[ "${INPUT_REFRESH_ONLY:-false}" == [Tt]rue ]]; then
  args=(refresh-badge)
fi
if [[ "${INPUT_FEEDBACK_ONLY:-false}" == [Tt]rue ]]; then
  args=(feedback)
fi
if [[ "${INPUT_COMMENT_COMMAND:-false}" == [Tt]rue ]]; then
  args=(command)
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
if [[ "${INPUT_ALLOW_SECOND_PULL_REQUEST:-false}" == [Tt]rue ]]; then
  if [[ ! " ${args[*]} " =~ " --allow-second-pr " ]]; then
    args+=(--allow-second-pr)
  fi
fi
if [[ "${INPUT_FEEDBACK_RESEND:-false}" == [Tt]rue ]]; then
  if [[ ! " ${args[*]} " =~ " --resend " ]]; then
    args+=(--resend)
  fi
fi
if [[ -n "${INPUT_QUOTA_LIMIT:-}" && ! " ${args[*]} " =~ " --quota-limit " ]]; then
  args+=(--quota-limit "$INPUT_QUOTA_LIMIT")
fi
if [[ -n "${INPUT_PULL_REQUEST:-}" && ! " ${args[*]} " =~ " --pull-request " ]]; then
  args+=(--pull-request "$INPUT_PULL_REQUEST")
fi
if [[ -n "${INPUT_COMMENT_BODY:-}" && ! " ${args[*]} " =~ " --comment-body " ]]; then
  args+=(--comment-body "$INPUT_COMMENT_BODY")
fi
if [[ -n "${INPUT_COMMENT_ID:-}" && ! " ${args[*]} " =~ " --comment-id " ]]; then
  args+=(--comment-id "$INPUT_COMMENT_ID")
fi
if [[ -n "${INPUT_COMMENT_AUTHOR:-}" && ! " ${args[*]} " =~ " --comment-author " ]]; then
  args+=(--comment-author "$INPUT_COMMENT_AUTHOR")
fi
if [[ -n "${INPUT_COMMENT_AUTHOR_ASSOCIATION:-}" && ! " ${args[*]} " =~ " --comment-author-association " ]]; then
  args+=(--comment-author-association "$INPUT_COMMENT_AUTHOR_ASSOCIATION")
fi
if [[ -n "${INPUT_ISSUE_NUMBER:-}" && ! " ${args[*]} " =~ " --issue-number " ]]; then
  args+=(--issue-number "$INPUT_ISSUE_NUMBER")
fi

cli="${DSH_MIGRATE_CLI:-/opt/dsh-migrate/dist/src/cli.js}"
exec node "$cli" "${args[@]}"

#!/usr/bin/env bash
# The Action's entrypoint: run the CLI with the Action inputs (the INPUT_*
# variables GitHub sets) as arguments. Arguments given to `docker run` are
# passed through unchanged instead.
set -euo pipefail

workspace="${GITHUB_WORKSPACE:-$PWD}"
git config --global --add safe.directory '*'
export DSH_HOME="${DSH_HOME:-/opt/dsh-home}"
export DSH_MIGRATE_APP_ROOT="${DSH_MIGRATE_APP_ROOT:-/opt/dsh-migrate}"
export DSH_MIGRATE_HOME="${DSH_MIGRATE_HOME:-$workspace/.dsh-migrate}"
cli="${DSH_MIGRATE_CLI:-$DSH_MIGRATE_APP_ROOT/dist/src/cli.js}"

if [[ $# -gt 0 ]]; then
  exec node "$cli" "$@"
fi

workdir="${INPUT_WORKDIR:-.}"
[[ "$workdir" = /* ]] || workdir="$workspace/$workdir"
args=("${INPUT_COMMAND:-run}" --workdir "$workdir")
# `--name=value`: a value that starts with `-`, such as a comment beginning with a list item, stays a value.
option() { if [[ -n "${2:-}" ]]; then args+=("$1=$2"); fi; }
flag() { if [[ "${2:-false}" == [Tt]rue ]]; then args+=("$1"); fi; }
option --config "${INPUT_CONFIG:-}"
option --target "${INPUT_TARGET:-}"
flag --force "${INPUT_FORCE:-}"
flag --skip-github "${INPUT_SKIP_GITHUB:-}"
option --number "${INPUT_PULL_REQUEST:-}"
option --merged "${INPUT_MERGED:-}"
option --body "${INPUT_COMMENT_BODY:-}"
option --comment-id "${INPUT_COMMENT_ID:-}"
option --author "${INPUT_COMMENT_AUTHOR:-}"
option --association "${INPUT_COMMENT_AUTHOR_ASSOCIATION:-}"
option --issue "${INPUT_ISSUE_NUMBER:-}"
exec node "$cli" "${args[@]}"

#!/bin/sh
set -eu

: "${CC_VALIDATION_REPO_ROOT:?missing CC_VALIDATION_REPO_ROOT}"
: "${CC_VALIDATION_EVIDENCE_DIR:?missing CC_VALIDATION_EVIDENCE_DIR}"
: "${CC_VALIDATION_CONFIG_DIR:?missing CC_VALIDATION_CONFIG_DIR}"
: "${CC_VALIDATION_HOME:?missing CC_VALIDATION_HOME}"


if [ "${CC_VALIDATION_RETAIN_ARTIFACTS:-0}" = "1" ] || [ -n "${CC_VALIDATION_RUN_ROOT:-}" ]; then
  case "${CC_VALIDATION_FRAME_BROKER_DIR:-}" in
    '') ;;
    *) printf '%s\n' 'broker capture is unavailable in retained launcher mode' >&2; exit 2 ;;
  esac
  : "${CC_VALIDATION_RUN_ROOT:?missing CC_VALIDATION_RUN_ROOT}"
  : "${CC_VALIDATION_BINARY:?missing CC_VALIDATION_BINARY}"
  : "${CC_VALIDATION_CWD:?missing CC_VALIDATION_CWD}"
  : "${CC_VALIDATION_OPENAI_BASE_URL:?missing controlled provider}"
  for path in "$CC_VALIDATION_HOME" "$CC_VALIDATION_CONFIG_DIR" "$CC_VALIDATION_CWD" "$CC_VALIDATION_EVIDENCE_DIR"; do
    case "$path" in
      "$CC_VALIDATION_RUN_ROOT"/*) ;;
      *) printf '%s\n' 'retained path outside run root' >&2; exit 2 ;;
    esac
  done
  for path in "${CC_VALIDATION_FRAME_EVIDENCE_PATH:-}"; do
    [ -z "$path" ] && continue
    case "$path" in
      *'/../'*|*'/./'*|*'/..'|*'/.') printf '%s\n' 'retained frame path contains traversal' >&2; exit 2 ;;
      "$CC_VALIDATION_RUN_ROOT"/*) ;;
      *) printf '%s\n' 'retained frame path outside run root' >&2; exit 2 ;;
    esac
  done
  saved_ifs=$IFS
  IFS=:
  set -f
  for path in ${CC_VALIDATION_PLUGIN_DIRS:-}; do
    case "$path" in
      *'/../'*|*'/./'*|*'/..'|*'/.') printf '%s\n' 'retained plugin path contains traversal' >&2; exit 2 ;;
      "$CC_VALIDATION_RUN_ROOT"/*) ;;
      *) printf '%s\n' 'retained plugin path outside run root' >&2; exit 2 ;;
    esac
  done
  IFS=$saved_ifs
  case "${CC_VALIDATION_SKIP_PERMISSIONS:-0}" in
    0) set -- --dangerously-skip-permissions "$@" ;;
    1) ;;
    *) printf '%s\n' 'invalid retained permission mode' >&2; exit 2 ;;
  esac
  cd "$CC_VALIDATION_CWD"
  exec env -i \
    HOME="$CC_VALIDATION_HOME" CLAUDE_CONFIG_DIR="$CC_VALIDATION_CONFIG_DIR" \
    XDG_CACHE_HOME="$CC_VALIDATION_HOME/.cache" \
    XDG_CONFIG_HOME="$CC_VALIDATION_HOME/.config" \
    XDG_DATA_HOME="$CC_VALIDATION_HOME/.local/share" \
    TMPDIR="$CC_VALIDATION_RUN_ROOT/tmp" TMP="$CC_VALIDATION_RUN_ROOT/tmp" \
    TEMP="$CC_VALIDATION_RUN_ROOT/tmp" CLAUDE_CODE_TMPDIR="$CC_VALIDATION_RUN_ROOT/tmp" \
    PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/sh \
    TERM=xterm-256color LANG=en_US.UTF-8 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    CLAUDE_CODE_USE_OPENAI=1 OPENAI_BASE_URL="$CC_VALIDATION_OPENAI_BASE_URL" \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1 \
    CLAUDE_CODE_FRAME_EVIDENCE_PATH="${CC_VALIDATION_FRAME_EVIDENCE_PATH:-}" \
    CLAUDE_CODE_PLUGIN_DIRS="${CC_VALIDATION_PLUGIN_DIRS:-}" \
    "$CC_VALIDATION_BINARY" \
    --debug --debug-file "$CC_VALIDATION_EVIDENCE_DIR/debug.log" "$@"
fi

if [ -n "${CC_VALIDATION_FRAME_BROKER_DIR:-}" ]; then
  # This capture owns a native executable, never the launcher or an env wrapper.
  # Retained mode has a separate launch contract and must not silently drop it.
  case "${CC_VALIDATION_RETAIN_ARTIFACTS:-0}:${CC_VALIDATION_RUN_ROOT:-}" in
    0:) ;;
    *) printf '%s\n' 'broker capture is unavailable in retained launcher mode' >&2; exit 2 ;;
  esac
  : "${CC_VALIDATION_FRAME_CAPTURE_ID:?missing capture identity}"
  : "${CC_VALIDATION_FRAME_BINARY_SHA256:?missing native binary hash}"
  /usr/bin/python3 "$CC_VALIDATION_REPO_ROOT/scripts/terminal-capture-launch-check.py"
fi

cd "${CC_VALIDATION_CWD:-$CC_VALIDATION_REPO_ROOT}"
set -- env -i \
  HOME="$CC_VALIDATION_HOME" \
  CLAUDE_CONFIG_DIR="$CC_VALIDATION_CONFIG_DIR" \
  XDG_CACHE_HOME="$CC_VALIDATION_HOME/.cache" \
  XDG_CONFIG_HOME="$CC_VALIDATION_HOME/.config" \
  XDG_DATA_HOME="$CC_VALIDATION_HOME/.local/share" \
  TMPDIR="${CC_VALIDATION_TMPDIR:-${TMPDIR:-/private/tmp}}" \
  TMP="${CC_VALIDATION_TMPDIR:-${TMPDIR:-/private/tmp}}" \
  TEMP="${CC_VALIDATION_TMPDIR:-${TMPDIR:-/private/tmp}}" \
  CLAUDE_CODE_TMPDIR="${CC_VALIDATION_TMPDIR:-${TMPDIR:-/private/tmp}}" \
  PATH="${CC_VALIDATION_PATH_PREFIX:+$CC_VALIDATION_PATH_PREFIX:}${CC_VALIDATION_SSH_BIN:+$CC_VALIDATION_SSH_BIN:}${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
  SHELL="${SHELL:-/bin/sh}" \
  USER="${USER:-}" \
  LANG="${LANG:-en_US.UTF-8}" \
  TERM="${TERM:-xterm-256color}" \
  HTTP_PROXY="${CC_VALIDATION_HTTP_PROXY:-${HTTP_PROXY:-}}" \
  HTTPS_PROXY="${CC_VALIDATION_HTTPS_PROXY:-${HTTPS_PROXY:-}}" \
  ALL_PROXY="${CC_VALIDATION_ALL_PROXY:-${ALL_PROXY:-}}" \
  NO_PROXY="${CC_VALIDATION_NO_PROXY:-${NO_PROXY:-}}" \
  http_proxy="${CC_VALIDATION_HTTP_PROXY:-${http_proxy:-}}" \
  https_proxy="${CC_VALIDATION_HTTPS_PROXY:-${https_proxy:-}}" \
  all_proxy="${CC_VALIDATION_ALL_PROXY:-${all_proxy:-}}" \
  no_proxy="${CC_VALIDATION_NO_PROXY:-${no_proxy:-}}" \
  CLAUDE_CODE_USE_OPENAI="${CC_VALIDATION_USE_OPENAI:-1}" \
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK="${CC_VALIDATION_DISABLE_NONSTREAMING_FALLBACK:-}" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CC_VALIDATION_DISABLE_NONESSENTIAL_TRAFFIC:-}" \
  CLAUDE_CODE_MAX_RETRIES="${CC_VALIDATION_MAX_RETRIES:-}" \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CC_VALIDATION_AGENT_TEAMS:-}" \
  CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING="${CC_VALIDATION_WORKFLOW_FAULT_INJECTION:-}" \
  CLAUDE_CODE_RUN_AGENT_FAULT_INJECTION_FOR_TESTING="${CC_VALIDATION_RUN_AGENT_FAULT_INJECTION:-}" \
  CLAUDE_CODE_FRAME_EVIDENCE_PATH="${CC_VALIDATION_FRAME_EVIDENCE_PATH:-}" \
  CLAUDE_CODE_FRAME_BROKER_DIR="${CC_VALIDATION_FRAME_BROKER_DIR:-}" \
  CLAUDE_CODE_FRAME_CAPTURE_ID="${CC_VALIDATION_FRAME_CAPTURE_ID:-}" \
  CLAUDE_CODE_FRAME_BINARY_SHA256="${CC_VALIDATION_FRAME_BINARY_SHA256:-}" \
  CLAUDE_CODE_NO_FLICKER="${CC_VALIDATION_NO_FLICKER:-}" \
  CC_VALIDATION_SSH_IO="${CC_VALIDATION_SSH_IO:-}" \
  CC_VALIDATION_SSH_BIN="${CC_VALIDATION_SSH_BIN:-}" \
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1

if [ -n "${CC_VALIDATION_FORK_SUBAGENT:-}" ]; then
  case "$CC_VALIDATION_FORK_SUBAGENT" in
    0|1) set -- "$@" CLAUDE_CODE_FORK_SUBAGENT="$CC_VALIDATION_FORK_SUBAGENT" ;;
    *) printf '%s\n' 'invalid fork mode' >&2; exit 2 ;;
  esac
fi

if [ -n "${CC_VALIDATION_OPENAI_BASE_URL:-}" ]; then
  set -- "$@" OPENAI_BASE_URL="$CC_VALIDATION_OPENAI_BASE_URL"
fi

if [ -n "${CC_VALIDATION_ANTHROPIC_BASE_URL:-}" ]; then
  set -- "$@" ANTHROPIC_BASE_URL="$CC_VALIDATION_ANTHROPIC_BASE_URL"
fi

if [ -n "${CC_VALIDATION_ANTHROPIC_API_KEY:-}" ]; then
  set -- "$@" ANTHROPIC_API_KEY="$CC_VALIDATION_ANTHROPIC_API_KEY"
fi

if [ -n "${CC_VALIDATION_LOCAL_OAUTH_API_BASE:-}" ]; then
  set -- "$@" \
    USE_LOCAL_OAUTH=1 \
    CLAUDE_LOCAL_OAUTH_API_BASE="$CC_VALIDATION_LOCAL_OAUTH_API_BASE"
fi

if [ -n "${CC_VALIDATION_FRAME_BROKER_DIR:-}" ]; then
  set -- "$@" /usr/bin/python3 \
    "$CC_VALIDATION_REPO_ROOT/scripts/terminal-evidence-broker.py" \
    --run "$CC_VALIDATION_FRAME_BROKER_DIR" --
fi

set -- "$@" \
  "${CC_VALIDATION_BINARY:-$CC_VALIDATION_REPO_ROOT/built-claude}"

if [ "${CC_VALIDATION_SKIP_PERMISSIONS:-0}" != "1" ]; then
  set -- "$@" --dangerously-skip-permissions
fi

set -- "$@" \
  --debug \
  --debug-file "$CC_VALIDATION_EVIDENCE_DIR/debug.log"

if [ -n "${CC_VALIDATION_PLUGIN_DIR:-}" ]; then
  set -- "$@" --plugin-dir "$CC_VALIDATION_PLUGIN_DIR"
fi

if [ -n "${CC_VALIDATION_SETTINGS:-}" ]; then
  set -- "$@" --settings "$CC_VALIDATION_SETTINGS"
fi

if [ -n "${CC_VALIDATION_SYSTEM_PROMPT:-}" ]; then
  set -- "$@" --system-prompt "$CC_VALIDATION_SYSTEM_PROMPT"
fi

if [ -n "${CC_VALIDATION_SSH_TARGET:-}" ]; then
  set -- "$@" ssh "$CC_VALIDATION_SSH_TARGET"
fi

exec "$@"

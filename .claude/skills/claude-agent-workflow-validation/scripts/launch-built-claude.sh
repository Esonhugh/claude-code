#!/bin/sh
set -eu

: "${CC_VALIDATION_REPO_ROOT:?missing CC_VALIDATION_REPO_ROOT}"
: "${CC_VALIDATION_EVIDENCE_DIR:?missing CC_VALIDATION_EVIDENCE_DIR}"
: "${CC_VALIDATION_CONFIG_DIR:?missing CC_VALIDATION_CONFIG_DIR}"
: "${CC_VALIDATION_HOME:?missing CC_VALIDATION_HOME}"

cd "$CC_VALIDATION_REPO_ROOT"
exec env -i \
  HOME="$CC_VALIDATION_HOME" \
  CLAUDE_CONFIG_DIR="$CC_VALIDATION_CONFIG_DIR" \
  XDG_CACHE_HOME="$CC_VALIDATION_HOME/.cache" \
  XDG_CONFIG_HOME="$CC_VALIDATION_HOME/.config" \
  XDG_DATA_HOME="$CC_VALIDATION_HOME/.local/share" \
  PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
  SHELL="${SHELL:-/bin/sh}" \
  USER="${USER:-}" \
  LANG="${LANG:-en_US.UTF-8}" \
  TERM="${TERM:-xterm-256color}" \
  HTTP_PROXY="${HTTP_PROXY:-}" \
  HTTPS_PROXY="${HTTPS_PROXY:-}" \
  ALL_PROXY="${ALL_PROXY:-}" \
  NO_PROXY="${NO_PROXY:-}" \
  http_proxy="${http_proxy:-}" \
  https_proxy="${https_proxy:-}" \
  all_proxy="${all_proxy:-}" \
  no_proxy="${no_proxy:-}" \
  CLAUDE_CODE_USE_OPENAI=1 \
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1 \
  "$CC_VALIDATION_REPO_ROOT/built-claude" \
  --dangerously-skip-permissions \
  --debug \
  --debug-file "$CC_VALIDATION_EVIDENCE_DIR/debug.log"

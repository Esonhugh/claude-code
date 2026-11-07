#!/usr/bin/env bash
# Closes the issues a merged PR names with "Fixes/Closes/Resolves #n".
# GitHub does this itself only for PRs into the default branch (master).
# Usage: close-linked-issues.sh <pr-number>   (needs GH_TOKEN and GH_REPO)
set -euo pipefail
pr="$1"
text="$(gh api "repos/$GH_REPO/pulls/$pr" --jq '.title + "\n" + (.body // "")')"
issues="$(printf '%s\n' "$text" \
  | grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#[0-9]+' \
  | grep -oE '[0-9]+$' | sort -un || true)"
[ -n "$issues" ] || { echo "no closing keywords in #$pr"; exit 0; }
for n in $issues; do
  info="$(gh api "repos/$GH_REPO/issues/$n" --jq '[.state, (.pull_request != null)] | @tsv')"
  state="${info%%$'\t'*}"
  if [ "${info##*$'\t'}" = true ]; then
    echo "#$n is a pull request; skipped"
  elif [ "$state" = open ]; then
    gh issue close "$n" --reason completed --comment "Fixed by #$pr (merged into dev)."
  else
    echo "#$n already closed"
  fi
done

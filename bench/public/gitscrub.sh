# SWE-bench Pro: drop every ref and unreachable object so the agent cannot read the upstream fix from git history
cd /app 2>/dev/null || cd /testbed || exit 1
git checkout -q --detach
git for-each-ref --format='%(refname)' | while read r; do git update-ref -d "$r"; done
git remote | while read r; do git remote remove "$r"; done
git stash clear 2>/dev/null
git reflog expire --expire=now --all && git gc -q --prune=now
echo "commits reachable: $(git rev-list --all | wc -l)  objects: $(git count-objects -v | grep -E '^(count|in-pack)' | tr '\n' ' ')"

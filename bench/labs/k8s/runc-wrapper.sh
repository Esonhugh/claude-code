#!/bin/bash
# strip oomScoreAdj (container cannot lower oom_score_adj in this sandbox)
args=("$@"); b=""
for ((i=0;i<${#args[@]};i++)); do [ "${args[$i]}" = "--bundle" ] && b="${args[$((i+1))]}"; done
[ -n "$b" ] && [ -f "$b/config.json" ] && python3 -c "import json,sys;p=sys.argv[1];c=json.load(open(p));c.get('process',{}).pop('oomScoreAdj',None);json.dump(c,open(p,'w'))" "$b/config.json"
exec /usr/bin/runc "$@"

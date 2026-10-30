# pcont.sh <bin> <label> <port>: -p turn, then -p --continue turn, dumps requests
set -u
OUT=$PWD/out/$2; rm -rf $OUT; mkdir -p $OUT/req $OUT/home/.claude $OUT/work
echo '{"hasCompletedOnboarding":true,"customApiKeyResponses":{"approved":["sk-ant-fake"]}}' > $OUT/home/.claude.json
PORT=$3 FAKE_LOG=$OUT/fake.log FAKE_JSONL=$OUT/fake.jsonl WORK=$OUT/work FAKE_DUMP=$OUT/req setsid bun $PWD/fake3.ts </dev/null >$OUT/fake.out 2>&1 &
FP=$!; sleep 2
E="env -i HOME=$OUT/home PATH=/usr/local/bin:/usr/bin:/bin IS_SANDBOX=1 ANTHROPIC_BASE_URL=http://127.0.0.1:$3 ANTHROPIC_API_KEY=sk-ant-fake ENABLE_TOOL_SEARCH=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
cd $OUT/work
$E $1 -p '@@ p1 HELLO' > $OUT/o1.txt 2>&1
echo $(tail -n1 $OUT/fake.jsonl | python3 -c 'import json,sys;print(json.load(sys.stdin)["n"])') > $OUT/mark-before-exit
cp $OUT/mark-before-exit $OUT/mark-after-continue
$E $1 -p --continue '@@ p2 HELLO' > $OUT/o2.txt 2>&1
kill -- -$FP 2>/dev/null; kill $FP 2>/dev/null

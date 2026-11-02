# pcont.sh <bin> <label> <port>: -p turn, then -p --continue turn (SDK=1: stream-json --resume <id>, like the Agent SDK), dumps requests
set -u
OUT=$PWD/out/$2; rm -rf $OUT; mkdir -p $OUT/req $OUT/home/.claude $OUT/work
echo '{"hasCompletedOnboarding":true,"customApiKeyResponses":{"approved":["sk-ant-fake"]}}' > $OUT/home/.claude.json
PORT=$3 FAKE_LOG=$OUT/fake.log FAKE_JSONL=$OUT/fake.jsonl WORK=$OUT/work FAKE_DUMP=$OUT/req setsid bun $PWD/fake3.ts </dev/null >$OUT/fake.out 2>&1 &
FP=$!; sleep 2
E="env -i IS_SANDBOX=1 HOME=$OUT/home PATH=/usr/local/bin:/usr/bin:/bin IS_SANDBOX=1 ANTHROPIC_BASE_URL=http://127.0.0.1:$3 ANTHROPIC_API_KEY=sk-ant-fake ENABLE_TOOL_SEARCH=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
cd $OUT/work
$E $1 -p '@@ p1 EDIT_GO' --output-format json --dangerously-skip-permissions < /dev/null > $OUT/o1.txt 2>&1
echo $(tail -n1 $OUT/fake.jsonl | python3 -c 'import json,sys;print(json.load(sys.stdin)["n"])') > $OUT/mark-before-exit
cp $OUT/mark-before-exit $OUT/mark-after-continue
if [ -n "${SDK:-}" ]; then
  SID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["session_id"])' $OUT/o1.txt)
  echo '{"type":"user","message":{"role":"user","content":"@@ p2 HELLO"}}' | $E $1 -p --input-format stream-json --output-format stream-json --verbose --resume $SID > $OUT/o2.txt 2>&1
else
  $E $1 -p --continue '@@ p2 HELLO' < /dev/null > $OUT/o2.txt 2>&1
fi
kill -- -$FP 2>/dev/null; kill $FP 2>/dev/null

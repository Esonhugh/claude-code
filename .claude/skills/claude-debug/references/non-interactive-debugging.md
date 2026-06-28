# Non-interactive Claude Code debugging

Use non-interactive runs for deterministic request, output, exit-code, and logging checks.

## Basic print-mode comparison

Run both binaries with the same prompt and environment:

```sh
env -i HOME="$HOME" PATH="$PATH" ./official-claude --print "hello" --dangerously-skip-permissions > /tmp/official.out 2> /tmp/official.err
env -i HOME="$HOME" PATH="$PATH" ./built-claude --print "hello" --dangerously-skip-permissions > /tmp/built.out 2> /tmp/built.err
```

Add only required variables back, one at a time:

```sh
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

## JSON and stream output

When supported by the binary, prefer explicit output/input format flags for reproducible parser checks:

```sh
./built-claude --print --output-format stream-json "hello" > /tmp/built-events.jsonl
./official-claude --print --output-format stream-json "hello" > /tmp/official-events.jsonl
```

Validate line-delimited JSON without printing private content:

```sh
python3 - <<'PY'
import json
from pathlib import Path
for path in ['/tmp/built-events.jsonl', '/tmp/official-events.jsonl']:
    count = 0
    for line in Path(path).read_text().splitlines():
        if line.strip():
            json.loads(line)
            count += 1
    print(path, 'json_lines=', count)
PY
```

## Exit-code capture

Use shell wrappers that preserve stdout, stderr, and exit code:

```sh
set +e
./built-claude --print "hello" --dangerously-skip-permissions > /tmp/built.out 2> /tmp/built.err
code=$?
printf 'exit_code=%s\nstdout_bytes=%s\nstderr_bytes=%s\n' "$code" "$(wc -c < /tmp/built.out)" "$(wc -c < /tmp/built.err)"
set -e
```

## Configuration parity

When comparing official/local, keep config equal:

- Same `HOME` or `CLAUDE_CONFIG_DIR`.
- Same OAuth/API key state.
- Same settings file.
- Same proxy env.
- Same prompt and flags.

If a config override is needed, isolate it in a temporary directory and copy only the required files. Do not print secrets from config files.

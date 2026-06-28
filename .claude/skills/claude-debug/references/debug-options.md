# Claude Code debug options

Prefer built-in debug options before adding code instrumentation.

## Discover current flags

Flags can change across official/local versions. Check each binary directly:

```sh
./official-claude --help > /tmp/official-help.txt
./built-claude --help > /tmp/built-help.txt
```

Compare help output locally and quote only relevant flag lines.

## Debug logs

Use `--debug` and `--debug-file` when available:

```sh
./built-claude --debug --debug-file /tmp/claude-built-debug.log --print "hello" --dangerously-skip-permissions
./official-claude --debug --debug-file /tmp/claude-official-debug.log --print "hello" --dangerously-skip-permissions
```

Use separate files for official and local. Do not reuse a debug file across runs unless appending is intentional.

## Useful environment checks

Record non-secret environment values that affect routing and behavior:

```sh
env | sort | grep -E '^(ANTHROPIC_|CLAUDE_|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|USE_|NODE_|BUN_)' > /tmp/claude-debug-env.txt
```

Review the output before sharing. Redact tokens, keys, cookies, and account identifiers.

## Debug artifact naming

Use names that encode binary and mode:

```text
/tmp/claude-debug-built-print.log
/tmp/claude-debug-official-print.log
/tmp/claude-debug-built-proxy.jsonl
/tmp/claude-debug-official-proxy.jsonl
```

## Safe report practice

Report:

- flag names;
- exit codes;
- request IDs if not sensitive;
- redacted header names and value presence;
- checksum computed/existing/match facts;
- byte counts and event counts.

Avoid reporting:

- OAuth access/refresh tokens;
- API keys;
- cookies;
- full private prompts;
- complete request/response bodies unless explicitly authorized.

---
name: claude-debug
description: This skill should be used when the user asks to debug Claude Code CLI or runtime behavior, compare official-claude vs built-claude, inspect API requests or traffic, troubleshoot proxy/OAuth/network behavior, run tmux or InteractiveTerminal repros, capture non-interactive --print output, use --debug/--debug-file logs, configure HTTP_PROXY/HTTPS_PROXY, or build local traffic-capture proxies for HTTP, HTTP/2, SSE, WebSocket, CONNECT, or upstream proxy debugging.
version: 0.1.0
---

# Claude Code Debugging

Use this skill to plan and run reproducible Claude Code debugging sessions. Prefer evidence from real CLI execution and local artifacts over assumptions. Keep secrets, OAuth tokens, cookies, request bodies, and extracted binaries local unless the user explicitly authorizes disclosure.

## Core workflow

1. Define the target:
   - `official-claude` for upstream behavior.
   - `built-claude` for current project behavior.
   - `bun src/...` or focused unit scripts for isolated implementation checks.
2. Choose the debug mode:
   - Interactive terminal debugging for TUI, prompts, slash commands, workflows, and streaming UI.
   - Non-interactive debugging for request/response behavior, print mode, JSON output, or deterministic repros.
   - Traffic debugging for HTTP headers, request body shape, streaming behavior, and proxy compatibility.
3. Keep configurations equivalent when comparing binaries:
   - Use the same `HOME`, `CLAUDE_CONFIG_DIR`, settings, auth state, model env, and prompt.
   - Vary only the binary path or one explicit debug variable.
4. Capture artifacts under `/tmp` or a clearly named local debug directory.
5. Redact before reporting:
   - Authorization headers, cookies, API keys, OAuth tokens, account IDs, organization IDs, full private prompts, and full request bodies.

## Before running commands

Run debug commands from the project root unless a reference explicitly says otherwise. Record binary paths, working directory, prompt, relevant non-secret environment variables, and output artifact paths before comparing results. Keep official/local configuration equal: same `HOME` or `CLAUDE_CONFIG_DIR`, same auth state, same settings, same prompt, and same proxy chain.

For request or proxy work, capture the minimum evidence needed to compare behavior:
- command line for each binary;
- proxy/debug log path;
- request target host and status or CONNECT outcome;
- redacted header presence, byte counts, and exit code;
- checksum/computed/match facts when relevant, without printing secrets or full private bodies.

## Interactive debugging

Use interactive debugging when terminal behavior matters: prompt rendering, tool permission UI, task list display, workflow/deep-research parity, slash commands, or streaming updates.

Prefer existing project guidance first:
- If project instructions require tmux for parity runs, use tmux and record session/window/pane names.
- If project memory or task context prefers `InteractiveTerminal`, use `InteractiveTerminal` for local behavior checks unless parity requires tmux.

Read `references/interactive-debugging.md` for tmux and InteractiveTerminal recipes.

Minimum interactive evidence:
- command used to start each binary;
- environment variables that affect behavior, with secrets redacted;
- exact prompt or input sequence;
- pane capture path or InteractiveTerminal transcript;
- observed difference and timestamp.

## Non-interactive debugging

Use non-interactive debugging when the question is about API request construction, output mode, JSON events, exit codes, or deterministic failures.

Common command shape:

```sh
./built-claude --print "hello" --dangerously-skip-permissions
./official-claude --print "hello" --dangerously-skip-permissions
```

For SDK/JSON style checks, prefer explicit output flags supported by the current binary and capture stdout/stderr separately. Avoid changing auth state while debugging.

Minimum non-interactive evidence:
- exact command and exit code;
- stdout/stderr byte counts or redacted excerpts;
- output format flag and JSON-line validation result when applicable;
- debug file path and relevant redacted log lines.

Read `references/non-interactive-debugging.md` for repeatable command templates.

## Claude Code debug options

Use built-in debug flags before adding custom instrumentation:

```sh
./built-claude --debug --debug-file /tmp/claude-debug-built.log --print "hello"
./official-claude --debug --debug-file /tmp/claude-debug-official.log --print "hello"
```

Check the current binary help if a flag is uncertain:

```sh
./built-claude --help
./official-claude --help
```

Read `references/debug-options.md` for practical flag usage, artifact naming, and redaction checks.

## HTTP proxy traffic debugging

Use proxy-based traffic debugging when verifying request routing, header shape, request body serialization, streaming transport, SSE, WebSocket, or whether `HTTP_PROXY` / `HTTPS_PROXY` is honored.

Start with the bundled transparent proxy script:

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs --port 8899 --log /tmp/claude-proxy.jsonl
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

For proxy chains:

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs \
  --port 8899 \
  --upstream http://127.0.0.1:7890 \
  --log /tmp/claude-proxy.jsonl
```

Important limitation: standard `HTTPS_PROXY` uses `CONNECT`, so HTTPS payloads, HTTP/2 frames, SSE event payloads, and WebSocket frames are encrypted and opaque unless a trusted MITM certificate is installed. The bundled script supports tunneling and metadata/byte-count observation for HTTPS, HTTP/2, SSE, and WebSocket. Use a trusted local MITM proxy only in authorized local experiments.

Treat `--dump-dir` artifacts as sensitive local-only captures. Plain HTTP/ws transcripts may contain plaintext prompts, responses, headers, cookies, or tokens; HTTPS/wss CONNECT transcripts contain encrypted TLS bytes only. Do not commit, upload, or paste these artifacts unless explicitly authorized and redacted.

Minimum proxy evidence:
- proxy command, port, upstream proxy, and log path;
- proxy env passed to the target process;
- CONNECT targets or absolute-form HTTP targets;
- response statuses for plain HTTP and byte counts for tunnels;
- redacted header names/value presence, never raw credentials;
- when packet-like exchange inspection is explicitly needed, use `--dump-dir <dir>` and report the local transcript path instead of pasting sensitive content.

Read `references/proxy-debugging.md` for transport details, upstream proxy behavior, script limits, and safe report formats.

## Report format

Use this compact format for findings:

```markdown
## Scope
- Target:
- Mode: interactive | non-interactive | proxy
- Binaries/config compared:

## Evidence
- Commands:
- Artifacts:
- Redactions:

## Findings
1. ...

## Limits
- ...
```

## Additional resources

- `references/interactive-debugging.md` — tmux and InteractiveTerminal workflows.
- `references/non-interactive-debugging.md` — print-mode, JSON, exit-code, and reproducible CLI checks.
- `references/debug-options.md` — Claude Code debug flags and debug-file handling.
- `references/proxy-debugging.md` — HTTP_PROXY/HTTPS_PROXY, CONNECT, HTTP/2, SSE, WebSocket, upstream proxy chains.
- `scripts/http-proxy-debug.mjs` — local transparent proxy with metadata logging and upstream proxy support.

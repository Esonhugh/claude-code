---
name: claude-debug
description: This skill should be used when the user asks to debug Claude Code CLI or runtime behavior, compare official-claude vs built-claude, inspect API requests or traffic, troubleshoot proxy/OAuth/network behavior, run tmux or InteractiveTerminal repros, capture non-interactive --print output, use --debug/--debug-file logs, configure HTTP_PROXY/HTTPS_PROXY, build local traffic-capture proxies for HTTP, HTTP/2, SSE, WebSocket, CONNECT, or upstream proxy debugging, or use local MITM/CCH HTTPS request body inspection with temporary CA artifacts.
version: 0.1.0
---

# Claude Code Debugging

Use this skill to plan and run reproducible Claude Code debugging sessions. Prefer evidence from real CLI execution and local artifacts over assumptions. Keep secrets, OAuth tokens, cookies, request bodies, and extracted binaries local unless the user explicitly authorizes disclosure.

## Choose the right tool: assistant-side vs. binary-side

<system-reminder>
**CRITICAL TOOL-LAYER RULE — read before any test command.**

Before running anything, classify what you are actually exercising. Crossing these two layers is the #1 cause of invalid debug results — most "test failures" reported here are actually tests that ran in the wrong layer.

<assistant-side-tools>
**Tools the assistant invokes directly.** They run in this agent's host shell, not inside any Claude binary. Use them to:

- inspect / edit / search the project (`Read`, `Edit`, `Write`, `Grep`, `Glob`),
- run shell / build commands (`Bash`, e.g. `make build`),
- drive a real PTY / REPL / TUI for local behavior checks (`InteractiveTerminal`).

`InteractiveTerminal` is the *transport* used to drive a `built-claude` / `official-claude` session from this agent. It is **not** the thing under test when you are exercising slash commands or skills.
</assistant-side-tools>

<binary-side-surfaces>
**Features that only exist *inside* a running Claude binary.** They cannot be invoked from assistant-side tools directly — you must start the binary and submit input through it. Examples:

- slash commands (`/goal`, `/compact`, `/workflows`, `/clear`, `/skills`, `/claude-analysis`, …),
- bundled skills and workflows the binary loads,
- statusline, permission-mode UI, dialog / preview rendering,
- StopHook, SessionStart-hook, PostToolUse-hook behavior,
- the child binary's *own* tool list (its `Bash` / `Read` / `Edit` are different process surfaces from this agent's tools).

To exercise a binary-side surface:
1. Start the binary (typically `InteractiveTerminal` running `./built-claude --dangerously-skip-permissions`, or tmux when parity requires it).
2. Type the slash command or prompt **into that binary's stdin**.
3. Observe via the binary's stdout / pane / log file.
</binary-side-surfaces>

<invalid-testing-anti-patterns>
- ❌ Running a slash command through the assistant's `Bash` tool (e.g. `bash -c '/goal foo'`). `/goal` is parsed by the Claude REPL, not the host shell — same for `/compact`, `/workflows`, `/skills`.
- ❌ Asserting a bundled skill "works" by reading its source file via `Read`. Source presence does not prove the binary registered, listed, or injected it. Confirm via the running binary's `/skills` UI or its debug log.
- ❌ Reading project files to "verify" `/goal` survives compact. You must actually set a goal in a binary session, trigger `/compact`, and inspect the post-compact transcript.
- ❌ Confusing names that exist in both layers: assistant's `Read` / `Bash` / `Edit` vs. the child binary's `Read` / `Bash` / `Edit` are different surfaces.
</invalid-testing-anti-patterns>

<report-rule>
Label every command and observation with its layer:
- `assistant-side` (e.g. "`InteractiveTerminal write` into `built-claude` PTY"),
- `binary-side` (e.g. "`built-claude` slash command `/goal clear`").

This keeps reviewers from re-running broken experiments.
</report-rule>
</system-reminder>

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

Important limitation: standard `HTTPS_PROXY` uses `CONNECT`, so HTTPS payloads, HTTP/2 frames, SSE event payloads, and WebSocket frames are encrypted and opaque unless a trusted MITM certificate is installed. The bundled transparent proxy supports tunneling and metadata/byte-count observation for HTTPS, HTTP/2, SSE, and WebSocket.

For authorized local CCH/body inspection, use the bundled MITM runner. It creates a temporary local CA, runs both binaries through `HTTPS_PROXY`, clears `NO_PROXY` for the child process, injects trust through process-local CA environment variables, and writes partially redacted local request summaries. Treat the output file and runner stdout as sensitive metadata, not share-safe output:

```sh
node .claude/skills/claude-debug/scripts/run-claude-mitm-cch.mjs \
  --repo . \
  --only both \
  --prompt "hello" \
  --output /tmp/claude-mitm-cch-summary.json
```

Treat `--dump-dir`, MITM logs, generated CA/leaf private keys, stdout/stderr captures, runner stdout, output summaries, and optional body artifacts as sensitive local-only captures. Plain HTTP/ws transcripts and MITM summaries may contain private request metadata; optional MITM body files contain full plaintext request bodies. HTTPS/wss CONNECT transcripts from the transparent proxy contain encrypted TLS bytes only. Keep MITM proxies bound to loopback; do not use `--host 0.0.0.0` or expose them on untrusted interfaces. Do not install the generated CA globally. Delete the artifact root and explicit summary output after review. Do not commit, upload, or paste these artifacts unless explicitly authorized and redacted.

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
- `scripts/run-claude-mitm-cch.mjs` — local MITM runner for redacted request/body/CCH summaries from `built-claude` and `official-claude`.
- `scripts/mitm-cch-debug.mjs` — lower-level MITM proxy used by the runner.

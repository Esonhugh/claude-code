# One CLI, two accounts: an introduction to Esonhugh/claude-code

> 繁體中文版：[why-this-fork.zh-TW.md](why-this-fork.zh-TW.md)

`@esonhugh/claude-code` is an unofficial fork of Claude Code. It keeps everything Claude Code already does (tools, permissions, hooks, MCP, skills, subagents, workflows) and adds things the official build does not have: OpenAI models through a ChatGPT account, a browser UI (`claude web`), Mods that can reshape Claude itself, Agent Teams that really form a team, and a shorter system prompt.

> This project is not an Anthropic product and is not endorsed by Anthropic. The public package ships only a launcher and per-platform binaries, not source code.

## Why try it

**One tool, both accounts.** The same `claude` runs with a Claude account or with a ChatGPT account (OAuth, device code or API key) on GPT / Codex models. Tools, UI and slash commands work the same. On the OpenAI path you also get a Codex-style `apply_patch` tool, the Codex Apps connected in ChatGPT, and the `/daybreak` cyber access tier.

**Fewer tokens, same cache hits.** On one set of real tasks (office, research, coding, ops, Lean proofs; 654 runs), the Claude account hits the prompt cache 87.1% of the time versus 87.3% for official Claude Code, effectively equal, while using 72.7k tokens per task versus 81.0k (10% fewer). Over a 6-turn TUI session official used 640k tokens, this fork 235k. The main request carries 37.6k characters of prompt versus 46.6k for official.

**Claude Code in the browser.** `claude web` starts a local web UI backed by the local claude: math, Mermaid, code and diffs render as web content; upload and preview PDF / Office files and comment directly on images, code and PDFs; interject mid-turn or stop at once; rewind to before any message (optionally restoring files); a side panel shows status, agents, terminals, the workflow board and Mods.

**Reshape Claude itself.** Mods let one JS/TS file add commands, intercept or rewrite tool calls, and add status bands and side panels that show in both the terminal and the web UI.

**Long-running autonomous work.** Agent Teams, Dynamic Workflow, `/goal`, Monitor, scheduled tasks, an interactive Terminal tool and background sessions let Claude split work, run it in parallel, and keep going until a goal is met.

**Private by default.** No telemetry is sent to Anthropic by default and `/feedback` is hidden; project settings cannot turn telemetry on for you.

## Install

```bash
bun add --global @esonhugh/claude-code
claude --version
```

Binaries are published for Linux x64, Linux arm64, macOS arm64 and Windows x64. To build from source:

```bash
git clone https://github.com/Esonhugh/claude-code
cd claude-code
bun install
make build
./built-claude --version
```

## Sign in: Claude or ChatGPT

Claude account, as usual:

```bash
claude        # then /login on first start
```

ChatGPT account (or an OpenAI API key):

```bash
CLAUDE_CODE_USE_OPENAI=1 claude
# /login, then Sign in with OAuth (with a browser) or Sign in with device code (SSH, headless)
```

```bash
# no login: API key or a compatible gateway
CLAUDE_CODE_USE_OPENAI=1 OPENAI_API_KEY=<your-api-key> claude
CLAUDE_CODE_USE_OPENAI=1 OPENAI_BASE_URL=https://gateway.example/api OPENAI_API_KEY=<key> claude
```

With a ChatGPT account the default model and context window follow the account's model catalog, and `/model` lists the models it can use. The CLI picks the provider at startup; in `claude web` the account menu (bottom left) has an Authentication submenu that switches between Anthropic OAuth, OpenAI OAuth and the two API keys.

## Browser UI: `claude web`

```bash
claude web                 # local only, opens the browser
claude web --no-open       # over SSH: print the URL only
```

The one-time token in the URL is exchanged for a cookie and removed from the address bar. It listens on localhost only; LAN access needs an explicit `--dangerously-allow-local-network`.

**Projects**: click `+` next to Projects in the sidebar and give a name, working directory and project notes. Tell the project what you need; a coordinator splits the work into tasks for several workers running in parallel. The right column shows each task's progress, where you approve commands, send messages, stop or review. Projects and tasks live in a local SQLite database and survive restarts.

## Agent Teams: real teammates

```bash
claude --agent-teams
# or CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude
```

Then ask Claude to "form a team of three, one on implementation, one on tests, one on docs, and name each teammate". Every teammate is a full Claude session that stays online, messages others with `SendMessage`, and shares one task list; you can switch to any teammate to watch it. In `-p` mode teammates run in-process; after the lead's shutdown request, teammates idle for 15 seconds are stopped and the process exits normally.

## Mods: one in five minutes

```text
hello-mod/
├── .claude-plugin/plugin.json   { "name": "hello-mod", "version": "0.1.0" }
└── hooks/
    ├── hooks.json               { "modules": ["./register.ts"] }
    └── register.ts              registers /hello and a tool interceptor
```

```bash
claude plugin validate ./hello-mod   # static scan, runs no code
claude --plugin-dir ./hello-mod      # load it, then type /hello
claude plugin test ./hello-mod       # run the mod's own tests
```

Examples in the repo: Token Weather draws a context-usage band above the prompt; Blast Radius shows what a dangerous command would affect before Claude runs it. Mods run locally with high privileges, so load only plugins you trust.

## Context-window tiers and memory

```text
/context                  see what the system prompt, tools and conversation use
/context-window 200k      set this model's compaction window to 200k (alias /autocompact)
/context-window auto      back to the recommended value
```

Tiers are `auto`, 128k, 200k, 272k, 500k and 1M (those below the model's limit), saved per model; the `claude web` model menu has a Context window row too. To keep recent turns verbatim and summarize only older ones, set `"compact": {"mode": "codex"}`.

When memory grows, switch it to SQLite FTS5 full-text search so it is looked up on demand instead of loaded every time:

```json
{ "memory": { "sqlite": { "enabled": true } } }
```

## Also worth knowing

- **Channels**: Telegram, Discord or your own MCP server push messages into a running session, and you can approve tool calls from your phone.
- **`/goal all tests pass`**: checks the condition at the end of each turn and keeps working until it holds.
- **Terminal tool**: a persistent interactive terminal for Claude: REPLs, TUIs, Ctrl+C.
- **`claude ssh <host>`**: read, write and run on a remote Linux machine while the UI and permission prompts stay local; API credentials never leave your machine.
- The **official Agent SDK and VS Code extension** can drive this fork directly.

The full feature list is in the [feature docs](../features/README.md), also synced to the GitHub Wiki.

## Benchmark

Collected 2026-11-07: 654 runs with real model requests, at least 3 per cell. Hit rate = cache reads ÷ all input, token-weighted.

| Metric | Fork · Claude | Official Claude Code | Fork · ChatGPT | Codex CLI | opencode | pi |
| --- | --- | --- | --- | --- | --- | --- |
| Cache hit rate | 87.1% | 87.3% | 85.3% | 88.8% | 89.2% | 84.0% |
| Mean total tokens / task | 72.7k | 81.0k | 75.9k | 80.3k | 81.5k | 36.5k |
| API-equivalent cost / task | $0.078 | $0.088 | $0.050 | $0.047 | $0.059 | $0.041 |
| TUI 6-turn total tokens | 235k | 640k | 310k | 267k | 170k | 80k |
| `-p` start to first request | 0.82s | 0.89s | 0.71s | 2.59s | 2.81s | 0.83s |
| Tasks passed | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 |

- On the Claude side the fork matches official on cache hits with 10% fewer tokens and 11% lower cost.
- With 3 subagents the fork uses 2.8× a single agent; official uses 3.7×.
- Real ssh and Kubernetes troubleshooting: 10 CLIs × 4 tasks × 3 runs, all passed. Claude side fork 89.9% vs official 90.0% with 4% fewer tokens; ChatGPT side fork 79.5% vs Codex 90.0%, with 40% fewer tokens.
- pi has a 2.7k prompt and the fewest tokens, but no subagents. pi and opencode write only a 5-minute cache on Claude, so after 15+ idle minutes their first request hits 0–27%; the fork and official write a 1-hour cache.

Test design, charts, multi-agent, long idle, oh-my-pi and dsh data: [Cache hit and user experience benchmark](../features/cache-benchmark.md) ([Wiki](https://github.com/Esonhugh/claude-code/wiki/Cache-Benchmark)).

## Honest limitations

- **Unofficial.** The source was recovered from Claude Code's distributed artifacts and is not endorsed by Anthropic. Review security, updates and permissions yourself before production use.
- **ChatGPT short tasks trail Codex.** Short tasks hit 82.9% vs 89.7%; long tasks 86.5% vs 88.3%. Codex keeps its system prompt on the server, so its first request in a new session has less uncached input; a client cannot close that gap.
- **New sessions after idle.** Official's static prefix is shared by all users and always warm: after an idle period the first request of a new session hits 67% for official and 0% for the fork.
- **Teams are expensive.** A 3-member team costs 6.0× a single agent on a Claude account and 8.5× on ChatGPT, because each teammate is a session with the full system prompt. The feature is off by default; use it for work that needs sustained collaboration.
- **ChatGPT mid-session cache breaks**: 2.7% of requests (0% on the Claude side), caused by OpenAI backend routing.
- **Mods are still converging on official.** Some worker-recovery and browser-client lifecycle items are not fully accepted yet; see the [Mods doc](../features/mods.md).
- **Platforms.** No macOS x64 binary.
- The benchmark tasks do not separate CLIs by success rate (nearly all 100%); the differences are in tokens, time and stability.

## Links

- Repository: https://github.com/Esonhugh/claude-code
- npm: `@esonhugh/claude-code`
- Changelog: [CHANGELOG.md](../../CHANGELOG.md)
- Feature docs: [docs/features](../features/README.md)

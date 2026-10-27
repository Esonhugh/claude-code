# Agent SDK examples

Drive this fork with the official Claude Agent SDK and turn on fork-only features. See [docs/features/agent-sdk.md](../../docs/features/agent-sdk.md#用官方-sdk-打开-fork-功能).

```sh
bun add @anthropic-ai/claude-agent-sdk      # Python: pip install claude-agent-sdk
CLAUDE_FORK_BIN=/path/to/built-claude bun basic.mjs
```

| File | Shows |
| --- | --- |
| `basic.mjs` | Minimal query against the fork binary |
| `openai-provider.mjs`, `openai_provider.py` | OpenAI provider (`env`) + Daybreak blue (`settings`); needs `OPENAI_API_KEY` or `~/.codex/auth.json` |
| `fork-settings.mjs` | SQLite memory and Workflow via `settings`, checked from the init tool list |
| `mods-plugin.mjs`, `hello-mod/` | Load a mod via `plugins`; it denies Read on `.env` |

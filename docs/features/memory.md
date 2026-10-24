# 记忆：auto memory 与 SQLite FTS5 检索

> 英文名：`memory` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 作用与效果

交互会话默认开启 auto memory、后台记忆提取、Session Memory 与离开回顾，不依赖 GrowthBook；载入记忆时删除不可见字符并转义伪造的 harness 标签。

`memory.sqlite.enabled` 打开后不再把 `MEMORY.md` 注入每个请求，改由 `SearchMemory` 工具查本地 SQLite FTS5 索引（`<config>/memory-index.sqlite`），每个用户 prompt 还会自动附上最相关的 5 个记忆文件；记忆文件与 `MEMORY.md` 照常维护，关掉不会丢东西。需要 Bun runtime，否则回退到 `MEMORY.md`。README 原先缺这一项。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | settings / 环境变量 | `false` / `1` | 开启 | 关闭记忆 |
| `memory.sqlite.enabled` | settings | `true` / `false` | `false` | SQLite 检索模式；每会话只读一次 |
| `memory.sqlite.scopes` | settings | `user` `project` `session` 的子集 | 全部 | user = 其他项目记忆（只读），session = 本项目历史 transcript |
| `memory.extraction` | settings | `sessionEnd` / `everyTurns` / `off` | `sessionEnd` | 后台提取频率；sessionEnd 在退出、`/clear`、`/resume` 时提取 |
| `awaySummaryEnabled` / `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | settings / 环境变量 | `false` / `0`、`1` | 开启 | 离开回顾 |
| `/setup-memory-db`、`/memory` → Rebuild memory index | 斜杠命令 | — | — | 全量重建索引并 VACUUM |

```json
{ "memory": { "sqlite": { "enabled": true, "scopes": ["user", "project", "session"] }, "extraction": "sessionEnd" } }
```

## 效果

开启 `memory.sqlite` 后 `/setup-memory-db`，以及 `/memory` 多出的 Rebuild 行：

```text
❯ /setup-memory-db
  ⎿  Memory index built (user, project, session): 0 files, 0 entries, 40KB at ~/.claude/memory-index.sqlite
❯ /memory
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Memory
    Auto-memory: on
    Auto-dream: off · never
  ❯ 1. User memory              Saved in ~/.claude/CLAUDE.md
    2. Project memory           Checked in at ./CLAUDE.md
    3. Open auto-memory folder
    4. Rebuild memory index     0 files · 40KB · built 6s ago
  Learn more: https://code.claude.com/docs/en/memory
  Enter to confirm · Esc to cancel
```

默认（未开启）时 `/memory`：

```text
❯ /memory
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Memory
    Auto-memory: on
    Auto-dream: off · never
  ❯ 1. User memory              Saved in ~/.claude/CLAUDE.md
    2. Project memory           Checked in at ./CLAUDE.md
    3. Open auto-memory folder
  Learn more: https://code.claude.com/docs/en/memory
  Enter to confirm · Esc to cancel
```

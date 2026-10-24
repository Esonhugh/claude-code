# Agent Teams

> 英文名：`agent-teams` · 领域：Agent 与编排 · [返回功能索引](README.md)

## 作用与效果

`TeamCreate` 建立团队（`~/.claude/teams/<name>/config.json`），teammate 以进程内或 tmux 方式运行，通过 `SendMessage` 与共享任务协作；shutdown 后成员会从 `config.json` 移除。进程内 teammate 在 leader 处于 bypass、acceptEdits 或 auto 时改用 leader 的模式。与官方 2.1.303 一致，默认关闭。

## 配置

| 配置项 | 位置 | 可选值 | 默认 |
| --- | --- | --- | --- |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 环境变量 | `1` | 关闭 |
| `--agent-teams` | CLI | 开关 | 关闭 |
| `teammateMode` | 全局配置 `~/.claude.json`（`/config`） | `in-process` / `tmux` / `auto` | `auto` |

## 效果

未开启时 `TeamCreate` 不存在：

```text
❯ DO<<TeamCreate|{"team_name":"demo-team","description":"docs demo"}>>
  ⎿  Error: No such tool available: TeamCreate
● FAKE_DONE
```

开启后创建成功，模型收到的结果（节选）：

```text
{"team_name":"demo-team","team_file_path":"~/.claude/teams/demo-team/config.json","lead_agent_id":"team-lead@demo-team", ...}
```

## 详细说明

以下内容自原 README 迁入，保持原文。

Agent Teams 与官方 2.1.303 一致，默认关闭；设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 或传 `--agent-teams` 启用：

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude
claude --agent-teams
```

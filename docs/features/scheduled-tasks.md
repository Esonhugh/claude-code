# 定时任务：Cron、/loop 与 ScheduleWakeup

> 英文名：`scheduled-tasks` · 领域：工具 · [返回功能索引](README.md)

## 作用与效果

Cron 工具使用本地时区 5 字段 cron；默认只在当前会话有效，`durable: true` 保存到 `.claude/scheduled_tasks.json`。`/loop <间隔> <prompt>` 定期执行；不带间隔时模型用 `ScheduleWakeup` 自定下次唤醒（60–3600 秒）。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `CLAUDE_CODE_DISABLE_CRON` | 环境变量 | `1` | 关闭 cron 与 `/loop` |
| CronCreate 输入 | 模型调用 | `{"prompt":"...","cron":"*/15 * * * *","recurring":true,"durable":true}` | 7 天后自动过期 |

## 效果

```text
❯ DO<<CronCreate|{"cron":"*/15 * * * *","prompt":"check build status","recurring":true}>>
● CronCreate(*/15 * * * *: check build status)
  ⎿  Scheduled fec73857 (Every 15 minutes)
● FAKE_DONE
```

`CLAUDE_CODE_DISABLE_CRON=1` 时 `/loop` 不存在：

```text
❯ Unknown skill: loop
● Args from unknown skill: 5m check build
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Cron 与 durable task

Cron tools 使用本地时区的标准 5-field cron。默认任务只在当前 session 中存在；`durable: true` 时保存到 `.claude/scheduled_tasks.json`。

```json
{
  "prompt": "检查构建状态并报告失败项",
  "cron": "*/15 * * * *",
  "recurring": true,
  "durable": true
}
```

可通过环境变量关闭 cron 能力：

```bash
CLAUDE_CODE_DISABLE_CRON=1 claude
```

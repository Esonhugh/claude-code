# 自主 Goal

> 英文名：`goal` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

`/goal <condition>` 或模型调用 `SetGoal` 注册一个 Stop hook：回合结束前由模型检查目标是否完成，未完成就继续。Goal 状态写入 transcript，`--resume` / `--continue` 后恢复。`/goal` 打开状态视图（耗时、turn、token、最后检查原因），`/goal clear` 清除。

## 配置

| 用法 | 说明 |
| --- | --- |
| `/goal <condition>` | 设定目标 |
| `/goal` | 状态视图 |
| `/goal clear` | 清除目标与 Stop hook |
| statusLine 输入 `goal.active` | 见 [branding.md](branding.md) |

## 效果

设定、查看、清除（采集用的假 API 不返回 Stop hook 需要的 JSON，因此画面里出现 `JSON validation failed`；真实模型会返回检查结果）：

```text
❯ /goal make tests pass
  ⎿  Goal set: make tests pass
● FAKE_DONE
● Ran 1 stop hook (ctrl+o to expand)
  ⎿  Stop hook error: JSON validation failed
✻ Churned for 0s
❯ /goal
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ◎ Goal active
  running 7s · 10 tokens
  Goal: make tests pass
  /goal clear to stop early · Esc to dismiss
```

```text
❯ /goal clear
  ⎿  Goal cleared: make tests pass
```

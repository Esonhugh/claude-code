# 遥测与反馈

> 英文名：`telemetry` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

一方遥测默认关闭，需显式开启；开启后在 `DISABLE_TELEMETRY`、仅必要流量、Bedrock/Vertex/Foundry 或非官方 `ANTHROPIC_BASE_URL` 下仍保持关闭。`/feedback` 会上传 transcript，跟随同一开关。OTel 的 `tool_decision` 事件带 `permission_mode` 与 `classifier_verdict`。

## 配置

| 配置项 | 位置 | 可选值 | 默认 |
| --- | --- | --- | --- |
| `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY` | 环境变量 | `1` | 关闭 |
| `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 环境变量 | `1` | — |

## 效果

默认，以及开启遥测但 `ANTHROPIC_BASE_URL` 指向本地网关时，`/feedback` 都不可用：

```text
❯ Unknown skill: feedback
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 遥测与反馈

Anthropic 一方遥测默认关闭，需要显式开启：

```bash
CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1 claude
```

开启后，以下情况仍保持关闭：`DISABLE_TELEMETRY`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、Bedrock/Vertex/Foundry，或 `ANTHROPIC_BASE_URL` 指向非官方网关。`/feedback` 会上传 transcript，因此跟随同一开关并在上述情况下不可用；反馈、记忆与压缩后问卷同样需要该开关，并在 `DISABLE_TELEMETRY`、仅必要流量或网关 base URL 下关闭（Bedrock/Vertex/Foundry 不影响问卷）。

OTel 导出的 `tool_decision` 事件包含 `permission_mode`，以及自动模式分类器参与时的 `classifier_verdict`（`allow`、`block`、`unavailable` 或 `no_verdict`）。项目设置不能通过 `env` 开启 Anthropic 遥测或改写 OTel 导出，见「权限规则与权限模式」。

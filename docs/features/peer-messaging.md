# 独立会话通信

> 英文名：`peer-messaging` · 领域：Agent 与编排 · [返回功能索引](README.md)

## 作用与效果

每个 CLI 会话（含 `-p`）注册同机 inbox，可用 `/list-agents`（`/peers`）或模型侧 `ListAgents`、`SendMessage` 发现并发送纯文本。发现只在同一 `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions` registry 内进行。来信保留独立 provenance，不算用户指令或权限批准。不是 Remote Control 或跨机器 transport。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `--name` | CLI | 字符串 | 易识别的会话名 |
| `--messaging-socket-path` | CLI | 绝对 `.sock` 路径 / named pipe | 覆盖 endpoint；`--bare` 默认不注册 |
| `crossSessionInbound` | settings | `accept` / `hold` / `refuse` | 未配置时按权限 class 决定；项目设置只能更严格 |

```json
{ "crossSessionInbound": "accept" }
```

## 效果

同一配置目录下启动 `--name reviewer` 与 `--name builder`，在 builder 里 `/peers`：

```text
❯ /list-agents
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Local Claude sessions
  Other Claude sessions (1):
  [unknown] · reviewer [f22cdb] ·
  ~/work · started 14s
   ago
  Enter to confirm · Esc to cancel
```

两个会话使用不同配置目录时互相看不到：

```text
  Local Claude sessions
  Other Claude sessions (0):
  No other live local Claude sessions found.
  Enter to confirm · Esc to cancel
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 独立会话通信

CLI 启动时（包括 `-p` 非交互模式）会注册同机 inbox；`--bare` 和 SSH local UI 默认不注册。会话发现使用同一个 `${CLAUDE_CONFIG_DIR:-~/.claude}/sessions` registry，因此不同 `CLAUDE_CONFIG_DIR` 的 session 不会通过名称或 UUID 相互发现。可用 `--name` 设置易识别的 session 名称：

```bash
claude --name reviewer
```

默认 endpoint 无需配置。高级集成可使用 `--messaging-socket-path <endpoint>` 覆盖：Unix 使用绝对 `.sock` 路径，Windows 使用 local named pipe；显式指定后也可让 `--bare` 启动 inbox，但 SSH local UI 仍不启动。显式 endpoint 绑定失败会终止启动；自动 endpoint 不可用时只记录 debug log，CLI 继续运行。

查看当前可发现的其他 session（仅在 messaging inbox 成功启动时显示，结果不包含当前进程）：

```text
/list-agents
/peers
```

模型侧的 `ListAgents` 和 `SendMessage` 默认 deferred，由 `ToolSearch` 按需加载。`SendMessage.to` 可使用列表中的 name、名称冲突时的 `name [ref]`、session UUID，或回复来信时复制其精确 `from="uds:..."` 地址。跨独立 session 只发送纯文本，不传递 Team 的 shutdown/plan approval 等结构化控制消息。普通 assistant 文本不会自动发送给 peer；发送成功只确认 transport write，不代表接收方已经接受或处理消息。Peer 输入保留独立 provenance，不作为用户指令或权限批准，也不会解析 slash commands 或 attachments。

入站策略可在用户级或项目级 settings 中配置：

```json
{
  "crossSessionInbound": "accept"
}
```

可选值：

- `accept`：消息进入接收方队列；
- `hold`：暂存，等待 permission class 或 settings 变化后重新判断；
- `refuse`：拒绝消息。

未配置时不是固定值：接收方尚无 permission context 时为 `hold`；已知发送方 permission class 时，同 class 为 `accept`、不同 class 为 `hold`；来信未声明 class 时，普通 prompting session 为 `accept`，bypass session 为 `hold`。project/local policy 只能比 user/managed policy 更严格，不能在仓库配置中放宽上层限制。

该协议仅用于同机 session：macOS/Linux 使用 Unix domain socket，Windows 使用 local named pipe；Remote Control、Direct Connect 和 SSH Remote 是独立 transport。

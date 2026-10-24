# Direct Connect

> 英文名：`direct-connect` · 领域：远程执行 · [返回功能索引](README.md)

## 作用与效果

执行端 `claude server` 起一个 HTTP + WebSocket session server（默认只绑 `127.0.0.1`），每个 session 启动一个 `claude -p` child 持有工具与项目上下文；本地 `claude cc://...` 负责 TUI 与权限 UI，`-p` 为 headless 单轮。已包含在默认构建。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--port` | `claude server` | 端口 / `0` | `0`（随机） | — |
| `--auth-token` | `claude server` | 字符串 | 自动生成 | 每个请求校验 Bearer |
| `--host` | `claude server` | 地址 | `127.0.0.1` | 非 loopback 时 banner 警告明文 HTTP |
| `--workspace` | `claude server` | 目录 | — | client cwd 不存在时退回 |
| `--idle-timeout` / `--max-sessions` | `claude server` | 毫秒 / 整数 | `600000` / `32` | detached session 超时 / 满额返回 503 |
| `cc://host:port/<token>[?serverUrl=https://...]` | 本地 CLI | URL | — | `cc+unix://` 不支持 |

```bash
claude server --port 8765 --auth-token "$TOKEN"
claude cc://127.0.0.1:8765/$TOKEN
claude cc://127.0.0.1:8765/$TOKEN -p "summarize README.md"
```

## 效果

server banner：

```text
2026-10-24T15:10:54.778Z INFO listening on http://127.0.0.1:18765
Claude Code server listening on http://127.0.0.1:18765
Connect with: claude cc://127.0.0.1:18765/demo-token-123
Sessions run with your local credentials and full access to this machine. Press Ctrl+C to stop.
```

正确 token 的 headless 单轮，与错误 token：

```text
FAKE_DONE
```

```text
Failed to create session: 401 Unauthorized — {"error":"Unauthorized"}
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 远程执行：Direct Connect 与 SSH

Direct Connect 已包含在默认构建中。在执行端启动 server，在本地用 `cc://` URL 连接：

```bash
# 执行端：默认只监听 127.0.0.1；--port 0（默认）随机端口，未给 --auth-token 时自动生成
claude server --port 8765 --auth-token "$TOKEN" [--workspace <dir>] [--idle-timeout 600000] [--max-sessions 32]

# 本地：交互式 TUI；server 启动 banner 会打印完整的 cc:// URL
claude cc://127.0.0.1:8765/$TOKEN

# 本地：headless 单轮，可选 --output-format text|json|stream-json
claude cc://127.0.0.1:8765/$TOKEN -p "summarize README.md"
```

`cc://host:port/<token>` 映射为 `http://host:port` 并以路径作为 Bearer token；`?serverUrl=https://...` 可改写 HTTP 基址（如经 TLS 反向代理），`cc+unix://` 明确报错不支持。client 以 `POST /sessions`（`cwd`、`permission_mode`、可选 `session_key`）创建 session，再连 `GET /sessions/:id/ws` 双向传输 stream-json；server 为每个 session 启动同一 binary 的 `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`，`can_use_tool` 转给 client 的 permission UI，答复以 `control_response` 回送 child。client 的 `cwd` 在 server 上不存在时退回 `--workspace`，否则返回 400。detached session 超过 `--idle-timeout` 后结束，`--max-sessions` 满时返回 503；headless `-p` 收到 `result` 后删除 session，未加 `--dangerously-skip-permissions` 时工具权限请求一律拒绝。每个请求都校验 token；server 以启动它的用户身份和本机凭据运行 child，绑到非 loopback 地址时 banner 会警告明文 HTTP 风险。server 需在 Bun runtime（打包后的 `claude` binary）中运行，运行期间写 `~/.claude/server.lock` 阻止同一配置目录重复启动。malformed control frame、permission cancellation 和 late response 由 transport 生命周期处理。

SSH Remote 使用相同的本地 UI / 远端执行边界，但通过 SSH 部署 managed child，并在 child stdio 上传输 stream-json。两者是并列 transport，不会相互转发。

所有 remote execution session 当前都禁用本机 IDE integration、local tools 和 local skill watcher，以免本机 IDE/workspace 与远端执行上下文混用。因此 `--ide` 不会在 Direct Connect 或 SSH session 中暴露本机 IDE MCP tools；即使 Direct Connect server 与本机共享 workspace，也适用这一保守边界。

# SSH Remote

> 英文名：`ssh-remote` · 领域：远程执行 · [返回功能索引](README.md)

## 作用与效果

与 Direct Connect 并列的 SSH transport：按远端架构部署对应 binary（GitHub Release 下载校验 checksum），远端 child 只连 reverse-forwarded Unix socket，由本地 proxy 注入认证。支持远端 history/resume、远端 `@` 路径补全、远端 `!command` 与权限状态同步。只支持交互式 TUI。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| host | CLI | `user@host`、`~/.ssh/config` alias、`sshConfigs` 的 `id` | — |
| `sshConfigs` | settings | `[{"id","name","sshHost","sshPort","sshIdentityFile","startDirectory"}]` | 托管连接 |
| `--model` / `--settings` | CLI | — | 由本地 launcher 解析，model 显式转发远端 |

```json
{ "sshConfigs": [{ "id": "managed-config-id", "name": "Managed Linux", "sshHost": "user@example.com", "sshPort": 2222, "startDirectory": "~/project" }] }
```

## 效果

`claude ssh --help`：

```text
Usage: claude ssh [options] <host> [dir]
Run Claude Code on a remote host over SSH. Deploys the binary and tunnels API
auth back through your local machine — no remote setup needed.
Options:
  --dangerously-skip-permissions  Skip all permission prompts on the remote
                                  (dangerous)
  -h, --help                      Display help for command
  --local                         e2e test mode — spawn the child CLI locally
                                  (skip ssh/deploy). Exercises the auth proxy
                                  and unix-socket plumbing without a remote
                                  host.
  --permission-mode <mode>        Permission mode for the remote session
```

真实 sshd 的端到端记录见 project 研究资料（`research/probe/ssh/`），本文档采集环境没有远端主机。

## 详细说明

以下内容自原 README 迁入，保持原文。

#### SSH Remote

`claude ssh` 在远端 Linux 主机执行 Claude child 与 tools，本地继续渲染 TUI、处理 permission prompt 和 interrupt：

```bash
claude ssh user@example.com
claude ssh my-ssh-alias ~/project
claude --model gateway-model ssh managed-config-id /srv/project
```

host 可以是 `user@host`、`~/.ssh/config` alias，或 settings 中的 `sshConfigs` ID：

```json
{
  "sshConfigs": [
    {
      "id": "managed-config-id",
      "name": "Managed Linux",
      "sshHost": "user@example.com",
      "sshPort": 2222,
      "sshIdentityFile": "/path/to/private-key",
      "startDirectory": "~/project"
    }
  ]
}
```

启动时会探测 Linux architecture，按当前版本选择并部署 `linux-x64-baseline` 或 `linux-arm64` binary。若当前可执行文件旁的 `dist/release/` 下存在对应的 `claude-code-v<version>-<target>` artifact，会直接使用（不做 checksum 校验）；不存在时才回退到 GitHub Release，且下载必须同时提供对应 asset 与 `SHA256SUMS.txt`，checksum 缺失或不匹配时拒绝启动。remote cache 位于 `~/.cache/claude-ssh/<version>/<target>/claude`。

模型 API/OAuth credential 不会复制到远端。远端 child 仅连接 reverse-forwarded Unix socket，由本地 proxy 按当前 provider 和本地 credential precedence 注入认证；OpenAI/Anthropic API key、OAuth token、account ID、cookie、client certificate/key/passphrase、`ANTHROPIC_CUSTOM_HEADERS` 和本地 base URL 不会通过 SSH child environment 继承。代理会在本地应用自定义 header 与网络代理设置，并在转发前替换认证 header。

`--settings` 与 `--setting-sources` 始终由本地 launcher 读取，用于解析 `sshConfigs`、provider、upstream 和认证；原始路径、inline JSON 与 secret 不会进入远端 argv。`--model` 或本地 settings 解析出的 model 会显式转发给 remote child。tools、skills、plugins、hooks、MCP、文件索引、项目上下文和 transcript 则由远端 child 及其远端 settings 管理。

连接或 resume 时，本地 UI 会先从远端 canonical transcript 完成 history bootstrap，再接受新输入；消息 UUID、hidden/meta 消息、compact boundary 和 live echo 会按远端 identity 合并去重。正常退出时显示包含原始 target、远端 cwd 和远端 session ID 的完整 `claude ssh ... --resume ...` 命令。本地不保存第二份可 resume transcript，当前也不自动重连断开的 SSH session。

SSH PromptInput 的 `@` fuzzy/path 候选来自远端文件索引和目录扫描，不会读取本机 workspace。目录选择可以继续补全下一级；cold index 完成后会对仍有效的 query 有界刷新。包含空格、引号、反斜杠、美元符号、反引号或 Unicode 的路径会使用可逆 quoted mention，例如：

```text
@"docs/path with spaces/file.md"
```

SSH Remote 当前只支持 interactive TUI。`!command` 在远端 cwd 直接执行并将转义后的结果写入远端 transcript；远端 Agent progress、Bash 和未知 MCP tool card 可在本地显示，但 display-only fallback 不能在本地执行。permission allow/deny/cancel、`/yolo`、Shift+Tab、永久规则、additional workspace directory、Esc interrupt、正常退出和断线均经 capability-protected control channel 同步；启用 `planModeAvailable: true` 时也同步 `/plan`。workspace directory 的存在性由远端验证。

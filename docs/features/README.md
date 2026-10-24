# 功能文档索引

每个功能一个文件：先用白话说明它是什么、什么时候用，再分步演示怎么用（附终端截图或实际输出），最后是配置、按键和已知问题。部分文件末尾保留了从原 README 迁入的详细参考。

效果画面来自 dev 分支重新构建的 `./built-claude`（`make build`），在 110×36 的 tmux pane 中实际运行后用 `tmux capture-pane` 截取。模型请求打到本地脚本化的假 Messages API（回复固定为 `FAKE_DONE`，提示词里的 `DO<<Tool|{json}>>` 让它发出对应工具调用），因此画面中的模型回复不代表真实模型输出；临时目录路径已缩写为 `~/work` 与 `~`，并去掉了与功能无关的安装提示行。

| 领域 | 功能 | 说明 |
| --- | --- | --- |
| 模型与 Provider | [OpenAI / Codex provider](openai-provider.md) | OpenAI Responses API、ChatGPT OAuth / API key、OpenAI 下的 `/fast` 与 remote compaction |
|  | [模型自动发现与 Gateway](model-discovery.md) | OpenAI `/v1/models` 与 Anthropic 网关模型发现，结果进入 Model Picker |
|  | [请求韧性：重试、回退模型与默认模型](request-resilience.md) | stream idle watchdog、重试上限、无人值守重试、`fallbackModel` 链、`ANTHROPIC_DEFAULT_MODEL` |
|  | [Effort 档位](effort.md) | `none`…`ultracode` 九档 effort，会话、settings、环境变量与 SubAgent 按次指定 |
|  | [Codex Apps](codex-apps.md) | ChatGPT OAuth 下把 Codex Apps 接成 host-owned MCP 工具与 hosted skills，支持 `@codex-app:` mention |
| Agent 与编排 | [Agent 与后台任务](agents.md) | 前台/后台 Agent、续跑、`Explore`/`Plan`、按次 `model`/`effort`、worktree 隔离、子代理权限跟随、`SubagentHandback` |
|  | [Agent Teams](agent-teams.md) | 让 Claude 组一个小团队：一个负责人带几个队友并行干活，互相发消息、共享任务清单 |
|  | [Dynamic Workflow](workflows.md) | 让 Claude 写一段编排脚本，一次调度多个子 Agent 分阶段、并行地干活；`/workflows` 看进度、保存成可复用的流程 |
|  | [背景会话、daemon 与 agents 视图](background-sessions.md) | 把任务交给后台跑、终端立刻空出来；`claude agents` 一屏看谁在等你、谁在干活、谁做完了 |
|  | [独立会话通信](peer-messaging.md) | 同机独立 CLI 会话经 UDS / named pipe 互发纯文本，`ListAgents` / `SendMessage` / `/peers` |
| 权限与安全 | [权限规则、权限模式与 Safe mode](permissions.md) | Claude 什么时候要先问你：用规则提前放行或禁止，用模式整体调松或调紧；受保护路径在任何模式下都会问 |
|  | [自动模式（Auto mode）](auto-mode.md) | 分类器代替人工审批；`autoMode` 规则只读可信来源，`/permissions` Auto mode 分页、`claude auto-mode` |
|  | [Hooks 事件、匹配与输出校验](hooks.md) | 在 Claude 做某件事之前或之后自动跑你的脚本：拦住危险命令、改完自动格式化、开局注入上下文 |
| 工具 | [Terminal 工具](terminal-tool.md) | 持久 PTY session：`new-session`、`send-keys`、`capture-pane`、resize、signal，按 Bash 规则判权限 |
|  | [Monitor 工具](monitor-tool.md) | 后台运行监看脚本，每行输出唤醒模型；Bash 前景 `sleep` 改用 Monitor |
|  | [定时任务：Cron、/loop 与 ScheduleWakeup](scheduled-tasks.md) | `CronCreate/Delete/List`、session-only 或 durable 任务、`/loop` 自定节奏 |
|  | [终端程序状态（OSC 7501）](terminal-status.md) | 支持 OSC 7501 的终端里上报 idle/working/blocked/done/error 状态 |
| 上下文与记忆 | [记忆：auto memory 与 SQLite FTS5 检索](memory.md) | auto memory、后台提取、Session Memory、`memory.sqlite` 的 `SearchMemory` 与自动召回、`/setup-memory-db` |
|  | [自动压缩窗口](compaction.md) | `/autocompact`、按模型 / 按 agent 的压缩窗口、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
|  | [Prompt context 与 Tool search](prompt-context.md) | 分层 cache boundary、增量 agent listing、MCP 工具汇总；自定义网关下 tool search 保持开启 |
|  | [用量、成本与状态](usage-and-cost.md) | `/usage`（含 `/cost`、`/stats`）、ChatGPT plan 与 Codex limits、Fable 周额度、成本快照跨 resume 保留 |
| 界面与交互 | [会话命令](session-commands.md) | `/recap`、`/cd`、`/focus`、`/skill-doctor`、`/autocompact`、`/usage`、`/reload-*`、`/diff`、`/workflows`、`/list-agents` |
|  | [自主 Goal](goal.md) | `/goal` / `SetGoal` 设定目标，Stop hook 检查完成度，可跨 resume 恢复 |
|  | [快捷键与 Vim 模式](keybindings-vim.md) | `keybindings.json` 热重载、send-now / queue-submit、`Ctrl+J`、Vim `%` 与 VISUAL 模式 |
|  | [自定义 UI / Branding 与 Status line](branding.md) | `uiName` 改名、`clawd.txt` 自定义 Logo、statusLine 输入含 `goal.active` |
|  | [/diff 视图](diff-view.md) | 全屏右侧 diff 面板：会话 / 未提交 / 分支三种基准、按轮次回看、把单个文件 diff 附到下一条提示 |
|  | [调试日志](debugging.md) | `--debug [filter]`、`--debug-file`，全屏 footer 的 Debug 标记 |
|  | [遥测与反馈](telemetry.md) | Anthropic 一方遥测默认关闭；`/feedback` 与问卷跟随开关；OTel `tool_decision` 带权限模式 |
| 远程执行 | [Direct Connect](direct-connect.md) | `claude server` 在执行端起 session server，本地用 `cc://host:port/token` 连接 |
|  | [SSH Remote](ssh-remote.md) | `claude ssh <host> [dir]` 在远端 Linux 跑 child 与工具，本地渲染 TUI，凭据只在本地 proxy 注入 |
| 插件与扩展 | [插件与 Marketplace](plugins-marketplace.md) | `--plugin-dir`/`--plugin-url`、manifest `defaultEnabled`、Esonhugh-Marketplace、热加载与回滚 |
|  | [MCP 配置与认证](mcp.md) | 逐 server 校验、`timeout`/`alwaysLoad`/`oauth.scopes`、`claude mcp login/logout`、`/mcp reconnect all` |
|  | [Skills](skills.md) | bundled / user / project / plugin skills、`/reload-skills`、`context: fork` 指定 agent、`/skill-doctor` |
|  | [Channels](channels.md) | `--channels` 让批准的频道插件 / MCP server 把消息推入会话，支持远程工具审批 |
|  | [Mods / Function Hooks](mods.md) | 可信插件经 `hooks/modules` 接入生命周期、tool/prompt/turn middleware、动态命令与终端 Pane（基线官方 2.1.303） |
|  | [Mods 远程客户端（stream-json）](mods-sdk-client.md) | SDK 父进程启动时传入插件、远程绘制 / 焦点 / 滚动 / 草稿编辑协议 |
|  | [Agent SDK 与 stream-json 控制协议](agent-sdk.md) | 兼容 Agent SDK 0.3：`reload_skills`、`read_file`、`update_settings`、模型 / 权限模式切换校验、动态 MCP |
| 开发与发布 | [构建、发布与终端验收工具](build-and-release.md) | Bun 构建、bytecode binary、binary-only npm 发布、内嵌 ripgrep、Linux 发布门禁与终端采集 |

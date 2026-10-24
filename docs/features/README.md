# 功能文档索引

每个功能一个文件：先用白话说明它是什么、什么时候用，再分步演示怎么用（附终端截图或实际输出），最后是配置、按键和已知问题。部分文件末尾保留了从原 README 迁入的详细参考。

效果画面来自 dev 分支重新构建的 `./built-claude`（`make build`），在 110×36 的 tmux pane 中实际运行后用 `tmux capture-pane` 截取。模型请求打到本地脚本化的假 Messages API（回复固定为 `FAKE_DONE`，提示词里的 `DO<<Tool|{json}>>` 让它发出对应工具调用），因此画面中的模型回复不代表真实模型输出；临时目录路径已缩写为 `~/work` 与 `~`，并去掉了与功能无关的安装提示行。

| 领域 | 功能 | 说明 |
| --- | --- | --- |
| 模型与 Provider | [OpenAI / Codex provider](openai-provider.md) | 把 Claude Code 的模型换成 OpenAI（GPT / Codex）：用 ChatGPT 账号登录或 API key，工具、界面、命令照常使用 |
|  | [模型自动发现与 Gateway](model-discovery.md) | 走自己的 API 网关或 OpenAI 兼容服务时，自动把网关提供的模型列进 `/model`，不用手打模型名 |
|  | [请求韧性：重试、回退模型与默认模型](request-resilience.md) | API 过载或断线时自动重试；主模型一直过载就换备用模型；可以让无人值守任务一直等到额度恢复 |
|  | [Effort 档位](effort.md) | 控制 Claude 每次「想多深」：低档快而省，高档慢而仔细；可全局设、按会话切，也可给子代理单独指定 |
|  | [Codex Apps](codex-apps.md) | 用 ChatGPT 账号登录 OpenAI provider 时，直接使用 ChatGPT 里连好的 App（GitHub、Gmail 等）：输入 `@codex-app:` 点名即可 |
| Agent 与编排 | [Agent 与后台任务](agents.md) | Claude 把一部分工作交给「子代理」在后台做，你继续聊；可以查看、停止、续跑，也可以自己定义专用子代理 |
|  | [Agent Teams](agent-teams.md) | 让 Claude 组一个小团队：一个负责人带几个队友并行干活，互相发消息、共享任务清单 |
|  | [Dynamic Workflow](workflows.md) | 让 Claude 写一段编排脚本，一次调度多个子 Agent 分阶段、并行地干活；`/workflows` 看进度、保存成可复用的流程 |
|  | [背景会话、daemon 与 agents 视图](background-sessions.md) | 把任务交给后台跑、终端立刻空出来；`claude agents` 一屏看谁在等你、谁在干活、谁做完了 |
|  | [独立会话通信](peer-messaging.md) | 同一台机器上开着的几个 Claude 会话可以互相发现、互发消息：一个写代码，一个做 review，完成了喊一声 |
| 权限与安全 | [权限规则、权限模式与 Safe mode](permissions.md) | Claude 什么时候要先问你：用规则提前放行或禁止，用模式整体调松或调紧；受保护路径在任何模式下都会问 |
|  | [自动模式（Auto mode）](auto-mode.md) | 不用一条条点确认：由分类器判断每个操作是否安全，安全的直接做，危险的拦下；可以用一句话加自己的规则 |
|  | [Hooks 事件、匹配与输出校验](hooks.md) | 在 Claude 做某件事之前或之后自动跑你的脚本：拦住危险命令、改完自动格式化、开局注入上下文 |
| 工具 | [Terminal 工具](terminal-tool.md) | 给 Claude 一个能持续交互的终端：开 REPL、操作 TUI、按 Ctrl+C，跑完自动通知 |
|  | [Monitor 工具](monitor-tool.md) | 让 Claude 在后台盯着日志或命令输出，有新内容就自动叫醒它，不用反复 sleep 轮询 |
|  | [定时任务：Cron、/loop 与 ScheduleWakeup](scheduled-tasks.md) | 让 Claude 按时间自动做事：「每 5 分钟看一下构建」「工作日早上 9 点汇总 PR」；`/loop` 一句话设定 |
|  | [终端程序状态（OSC 7501）](terminal-status.md) | 支持的终端能在标签页上显示 Claude 正在忙、在等你批准、还是已经做完，不用切回来看 |
| 上下文与记忆 | [记忆：auto memory 与 SQLite FTS5 检索](memory.md) | Claude 把跨会话有用的事（项目约定、你的偏好）记到文件里，下次自动带上；可改成 SQLite 全文检索，按需查找 |
|  | [自动压缩窗口](compaction.md) | 对话太长时把早期内容压成摘要；`/autocompact` 决定多长时压缩（按模型分别保存），`/compact` 手动压缩 |
|  | [Prompt context 与 Tool search](prompt-context.md) | 分层 cache boundary、增量 agent listing、MCP 工具汇总；自定义网关下 tool search 保持开启 |
|  | [用量、成本与状态](usage-and-cost.md) | `/usage` 看本次会话花了多少钱、用了多少 token；`/stats` 看长期使用习惯；恢复会话后成本继续累计 |
| 界面与交互 | [会话命令](session-commands.md) | 本 fork 新增或补齐的斜杠命令：`/recap` 回顾、`/cd` 换目录、`/focus` 精简显示、`/autocompact` 调压缩时机、`/usage` 用量等 |
|  | [自主 Goal](goal.md) | 给 Claude 一个「做到才算完」的条件（如「所有测试通过」），每轮结束时自动检查，没达成就继续干 |
|  | [快捷键与 Vim 模式](keybindings-vim.md) | 自己改快捷键、回合中途排队或立即插话、在输入框里用 Vim 的选择和括号跳转 |
|  | [自定义 UI / Branding 与 Status line](branding.md) | 改界面上显示的产品名、换掉 Logo 的 ASCII 图，用自己的脚本定制底部状态栏 |
|  | [/diff 视图](diff-view.md) | 全屏右侧 diff 面板：会话 / 未提交 / 分支三种基准、按轮次回看、把单个文件 diff 附到下一条提示 |
|  | [调试日志](debugging.md) | 遇到问题时打开详细日志，看清楚 Claude Code 在后台做了什么、请求发到了哪 |
|  | [遥测与反馈](telemetry.md) | 默认不向 Anthropic 发送使用数据，`/feedback` 也随之隐藏；需要时一个环境变量打开 |
| 远程执行 | [Direct Connect](direct-connect.md) | 在一台机器上 `claude server`，在另一处用 `claude cc://...` 连过去：工具在 server 上执行，界面和权限确认在你这边 |
|  | [SSH Remote](ssh-remote.md) | `claude ssh 主机` 让 Claude 在远程 Linux 机器上读写文件、跑命令，界面和权限确认留在本机；API 凭据不离开本机 |
| 插件与扩展 | [插件与 Marketplace](plugins-marketplace.md) | 从插件市场一键安装命令、skill、agent、hook 和 MCP；团队可以自建 marketplace，装完 `/reload-plugins` 立即生效 |
|  | [MCP 配置与认证](mcp.md) | 接入外部工具服务器（数据库、浏览器、内部 API 等）；配置错一条只跳过那一条，`/mcp` 查看状态、重连、登录 |
|  | [Skills](skills.md) | 把一套做事步骤写进 SKILL.md，用 `/名字` 调用，或让 Claude 在合适时自动使用；`/skill-doctor` 找出从没用过却占提示的 skill |
|  | [Channels](channels.md) | 让 Telegram、Discord 或你自己写的 MCP server 把消息推进正在运行的会话，还能在手机上远程批准工具调用 |
|  | [Mods / Function Hooks](mods.md) | 用一个 JS/TS 文件改造 Claude 本身：加命令、拦截或改写工具调用、在界面上加状态条和侧边面板（基线官方 2.1.303） |
|  | [Mods 远程客户端（stream-json）](mods-sdk-client.md) | 给桌面 / IDE 等外部界面用的协议：通过 stream-json 让 Mod 把界面画到你自己的前端上，并把点击、输入传回来 |
|  | [Agent SDK 与 stream-json 控制协议](agent-sdk.md) | 在自己的程序里调用 Claude：官方 Agent SDK（TS / Python）可以直接驱动本 fork 的 CLI；补齐了 SDK 0.3 会用到的控制请求 |
| 开发与发布 | [构建、发布与终端验收工具](build-and-release.md) | Bun 构建、bytecode binary、binary-only npm 发布、内嵌 ripgrep、Linux 发布门禁与终端采集 |

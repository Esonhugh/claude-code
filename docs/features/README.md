# 功能文档索引

<!-- lang: zh-Hans -->

每个功能一个文件：先用白话说明它是什么、什么时候用，再分步演示怎么用（附终端截图或实际输出），最后是配置、按键和已知问题。部分文件末尾保留了从原 README 迁入的详细参考。

效果画面来自 dev 分支重新构建的 `./built-claude`（`make build`），在 110×36 的 tmux pane 中实际运行后用 `tmux capture-pane` 截取。模型请求打到本地脚本化的假 Messages API（按提示词返回预先写好的回复和工具调用），因此画面中的模型回复不代表真实模型输出；演示用的家目录是 `~`，项目目录是 `~/sc`。

## 缓存命中 / Cache hit

本 fork 与官方 Claude Code、Codex、opencode、pi、oh-my-pi 跑同一批真实任务（办公、研究、编码、运维、Lean 证明，每类一短一长，另有 ssh / Kubernetes 真实环境排障；每格 3 次，2026-11-07）。命中率 = 缓存读 ÷ 全部输入，按 token 加权。

![CLI 模式命中率：每个 CLI 33 次 run 的平均值与分布](images/cache-benchmark/hit-rate-overall-light.png#gh-light-mode-only)
![CLI 模式命中率：每个 CLI 33 次 run 的平均值与分布](images/cache-benchmark/hit-rate-overall-dark.png#gh-dark-mode-only)

![每任务 token 与缓存命中率的散点](images/cache-benchmark/tokens-vs-hit-light.png#gh-light-mode-only)
![每任务 token 与缓存命中率的散点](images/cache-benchmark/tokens-vs-hit-dark.png#gh-dark-mode-only)

![每任务 API 等价花费与缓存命中率的散点](images/cache-benchmark/cost-vs-hit-light.png#gh-light-mode-only)
![每任务 API 等价花费与缓存命中率的散点](images/cache-benchmark/cost-vs-hit-dark.png#gh-dark-mode-only)

可切换横轴、悬停查看明细的[交互版散点图](https://claude.ai/artifact/5c7HFWBN11ZAVcFHConfbm)。

| CLI | 命中率（33 次） | 平均总 token | API 等价花费 / 任务 | TUI 6 轮总 token | `-p` 启动到首个请求 |
| --- | --- | --- | --- | --- | --- |
| 本仓库（Claude 账号） | 87.1% | 72.7k | $0.078 | 235k | 0.82s |
| 官方 Claude Code 2.1.319 | 87.3% | 81.0k | $0.088 | 640k | 0.89s |
| 本仓库（ChatGPT 账号） | 85.3% | 75.9k | $0.050 | 310k | 0.71s |
| Codex CLI 0.167.0 | 88.8% | 80.3k | $0.047 | 267k | 2.59s |
| opencode 1.19.5 | 89.2% | 81.5k | $0.059 | 170k | 2.81s |
| pi 1.5.0 | 84.0% | 36.5k | $0.041 | 80k | 0.83s |

- Claude 侧与官方持平，总 token 少 10%；TUI 多轮交互官方用量是本仓库的 2.7 倍。
- ChatGPT 侧与 Codex 的差距只在短任务（82.9% 对 89.7%，长任务 86.5% 对 88.3%）：Codex 的系统提示在服务器端，新会话第一个请求未缓存的部分更少。
- pi、opencode 在 Claude 侧只写 5 分钟缓存，闲置 15 分钟以上第一个请求就降到 0–27%；本仓库与官方写 1 小时缓存。
- 测试设计、完整指标、多代理、长时间闲置、oh-my-pi、ssh / k8s 排障、稳定性与启动数据见 [缓存命中与用户体验基准](cache-benchmark.md)。

## 功能列表

| 领域 | 功能 | 说明 |
| --- | --- | --- |
| 模型与 Provider | [OpenAI / Codex provider](openai-provider.md) | 把 Claude Code 的模型换成 OpenAI（GPT / Codex）：用 ChatGPT 账号登录或 API key，工具、界面、命令照常使用 |
|  | [OpenAI 网络安全档位（Daybreak）](openai-provider.md#网络安全访问档位daybreak) | OpenAI provider 下用 `/daybreak blue\|red\|off` 切换 OpenAI 的网络安全访问档位，请求自动带上 `access_programs` |
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
|  | [Bash 沙箱](sandbox.md) | 让 Claude 跑的命令只能写项目目录、只能连你允许的域名、读不到你指定的密钥；开了以后命令可以不再逐条确认 |
| 工具 | [Tmux 工具（原 Terminal）](terminal-tool.md) | 给 Claude 一个能持续交互的终端：开 REPL、操作 TUI、按 Ctrl+C，跑完自动通知；开了 Bash 沙箱时终端也在沙箱里跑 |
|  | [Monitor 工具](monitor-tool.md) | 让 Claude 在后台盯着日志或命令输出，有新内容就自动叫醒它，不用反复 sleep 轮询 |
|  | [定时任务：Cron、/loop 与 ScheduleWakeup](scheduled-tasks.md) | 让 Claude 按时间自动做事：「每 5 分钟看一下构建」「工作日早上 9 点汇总 PR」；`/loop` 一句话设定 |
|  | [终端程序状态（OSC 7501）](terminal-status.md) | 支持的终端能在标签页上显示 Claude 正在忙、在等你批准、还是已经做完，不用切回来看 |
| 上下文与记忆 | [记忆：auto memory 与 SQLite FTS5 检索](memory.md) | Claude 把跨会话有用的事（项目约定、你的偏好）记到文件里，下次自动带上；可改成 SQLite 全文检索，按需查找 |
|  | [自动压缩窗口](compaction.md) | 对话太长时把早期内容压成摘要；`/autocompact` 决定多长时压缩（按模型分别保存），`/compact` 手动压缩；可换成保留最近原文的 Codex 式压缩（`compact.mode: "codex"`），或用 `compact.keepRecentRatio` 让自动压缩原样多保留最近几轮 |
|  | [Prompt context 与 Tool search](prompt-context.md) | 让每次请求更省 token：提示词分层利于缓存，MCP 工具用到时才加载，大量同类工具只发一行汇总 |
|  | [缓存命中与用户体验基准](cache-benchmark.md) | 本 fork 与官方 Claude Code、Codex、opencode、pi、oh-my-pi 跑同一批真实任务：缓存命中率、token、API 等价花费、启动速度与稳定性（附图表） |
|  | [Agent 基准测试套件（bench/）](agent-bench.md) | 仓库里的基准工具：多个 CLI × Claude / ChatGPT 账号跑同一批任务，逐请求记录，算命中率、token、API 等价花费并画散点图；公开基准带防污染扰动 |
|  | [用量、成本与状态](usage-and-cost.md) | `/usage` 看本次会话花了多少钱、用了多少 token；`/stats` 看长期使用习惯；恢复会话后成本继续累计 |
| 界面与交互 | [会话命令](session-commands.md) | 本 fork 新增或补齐的斜杠命令：`/recap` 回顾、`/cd` 换目录、`/focus` 精简显示、`/autocompact` 调压缩时机、`/usage` 用量等 |
|  | [自主 Goal](goal.md) | 给 Claude 一个「做到才算完」的条件（如「所有测试通过」），每轮结束时自动检查，没达成就继续干 |
|  | [快捷键与 Vim 模式](keybindings-vim.md) | 自己改快捷键、回合中途排队或立即插话、在输入框里用 Vim 的选择和括号跳转 |
|  | [自定义 UI / Branding 与 Status line](branding.md) | 改界面上显示的产品名、换掉 Logo 的 ASCII 图，用自己的脚本定制底部状态栏 |
|  | [/diff 视图](diff-view.md) | 全屏右侧 diff 面板：会话 / 未提交 / 分支三种基准、按轮次回看、把单个文件 diff 附到下一条提示 |
|  | [Claude Web](web-ui.md) | `claude web` 在浏览器里用 Claude Code：公式、Mermaid、代码和 diff 按网页渲染，上传并预览 PDF / Office 文档、在图片和代码上直接评论，回合中途插话或立刻打断，右侧面板看状态、agent、终端抽屉、workflow 看板和后台任务，网页里切换 OAuth / API key；默认只监听本机，局域网访问需显式开启 |
|  | [Claude Web 界面导览](web-ui-tour.md) | 按一次真实操作的顺序一步一张截图：改代码、确认命令、Status、后台 agent、`@` 发消息、排队插话、终端、workflow、文件评论、项目与任务看板、深色外观 |
|  | [Claude Web 项目](web-projects.md) | 在 `claude web` 里建项目：协调者把活拆成任务派给多个 worker 并行做，右侧看每个任务的过程、批准、发消息、停止和审阅；项目和任务存在本机 SQLite，重启后能接着聊 |
|  | [调试日志](debugging.md) | 遇到问题时打开详细日志，看清楚 Claude Code 在后台做了什么、请求发到了哪 |
|  | [遥测与反馈](telemetry.md) | 默认不向 Anthropic 发送使用数据，`/feedback` 也随之隐藏；需要时一个环境变量打开 |
| 远程执行 | [Direct Connect](direct-connect.md) | 在一台机器上 `claude server`，在另一处用 `claude cc://...` 连过去：工具在 server 上执行，界面和权限确认在你这边 |
|  | [SSH Remote](ssh-remote.md) | `claude ssh 主机` 让 Claude 在远程 Linux 机器上读写文件、跑命令，界面和权限确认留在本机；API 凭据不离开本机 |
| 插件与扩展 | [插件与 Marketplace](plugins-marketplace.md) | 从插件市场一键安装命令、skill、agent、hook 和 MCP；团队可以自建 marketplace，装完 `/reload-plugins` 立即生效 |
|  | [MCP 配置与认证](mcp.md) | 接入外部工具服务器（数据库、浏览器、内部 API 等）；配置错一条只跳过那一条，`/mcp` 查看状态、重连、登录；`claude web` 能显示 MCP Apps 界面 |
|  | [Skills](skills.md) | 把一套做事步骤写进 SKILL.md，用 `/名字` 调用，或让 Claude 在合适时自动使用；`/skill-doctor` 找出从没用过却占提示的 skill |
|  | [Channels](channels.md) | 让 Telegram、Discord 或你自己写的 MCP server 把消息推进正在运行的会话，还能在手机上远程批准工具调用 |
|  | [Mods / Function Hooks](mods.md) | 用一个 JS/TS 文件改造 Claude 本身：加命令、拦截或改写工具调用、在界面上加状态条和侧边面板（基线官方 2.1.303） |
|  | [Mods 远程客户端（stream-json）](mods-sdk-client.md) | 给桌面 / IDE 等外部界面用的协议：通过 stream-json 让 Mod 把界面画到你自己的前端上，并把点击、输入传回来 |
|  | [Agent SDK 与 stream-json 控制协议](agent-sdk.md) | 在自己的程序里调用 Claude：官方 Agent SDK（TS / Python）可以直接驱动本 fork 的 CLI，用 `env` / `settings` / `plugins` 打开 fork 功能（附示例）；补齐了 SDK 0.3 会用到的控制请求 |
|  | [VS Code 插件](vscode-extension.md) | 让官方 VS Code 插件改用本 fork 运行：面板里的 `/status`、`/usage`、`/memory` 等对话框都能正常打开 |
| 开发与发布 | [构建、发布与终端验收工具](build-and-release.md) | 给贡献者：怎么从源码构建出可运行的 binary、怎么和官方版本对照、发布流程做了什么 |

<details lang="en"><summary>English</summary>

One file per feature: first a plain explanation of what it is and when to use it, then a step-by-step walkthrough (with terminal screenshots or real output), and finally settings, keys and known issues. Some files keep detailed reference material moved over from the old README at the end.

Screens come from `./built-claude` rebuilt from the dev branch (`make build`), run for real in a 110×36 tmux pane and captured with `tmux capture-pane`. Model requests go to a local scripted fake Messages API (it returns prewritten replies and tool calls for each prompt), so model replies on screen are not real model output. The demo home directory is `~` and the project directory is `~/sc`.

## Cache hit

This fork runs the same real tasks as the official Claude Code, Codex, opencode, pi and oh-my-pi (office, research, coding, ops and Lean proofs, one short and one long per category, plus troubleshooting real ssh / Kubernetes environments; 3 runs per cell, 2026-11-07). Hit rate = cache reads ÷ all input, weighted by tokens.

![CLI-mode hit rate: mean and spread over 33 runs per CLI](images/cache-benchmark/hit-rate-overall-light.png#gh-light-mode-only)
![CLI-mode hit rate: mean and spread over 33 runs per CLI](images/cache-benchmark/hit-rate-overall-dark.png#gh-dark-mode-only)

![Tokens per task against cache hit rate](images/cache-benchmark/tokens-vs-hit-light.png#gh-light-mode-only)
![Tokens per task against cache hit rate](images/cache-benchmark/tokens-vs-hit-dark.png#gh-dark-mode-only)

![API-equivalent cost per task against cache hit rate](images/cache-benchmark/cost-vs-hit-light.png#gh-light-mode-only)
![API-equivalent cost per task against cache hit rate](images/cache-benchmark/cost-vs-hit-dark.png#gh-dark-mode-only)

An [interactive scatter plot](https://claude.ai/artifact/5c7HFWBN11ZAVcFHConfbm) lets you switch the x-axis and hover for details.

| CLI | Hit rate (33 runs) | Mean total tokens | API-equivalent cost / task | TUI 6-turn total tokens | `-p` start to first request |
| --- | --- | --- | --- | --- | --- |
| This repo (Claude account) | 87.1% | 72.7k | $0.078 | 235k | 0.82s |
| Official Claude Code 2.1.319 | 87.3% | 81.0k | $0.088 | 640k | 0.89s |
| This repo (ChatGPT account) | 85.3% | 75.9k | $0.050 | 310k | 0.71s |
| Codex CLI 0.167.0 | 88.8% | 80.3k | $0.047 | 267k | 2.59s |
| opencode 1.19.5 | 89.2% | 81.5k | $0.059 | 170k | 2.81s |
| pi 1.5.0 | 84.0% | 36.5k | $0.041 | 80k | 0.83s |

- The Claude side matches the official CLI with 10% fewer total tokens; in multi-turn TUI use the official CLI uses 2.7 times as many tokens as this repo.
- On the ChatGPT side the gap to Codex is only on short tasks (82.9% vs 89.7%; long tasks 86.5% vs 88.3%): Codex keeps its system prompt on the server, so less of a new session's first request is uncached.
- pi and opencode only write the 5-minute cache on the Claude side, so after 15 or more idle minutes their first request drops to 0–27%; this repo and the official CLI write the 1-hour cache.
- Test design, all metrics, multi-agent, long idle, oh-my-pi, ssh / k8s troubleshooting, stability and startup data are in the [cache hit and user experience benchmark](cache-benchmark.md).

## Features

| Area | Feature | Description |
| --- | --- | --- |
| Models and providers | [OpenAI / Codex provider](openai-provider.md) | Swap Claude Code's model for OpenAI (GPT / Codex): sign in with a ChatGPT account or an API key; tools, UI and commands work as usual |
|  | [OpenAI cybersecurity access tier (Daybreak)](openai-provider.md#网络安全访问档位daybreak) | With the OpenAI provider, `/daybreak blue\|red\|off` switches OpenAI's cybersecurity access tier and requests carry `access_programs` automatically |
|  | [Model discovery and gateways](model-discovery.md) | When you use your own API gateway or an OpenAI-compatible service, the gateway's models appear in `/model` automatically, no typing model names |
|  | [Request resilience: retries, fallback and default models](request-resilience.md) | Retries automatically on API overload or dropped connections; switches to a fallback model if the main one stays overloaded; unattended tasks can wait until quota comes back |
|  | [Effort levels](effort.md) | How hard Claude thinks each time: low is fast and cheap, high is slow and careful; set it globally, per session, or per subagent |
|  | [Codex Apps](codex-apps.md) | With the OpenAI provider on a ChatGPT account, use the apps you connected in ChatGPT (GitHub, Gmail and more) directly: mention them with `@codex-app:` |
| Agents and orchestration | [Agents and background tasks](agents.md) | Claude hands part of the work to subagents in the background while you keep talking; inspect, stop or resume them, or define your own |
|  | [Agent Teams](agent-teams.md) | Claude forms a small team: a lead with several teammates working in parallel, messaging each other and sharing a task list |
|  | [Dynamic Workflow](workflows.md) | Claude writes an orchestration script that dispatches many sub-agents in phases and in parallel; `/workflows` shows progress, and good runs can be saved for reuse |
|  | [Background sessions, the daemon and the agents view](background-sessions.md) | Hand a task to the background and get your terminal back at once; `claude agents` shows who is waiting for you, who is working and who is done |
|  | [Peer messaging](peer-messaging.md) | Claude sessions open on the same machine can find and message each other: one writes code, one reviews, and they call out when done |
| Permissions and security | [Permission rules, modes and Safe mode](permissions.md) | When Claude asks you first: rules allow or deny ahead of time, modes loosen or tighten everything; protected paths ask in every mode |
|  | [Auto mode](auto-mode.md) | No more clicking to confirm each step: a classifier judges each action, runs the safe ones and blocks the risky ones; add your own rules in one sentence |
|  | [Hook events, matching and output checks](hooks.md) | Run your scripts before or after Claude does something: block dangerous commands, format after edits, inject context at session start |
|  | [Bash sandbox](sandbox.md) | Commands Claude runs can only write the project directory, reach the domains you allow and never read the secrets you name; with it on, commands no longer need one-by-one approval |
| Tools | [Tmux tool (formerly Terminal)](terminal-tool.md) | A terminal Claude can keep interacting with: open a REPL, drive a TUI, press Ctrl+C, get notified when done; it also runs in the Bash sandbox when that is on |
|  | [Monitor tool](monitor-tool.md) | Claude watches logs or command output in the background and is woken by each new line, instead of polling with sleep |
|  | [Scheduled tasks: Cron, /loop and ScheduleWakeup](scheduled-tasks.md) | Claude does things on a schedule: "check the build every 5 minutes", "summarise PRs at 9 a.m. on weekdays"; `/loop` sets it up in one sentence |
|  | [Terminal program status (OSC 7501)](terminal-status.md) | Terminals that support it show on the tab whether Claude is busy, waiting for approval or done, without switching back to look |
| Context and memory | [Memory: auto memory and SQLite FTS5 search](memory.md) | Claude writes down what is useful across sessions (project conventions, your preferences) and brings it next time; can switch to SQLite full-text search on demand |
|  | [Auto-compact window](compaction.md) | Summarises early content when a conversation gets too long; `/autocompact` sets when (saved per model), `/compact` compacts by hand; Codex-style compaction keeps recent text verbatim (`compact.mode: "codex"`), or `compact.keepRecentRatio` keeps more recent rounds verbatim in auto-compact |
|  | [Prompt context and Tool search](prompt-context.md) | Fewer tokens per request: a layered prompt that caches well, MCP tools loaded only when used, one summary line for large tool families |
|  | [Cache hit and user experience benchmark](cache-benchmark.md) | This fork against the official Claude Code, Codex, opencode, pi and oh-my-pi on the same real tasks: cache hit rate, tokens, API-equivalent cost, startup speed and stability (with charts) |
|  | [Agent benchmark suite (bench/)](agent-bench.md) | The benchmark tool in the repo: several CLIs × Claude / ChatGPT accounts on the same tasks, every request logged, hit rate, tokens and API-equivalent cost computed and plotted; public benchmarks get anti-contamination perturbation |
|  | [Usage, cost and status](usage-and-cost.md) | `/usage` shows what this session cost and how many tokens it used; `/stats` shows long-term habits; cost keeps adding up after a resume |
| UI and interaction | [Session commands](session-commands.md) | Slash commands this fork adds or completes: `/recap` to review, `/cd` to change directory, `/focus` for a lean view, `/autocompact` for compaction timing, `/usage` for usage and more |
|  | [Autonomous Goal](goal.md) | Give Claude a "done only when" condition (such as "all tests pass"); it is checked after each turn and Claude keeps going until it holds |
|  | [Keybindings and Vim mode](keybindings-vim.md) | Change keybindings, queue or interject mid-turn, and use Vim selection and bracket jumps in the input box |
|  | [Custom UI / branding and status line](branding.md) | Change the product name shown in the UI, replace the ASCII logo, and customise the bottom status line with your own script |
|  | [/diff view](diff-view.md) | A fullscreen diff panel on the right: session, uncommitted or branch baselines, review by turn, attach one file's diff to the next prompt |
|  | [Claude Web](web-ui.md) | `claude web` puts Claude Code in the browser: math, Mermaid, code and diffs rendered as web content, PDF / Office upload and preview, comments on images and code, interject or stop mid-turn, a right panel for status, agents, the terminal drawer, the workflow board and background tasks, OAuth / API key switching in the page; listens only on localhost unless LAN access is turned on explicitly |
|  | [Claude Web tour](web-ui-tour.md) | One screenshot per step, in the order of a real session: change code, approve a command, Status, a background agent, `@` messages, queued interjections, the terminal, workflows, file comments, the project and task board, dark theme |
|  | [Claude Web projects](web-projects.md) | Create a project in `claude web`: a coordinator splits the work into tasks for several workers in parallel; on the right, follow, approve, message, stop and review each task; projects and tasks live in local SQLite and survive a restart |
|  | [Debug logs](debugging.md) | Turn on detailed logs when something is wrong to see what Claude Code did behind the scenes and where requests went |
|  | [Telemetry and feedback](telemetry.md) | No usage data goes to Anthropic by default, and `/feedback` is hidden with it; one environment variable turns it on when needed |
| Remote execution | [Direct Connect](direct-connect.md) | Run `claude server` on one machine and `claude cc://...` from another: tools run on the server, the UI and permission prompts stay with you |
|  | [SSH Remote](ssh-remote.md) | `claude ssh host` lets Claude read and write files and run commands on a remote Linux machine while the UI and permission prompts stay local; API credentials never leave your machine |
| Plugins and extensions | [Plugins and marketplaces](plugins-marketplace.md) | Install commands, skills, agents, hooks and MCP servers from a marketplace in one step; teams can host their own marketplace; `/reload-plugins` applies them at once |
|  | [MCP configuration and auth](mcp.md) | Connect external tool servers (databases, browsers, internal APIs and more); one bad entry only skips that entry; `/mcp` shows status, reconnects and signs in; `claude web` shows MCP Apps UIs |
|  | [Skills](skills.md) | Write a procedure into SKILL.md and call it with `/name`, or let Claude use it when it fits; `/skill-doctor` finds skills that take prompt space but are never used |
|  | [Channels](channels.md) | Telegram, Discord or your own MCP server push messages into a running session, and you can approve tool calls remotely from your phone |
|  | [Mods / Function Hooks](mods.md) | Reshape Claude itself with one JS/TS file: add commands, intercept or rewrite tool calls, add status bands and side panels to the UI (baseline official 2.1.303) |
|  | [Mods remote client (stream-json)](mods-sdk-client.md) | A protocol for desktop, IDE and other outside front ends: over stream-json, Mods draw their UI in your own front end and get clicks and input back |
|  | [Agent SDK and the stream-json control protocol](agent-sdk.md) | Call Claude from your own program: the official Agent SDK (TS / Python) can drive this fork's CLI directly, with `env` / `settings` / `plugins` turning on fork features (with examples); adds the control requests SDK 0.3 uses |
|  | [VS Code extension](vscode-extension.md) | Run the official VS Code extension on this fork: `/status`, `/usage`, `/memory` and other dialogs in its panel open normally |
| Development and release | [Build, release and terminal acceptance tools](build-and-release.md) | For contributors: how to build a working binary from source, compare it with the official build, and what the release pipeline does |

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

每個功能一個檔案：先用白話說明它是什麼、什麼時候用，再分步演示怎麼用（附終端截圖或實際輸出），最後是配置、按鍵和已知問題。部分檔案末尾保留了從原 README 遷入的詳細參考。

效果畫面來自 dev 分支重新構建的 `./built-claude`（`make build`），在 110×36 的 tmux pane 中實際執行後用 `tmux capture-pane` 擷取。模型請求打到本地腳本化的假 Messages API（按提示詞返回預先寫好的回覆和工具呼叫），因此畫面中的模型回覆不代表真實模型輸出；演示用的家目錄是 `~`，專案目錄是 `~/sc`。

## 快取命中 / Cache hit

本 fork 與官方 Claude Code、Codex、opencode、pi、oh-my-pi 跑同一批真實任務（辦公、研究、編碼、運維、Lean 證明，每類一短一長，另有 ssh / Kubernetes 真實環境排障；每格 3 次，2026-11-07）。命中率 = 快取讀 ÷ 全部輸入，按 token 加權。

![CLI 模式命中率：每個 CLI 33 次 run 的平均值與分佈](images/cache-benchmark/hit-rate-overall-light.png#gh-light-mode-only)
![CLI 模式命中率：每個 CLI 33 次 run 的平均值與分佈](images/cache-benchmark/hit-rate-overall-dark.png#gh-dark-mode-only)

![每任務 token 與快取命中率的散點](images/cache-benchmark/tokens-vs-hit-light.png#gh-light-mode-only)
![每任務 token 與快取命中率的散點](images/cache-benchmark/tokens-vs-hit-dark.png#gh-dark-mode-only)

![每任務 API 等價花費與快取命中率的散點](images/cache-benchmark/cost-vs-hit-light.png#gh-light-mode-only)
![每任務 API 等價花費與快取命中率的散點](images/cache-benchmark/cost-vs-hit-dark.png#gh-dark-mode-only)

可切換橫軸、懸停檢視明細的[互動版散點圖](https://claude.ai/artifact/5c7HFWBN11ZAVcFHConfbm)。

| CLI | 命中率（33 次） | 平均總 token | API 等價花費 / 任務 | TUI 6 輪總 token | `-p` 啟動到首個請求 |
| --- | --- | --- | --- | --- | --- |
| 本倉庫（Claude 帳號） | 87.1% | 72.7k | $0.078 | 235k | 0.82s |
| 官方 Claude Code 2.1.319 | 87.3% | 81.0k | $0.088 | 640k | 0.89s |
| 本倉庫（ChatGPT 帳號） | 85.3% | 75.9k | $0.050 | 310k | 0.71s |
| Codex CLI 0.167.0 | 88.8% | 80.3k | $0.047 | 267k | 2.59s |
| opencode 1.19.5 | 89.2% | 81.5k | $0.059 | 170k | 2.81s |
| pi 1.5.0 | 84.0% | 36.5k | $0.041 | 80k | 0.83s |

- Claude 側與官方持平，總 token 少 10%；TUI 多輪互動官方用量是本倉庫的 2.7 倍。
- ChatGPT 側與 Codex 的差距只在短任務（82.9% 對 89.7%，長任務 86.5% 對 88.3%）：Codex 的系統提示在伺服器端，新會話第一個請求未快取的部分更少。
- pi、opencode 在 Claude 側只寫 5 分鐘快取，閒置 15 分鐘以上第一個請求就降到 0–27%；本倉庫與官方寫 1 小時快取。
- 測試設計、完整指標、多代理、長時間閒置、oh-my-pi、ssh / k8s 排障、穩定性與啟動資料見 [快取命中與使用者體驗基準](cache-benchmark.md)。

## 功能列表

| 領域 | 功能 | 說明 |
| --- | --- | --- |
| 模型與 Provider | [OpenAI / Codex provider](openai-provider.md) | 把 Claude Code 的模型換成 OpenAI（GPT / Codex）：用 ChatGPT 帳號登入或 API key，工具、介面、命令照常使用 |
|  | [OpenAI 網路安全檔位（Daybreak）](openai-provider.md#网络安全访问档位daybreak) | OpenAI provider 下用 `/daybreak blue\|red\|off` 切換 OpenAI 的網路安全訪問檔位，請求自動帶上 `access_programs` |
|  | [模型自動發現與 Gateway](model-discovery.md) | 走自己的 API 閘道或 OpenAI 相容服務時，自動把閘道提供的模型列進 `/model`，不用手打模型名 |
|  | [請求韌性：重試、回退模型與預設模型](request-resilience.md) | API 過載或斷線時自動重試；主模型一直過載就換備用模型；可以讓無人值守任務一直等到額度恢復 |
|  | [Effort 檔位](effort.md) | 控制 Claude 每次「想多深」：低檔快而省，高檔慢而仔細；可全域設、按會話切，也可給子代理單獨指定 |
|  | [Codex Apps](codex-apps.md) | 用 ChatGPT 帳號登入 OpenAI provider 時，直接使用 ChatGPT 裡連好的 App（GitHub、Gmail 等）：輸入 `@codex-app:` 點名即可 |
| Agent 與編排 | [Agent 與後台任務](agents.md) | Claude 把一部分工作交給「子代理」在後台做，你繼續聊；可以檢視、停止、續跑，也可以自己定義專用子代理 |
|  | [Agent Teams](agent-teams.md) | 讓 Claude 組一個小團隊：一個負責人帶幾個隊友並行幹活，互相發訊息、共享任務清單 |
|  | [Dynamic Workflow](workflows.md) | 讓 Claude 寫一段編排腳本，一次排程多個子 Agent 分階段、並行地幹活；`/workflows` 看進度、儲存成可複用的流程 |
|  | [背景會話、daemon 與 agents 檢視](background-sessions.md) | 把任務交給後台跑、終端立刻空出來；`claude agents` 一屏看誰在等你、誰在幹活、誰做完了 |
|  | [獨立會話通訊](peer-messaging.md) | 同一台機器上開著的幾個 Claude 會話可以互相發現、互發訊息：一個寫程式碼，一個做 review，完成了喊一聲 |
| 權限與安全 | [權限規則、權限模式與 Safe mode](permissions.md) | Claude 什麼時候要先問你：用規則提前放行或禁止，用模式整體調松或調緊；受保護路徑在任何模式下都會問 |
|  | [自動模式（Auto mode）](auto-mode.md) | 不用一條條點確認：由分類器判斷每個操作是否安全，安全的直接做，危險的攔下；可以用一句話加自己的規則 |
|  | [Hooks 事件、匹配與輸出校驗](hooks.md) | 在 Claude 做某件事之前或之後自動跑你的腳本：攔住危險命令、改完自動格式化、開局注入上下文 |
|  | [Bash 沙箱](sandbox.md) | 讓 Claude 跑的命令只能寫專案目錄、只能連你允許的域名、讀不到你指定的金鑰；開了以後命令可以不再逐條確認 |
| 工具 | [Tmux 工具（原 Terminal）](terminal-tool.md) | 給 Claude 一個能持續互動的終端：開 REPL、操作 TUI、按 Ctrl+C，跑完自動通知；開了 Bash 沙箱時終端也在沙箱裡跑 |
|  | [Monitor 工具](monitor-tool.md) | 讓 Claude 在後台盯著日誌或命令輸出，有新內容就自動叫醒它，不用反覆 sleep 輪詢 |
|  | [定時任務：Cron、/loop 與 ScheduleWakeup](scheduled-tasks.md) | 讓 Claude 按時間自動做事：「每 5 分鐘看一下構建」「工作日早上 9 點彙總 PR」；`/loop` 一句話設定 |
|  | [終端程式狀態（OSC 7501）](terminal-status.md) | 支援的終端能在標籤頁上顯示 Claude 正在忙、在等你批准、還是已經做完，不用切回來看 |
| 上下文與記憶 | [記憶：auto memory 與 SQLite FTS5 檢索](memory.md) | Claude 把跨會話有用的事（專案約定、你的偏好）記到檔案裡，下次自動帶上；可改成 SQLite 全文檢索，按需查詢 |
|  | [自動壓縮視窗](compaction.md) | 對話太長時把早期內容壓成摘要；`/autocompact` 決定多長時壓縮（按模型分別儲存），`/compact` 手動壓縮；可換成保留最近原文的 Codex 式壓縮（`compact.mode: "codex"`），或用 `compact.keepRecentRatio` 讓自動壓縮原樣多保留最近幾輪 |
|  | [Prompt context 與 Tool search](prompt-context.md) | 讓每次請求更省 token：提示詞分層利於快取，MCP 工具用到時才載入，大量同類工具只發一行彙總 |
|  | [快取命中與使用者體驗基準](cache-benchmark.md) | 本 fork 與官方 Claude Code、Codex、opencode、pi、oh-my-pi 跑同一批真實任務：快取命中率、token、API 等價花費、啟動速度與穩定性（附圖表） |
|  | [Agent 基準測試套件（bench/）](agent-bench.md) | 倉庫裡的基準工具：多個 CLI × Claude / ChatGPT 帳號跑同一批任務，逐請求記錄，算命中率、token、API 等價花費並畫散點圖；公開基準帶防汙染擾動 |
|  | [用量、成本與狀態](usage-and-cost.md) | `/usage` 看本次會話花了多少錢、用了多少 token；`/stats` 看長期使用習慣；恢復會話後成本繼續累計 |
| 介面與互動 | [會話命令](session-commands.md) | 本 fork 新增或補齊的斜槓命令：`/recap` 回顧、`/cd` 換目錄、`/focus` 精簡顯示、`/autocompact` 調壓縮時機、`/usage` 用量等 |
|  | [自主 Goal](goal.md) | 給 Claude 一個「做到才算完」的條件（如「所有測試通過」），每輪結束時自動檢查，沒達成就繼續幹 |
|  | [快捷鍵與 Vim 模式](keybindings-vim.md) | 自己改快捷鍵、回合中途排隊或立即插話、在輸入框裡用 Vim 的選擇和括號跳轉 |
|  | [自定義 UI / Branding 與 Status line](branding.md) | 改介面上顯示的產品名、換掉 Logo 的 ASCII 圖，用自己的腳本定製底部狀態列 |
|  | [/diff 檢視](diff-view.md) | 全屏右側 diff 面板：會話 / 未提交 / 分支三種基準、按輪次回看、把單個檔案 diff 附到下一條提示 |
|  | [Claude Web](web-ui.md) | `claude web` 在瀏覽器裡用 Claude Code：公式、Mermaid、程式碼和 diff 按網頁渲染，上傳並預覽 PDF / Office 文件、在圖片和程式碼上直接評論，回合中途插話或立刻打斷，右側面板看狀態、agent、終端抽屜、workflow 看板和後台任務，網頁裡切換 OAuth / API key；預設只監聽本機，區域網訪問需顯式開啟 |
|  | [Claude Web 介面導覽](web-ui-tour.md) | 按一次真實操作的順序一步一張截圖：改程式碼、確認命令、Status、後台 agent、`@` 發訊息、排隊插話、終端、workflow、檔案評論、專案與任務看板、深色外觀 |
|  | [Claude Web 專案](web-projects.md) | 在 `claude web` 裡建專案：協調者把活拆成任務派給多個 worker 並行做，右側看每個任務的過程、批准、發訊息、停止和審閱；專案和任務存在本機 SQLite，重啟後能接著聊 |
|  | [除錯日誌](debugging.md) | 遇到問題時開啟詳細日誌，看清楚 Claude Code 在後台做了什麼、請求發到了哪 |
|  | [遙測與反饋](telemetry.md) | 預設不向 Anthropic 傳送使用資料，`/feedback` 也隨之隱藏；需要時一個環境變數開啟 |
| 遠端執行 | [Direct Connect](direct-connect.md) | 在一台機器上 `claude server`，在另一處用 `claude cc://...` 連過去：工具在 server 上執行，介面和權限確認在你這邊 |
|  | [SSH Remote](ssh-remote.md) | `claude ssh 主机` 讓 Claude 在遠端 Linux 機器上讀寫檔案、跑命令，介面和權限確認留在本機；API 憑據不離開本機 |
| 插件與擴充 | [插件與 Marketplace](plugins-marketplace.md) | 從插件市場一鍵安裝命令、skill、agent、hook 和 MCP；團隊可以自建 marketplace，裝完 `/reload-plugins` 立即生效 |
|  | [MCP 配置與認證](mcp.md) | 接入外部工具伺服器（資料庫、瀏覽器、內部 API 等）；配置錯一條只跳過那一條，`/mcp` 檢視狀態、重連、登入；`claude web` 能顯示 MCP Apps 介面 |
|  | [Skills](skills.md) | 把一套做事步驟寫進 SKILL.md，用 `/名字` 呼叫，或讓 Claude 在合適時自動使用；`/skill-doctor` 找出從沒用過卻佔提示的 skill |
|  | [Channels](channels.md) | 讓 Telegram、Discord 或你自己寫的 MCP server 把訊息推進正在執行的會話，還能在手機上遠端批准工具呼叫 |
|  | [Mods / Function Hooks](mods.md) | 用一個 JS/TS 檔案改造 Claude 本身：加命令、攔截或改寫工具呼叫、在介面上加狀態條和側邊面板（基線官方 2.1.303） |
|  | [Mods 遠端客戶端（stream-json）](mods-sdk-client.md) | 給桌面 / IDE 等外部介面用的協議：通過 stream-json 讓 Mod 把介面畫到你自己的前端上，並把點選、輸入傳回來 |
|  | [Agent SDK 與 stream-json 控制協議](agent-sdk.md) | 在自己的程式裡呼叫 Claude：官方 Agent SDK（TS / Python）可以直接驅動本 fork 的 CLI，用 `env` / `settings` / `plugins` 開啟 fork 功能（附示例）；補齊了 SDK 0.3 會用到的控制請求 |
|  | [VS Code 插件](vscode-extension.md) | 讓官方 VS Code 插件改用本 fork 執行：面板裡的 `/status`、`/usage`、`/memory` 等對話方塊都能正常開啟 |
| 開發與釋出 | [構建、釋出與終端驗收工具](build-and-release.md) | 給貢獻者：怎麼從原始碼構建出可執行的 binary、怎麼和官方版本對照、釋出流程做了什麼 |

</details>

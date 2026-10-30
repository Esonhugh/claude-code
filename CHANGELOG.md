# 变更日志

本文档记录基于 Claude Code `2.1.88` 恢复源码之后的本地变更。

记录规则：

- 版本汇总条目（含未发布版本）的标题固定为 `## YYYY-MM-DD - vX.Y.Z - 标题`，按版本号从新到旧排列。
- 尚未归入版本的未发布条目标题固定为 `## YYYY-MM-DD - 标题`，不得在标题中包含版本号。
- 版本汇总条目依次包含 `版本状态`、`关联提交`、`变更内容`、`测试覆盖` 四个三级章节，每个章节至少包含一个顶层 `- ` 条目。
- `变更内容` 可以使用 `####` 分组，但每条用户可见 release note 必须单独占一行并以顶层 `- ` 开头。
- 版本汇总条目可以覆盖上一版本 tag 之后的全部提交，未发布版本必须明确标注状态；已归入同一未发布版本的增量统一补入该条目，具体实验细节存入专项文档。
- `## 2.1.88 base` 是唯一基线条目，固定放在文件末尾，不作为 release note。
- `bun run check:changelog` 是格式规范的可执行门禁；发布时还会校验 tag 版本与最新发布条目一致。

## 2026-10-30 - v2.1.296 - Agent 生命周期与 Teams 修复、内嵌 bfs/ugrep 搜索、coordinator 模式、/hooks /theme /config 对齐官方 2.1.311、权限模式转换修复

### 版本状态

- 发布候选：`dev` 合并到 `master` 后打 tag `v2.1.296`。本条目汇总 `v2.1.295` tag（master `e3fca04`）之后至 PR #395 的全部变更；`Makefile VERSION` 与 README 发布版本同步为 `2.1.296`，`package.json` 保持 `0.0.0-dev`。版本号与官方版本号无对应关系（本轮对照基线为官方 2.1.311）。

### 关联提交

- PR 合并提交（`git log --first-parent e3fca04..dev`）：#263、#272、#280 Teams 通知；#264、#269 agent 视图 pill（加入后又按用户要求撤回）；#268、#274、#276、#283、#284、#288、#303、#306 agent 生命周期；#290、#296、#302 coordinator 模式；#278、#289 SQLite 记忆检索；#293 Bash 折叠；#304、#316 权限与 Bedrock；#309、#311 REPL 对话框；#313 任务通知格式；#315、#319、#321 agent summary；#317、#331 Agent SDK；#323、#325、#329、#334、#346、#349 `/hooks`、`/theme`、`/agents`、`/memory`、`/config`；#327 内嵌搜索工具；#332 流式工具执行；#339 新 hook 事件；#342、#344、#347、#350 多轮对照修复；#354 权限模式转换与 Stop hook；#357 session memory；#359 权限提示与 footer 对齐官方；#363 模型默认值、会话标题与 `/ide`；#368 斜杠命令、`!` 命令回复与输出上限；#371、#374、#379 `--continue`/`--resume` 保留 prompt cache 与历史；#376 `/feedback`、`/output-style`、`/effort`、`/model` 与 SDK 字段；#383 `/hooks`、`/clear`、`/fast`、`/ide` 与对话框文案；#386 `/btw`、`/skills`、`/usage`、`/model`、`/status` 等命令对齐；#389 plan 模式权限、工具列表、会话标题与 agent 视图入口；#392 `/powerup`、agent 视图默认、编辑器上下文、插件市场筛选与内嵌 seccomp；#393 `/powerup` lint 修复；#395 rewind 链接安全、MCP transport、footer 与快捷键默认值。
- 对应 issue：#16、#71、#72、#73、#74、#75、#76、#88、#141、#158、#261、#262、#265、#266、#267、#270、#271、#273、#275、#277、#279、#281、#282、#285、#286、#287、#291、#292、#294、#295、#297、#298、#299、#300、#301、#305、#307、#308、#310、#314、#318、#320、#326、#328、#330、#333、#335、#336、#337、#338、#340、#341、#343、#345、#348、#351、#352、#353、#355、#356、#361、#362、#365、#366、#370、#373、#375、#378、#382、#384、#388、#391、#394。

### 变更内容

#### 需要用户处理的行为变化

- `memory.extraction` 默认改为 `off`，退出时不再等待“Saving memories…”；需要时设为 `sessionEnd` 或 `everyTurns`（#305）。
- session memory（为当前会话维护 `session-memory/summary.md`）默认关闭，与官方一致，开启 auto memory 也不会运行；13 轮真实对话中省去 23 至 29 次额外的 `Edit` 调用（#356）。auto memory（`autoMemoryEnabled`，默认开）现在只负责加载与检索长期记忆，后台补记由 `memory.extraction` 单独控制，默认 `off`。
- Linux 与 macOS binary 内嵌 bfs 4.1.1 与 ugrep 7.8.4，Glob/Grep 工具改由 Bash 中的 `find`/`grep` 完成，与官方一致；`--tools` 或 `--allowedTools` 点名 Glob 或 Grep 时保留这两个工具；Windows 不变（#326、#141）。
- `/agents` 交互向导移除，输入 `/agents` 显示官方的提示，改为手写 `.claude/agents/*.md`（#328）。
- coordinator 模式进入默认构建，只在 `CLAUDE_CODE_COORDINATOR_MODE` 加上 `-p`/SDK 或 `CLAUDE_CODE_REMOTE` 时开启，本地交互会话不会进入（#285）。
- 主循环始终使用流式工具执行（#330）。
- transcript 保存 attachment，与官方一致；`--continue`/`--resume` 后不再重复公布列表，system 与消息的 prompt cache 不再失效（#370）。git status 从 system prompt 移到 `session_context` attachment，每个会话只公布一次（压缩后再公布），改过文件的会话恢复后不再整段重写 cache（#373）。rewind 选 Summarize from here（partial compact）后恢复会话不再丢失保留段的历史（#378）。
- `/output-style` 恢复为可用命令：列出 default、Proactive、Concise、Explanatory 与 Learning，`/output-style <name>` 写入本地设置；Proactive 与 Concise 使用官方提示词与每轮提醒（#366）。
- 移除 `TeamCreate` 与 `TeamDelete` 工具，新增 `ReportFindings` 工具，与官方 2.1.311 一致；Bash 提示的 `ctrl+e` 解释功能移除（#388）。
- 快捷键默认值对齐官方：Chat 中 `ctrl+l` 为 `chat:clearInput`、`cmd+k` 为 `chat:clearScreen`（均重绘并保留输入）；确认对话框不再响应 `y`/`n`；新增 Task `ctrl+x ctrl+b` 与 DiffDialog `j`/`k`（#394）。
- Teams 不再处理收件箱中的 `mode_set_request` 与 `team_permission_update`，与官方一致（#74）。
- 子代理嵌套深度保持 5 层（官方为 3 层，按用户决定不改）。
- 模型默认值对齐官方：first party 下 `haiku` 别名指向 `claude-haiku-5-5`（第三方提供商仍为 4.5），Haiku 5.5 使用 adaptive thinking、effort 与 1M 上下文和对应定价；Sonnet 5.5 默认 effort 为 medium；自定义 `ANTHROPIC_BASE_URL` 且无 Console key 时，辅助请求使用主循环模型（#361）。
- 移除 `/vim` 与 `/pr-comments`，与官方一致（vim 模式仍在 `/config` 中切换）；`!` 命令执行后 Claude 默认会回复，可设 `respondToBashCommands: false` 关闭；Opus 5.5 与 Sonnet 5.5 默认最大输出 token 改为 128k，其余模型按官方目录取值（#366）。

#### Agent 与 Teams

- leader 重新收到 teammate 的 idle 通知；idle 通知带上回复结果（最多 4000 字符），每批最多 16000 字符；被 TaskStop 的 agent 报告 killed 而不是 failed（#262、#270、#271、#279）。
- 退出时同步结束后台 agent 的 shell 进程组，终端关闭时也会执行清理与 SessionEnd hook；恢复的 agent 保留最后一轮历史并使用自己的嵌套深度；TaskStop 可按名字或 `name@team` 停止 teammate（#265、#266、#267）。
- 后台子代理自己的后台 Bash/Monitor 在其回合结束后继续运行，等待期间发送“is waiting on its own background work”提示（#273、#275）。
- 通知行显示用时，回合行显示 `done <时间>` 与 `Waiting for N background agents`；Bash/PowerShell 只拒绝 25 秒及以上的开头 `sleep`；agent 通知在回合中途送达，SendMessage 恢复时返回 `Resuming agent <名字>`（#282、#287）。
- 达到回合上限的 worker 报告“stopped at its N-turn limit”并带部分结果，worker 回合上限改为 500（#281）。
- 有名字的 Agent 加入隐式的 `session-<id>` team；`/exit` 有后台工作时弹出确认；闲置 teammate 30 秒后从面板隐藏；SendMessage 接受 `name@team`；`--continue` 后可按 id 恢复 teammate；被结束的 agent 的工具调用补上结果（#294、#295、#298、#299、#300、#301、#305）。
- coordinator 保留 Skill（只读加载）、ListAgents 与 Workflow，`CLAUDE_CODE_BRIEF` 与 `CLAUDE_CODE_COORDINATOR_EXTRA_TOOLS` 生效（#291、#297）。
- 新设置 `agentSummary`（`full`/`short`/`off`，`/config` 中为 “Background agent summaries”）；summary 请求改为 `maxTurns: 1` 且不写 cache；agent 面板行显示 summary（#314、#318、#320）。
- 任务通知使用官方格式（system-reminder 与 SYSTEM NOTIFICATION 标题，带 `subagent_tokens`）；teammate 发给 leader 的消息使用 peer 包装；workflow agent 以 `workflow-subagent` 运行并保留 ListAgents 与 Cron 工具；teammate 的其他 agent 提醒只注入一次（#336、#337、#341）。

#### 权限

- plan 模式（auto 可用时）下 cwd 内的写文件不再被直接放行；Bash/PowerShell 提示的 “Yes, and always allow access to …” 只添加规则与目录，不再把会话切到 acceptEdits（#351、#352）。
- `sh -c` 中命中 deny 规则时询问；`env`/`command` 等包装的读取命令按读取处理；危险删除的包装命令增加 `exec`、`setsid`、`ionice`、`busybox`、`doas`、`pkexec`；相对路径 deny 规则同时匹配符号链接；plan 审批经过模式转换检查；Terminal 中用控制键编辑过的行需要询问（#71、#72、#73、#74、#75、#76）。
- 权限提示文案对齐官方：Write 第 2 项写明将要应用的更新（如 “Yes, and switch to accept edits … for this session (shift+tab)”），ExitPlanMode 第 1 项为 “Yes, and switch to default (ask each time) for this session”，bypass 警告框不显示编号；Bash 提示在 default/acceptEdits 模式且 auto 可用时增加 “Yes, and switch to auto mode” 选项与 Tip，命令显示在虚线之间（#355）。
- plan 模式即使在 auto 可用时也询问用户，不再交给分类器；以 bypass 启动的会话进入 plan 模式时提示其不会询问；Bash 提示的标签显示完整路径（#388）。
- rewind 不再通过符号链接、硬链接或非普通文件写入或删除被跟踪路径，恢复时以 `O_NOFOLLOW` 打开目标，被拒绝的路径记在 `skippedLinks` 并由 `rewind_files` 返回（#394）。
- Bedrock/Vertex 凭证错误最多刷新 2 次，无凭证的 `claude -p` 约 4 秒失败（原约 3 分钟）（#16）。

#### Hooks

- 新增 `PostToolBatch` 与 `UserPromptExpansion` 事件（#338）。
- `effort` 只出现在带工具上下文的 hook 事件中，UserPromptSubmit 输入带 `session_title`；`--continue` 时 SessionStart 输入带 `seconds_since_last_response`、`context_tokens`、`prompt_cache_likely_expired` 与 `estimated_cache_write_usd`（#366）。
- hook 输入补齐 `prompt_id`、PostToolUse `duration_ms`、TeammateIdle `agent_id`/`agent_type`、SendMessage `recipient_kind`；Stop 与 SubagentStop 输入带 `background_tasks` 与 `session_crons`（#335、#341、#353）。

#### 记忆

- SQLite 记忆模式下 SearchMemory 成为默认检索方式；中文提示也能召回，首个请求前即带上召回结果（#277、#286）。

#### 界面

- `/hooks` 改为按事件分组的平铺列表；`/theme` 支持 Auto（跟随终端）与自定义主题（`~/.claude/themes/<slug>.json`），主题目录变化自动重载；`/memory` 与 `/config` 的布局、按键与行项目对齐官方 2.1.311（#328、#333、#345、#348）。
- `/tasks` 在 “Completed” 下列出已完成的后台 agent，面板立即隐藏它们；Workflow 调用显示描述与 “Completed in …” 结果行；`/context` 列表折叠到 `/context all`（#343）。
- 非全屏模式下连续 2 条及以上的 Bash 命令折叠为一组（#292）。
- 权限提示上按 Esc 会中止当前回合；修复多个对话框的缩进、换行与空状态；`/sandbox` 仅依赖视图显示按键提示；Write 结果写作 “Wrote 1 line”（#307、#308、#310、#355）。
- default 模式的 footer 显示 “⏸ manual mode on”；回合等待行不再把 workflow 自己的 agent 计为后台 agent；auth 冲突提示使用官方文案（#355）。
- 不带参数的 `/effort` 打开 effort 滑块；对话中途 `/model` 切换模型时弹出 “Switch model?” 确认，提示当前模型的 cache 将失效；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 下 `/feedback` 仍列出并说明被关闭的原因；Markdown 正文中形似 HTML 的标签按原样显示（#366、#375）。
- 会话标题使用官方的命名提示，交互会话生成的标题写入 transcript，`/resume` 与会话列表可见；`/ide` 等待扩展安装完成并报告失败（#362、#365）。
- 斜杠命令不再预选模糊匹配项，没有选中建议时 Enter 提交输入的命令，未知命令使用官方警告；命令 stderr 以纯文本显示、不带 `Error:` 前缀；`/copy` 写入每用户的 Claude 临时目录；`/terminal-setup` 与 `/mcp` 空状态文案对齐官方（#366）。
- `/hooks` 的命令列不再换行；`/clear` 不再显示 `⎿ (no content)`；`/fast` 去掉可用性限制，网关下也打开对话框；`/ide` 安装失败使用官方格式；权限、沙箱、resume、后台任务、export、workflows 与 shell 模式的对话框标题与 footer 对齐官方（#382）。
- `/btw` 支持 `c` 复制与 `f` 把旁答 fork 为后台 agent；`/skills` 菜单、`/model` 仅本会话选择与选择器文案、`/status` 的认证/策略行与安装诊断、`/clear <name>` 为旧会话命名、`/config` 的 thinking 锁定说明与 Worktree base ref 行，以及 effort、context、help、resume、rewind、插件界面的文案与布局对齐官方；`/usage` 与 `/cost` 报告主线程的 prompt cache 统计（#384）。
- 连按两次 `←` 打开 agent 视图，`/config` 增加对应行；会话标题只根据用户输入生成；压缩后恢复的会话不再重复公布技能列表（#388）。
- 新增 `/powerup`（10 节官方功能课程，进度写入 `powerupsUnlocked`）；`/config` 新增 `defaultToAgentsView`（BG_SESSIONS 构建中裸 `claude` 默认打开 agent 视图）与 `externalEditorContext`（`$EDITOR` 缓冲区开头以注释附上 Claude 上一条回复，保存时去掉）；`/plugin` Discover 在有 2 个及以上 marketplace 时显示标签行，`ctrl+s` 切换（#391）。
- Linux binary 内嵌 `apply-seccomp`，`/sandbox` 依赖项显示 `seccomp filter: installed`，与官方一致（#391）。
- BG_SESSIONS 构建中输入框为空且空闲时 footer 显示 `← for agents`，遵循 `leftArrowOpensAgents`（#394）。

#### Agent SDK

- 子代理消息带官方字段与结果摘要，支持 `set_mcp_permission_mode_override`、`tool_result_meta`、`askForTools` 校验，`task_notification` 顺序与官方一致（#88、#158）。
- `mcp_status` 报告每个服务器的 `transport`（#394）。
- `system/init`、`initialize` 与 `get_context_usage` 补齐官方 2.1.311 字段（如 `analytics_disabled`、`claude_code_version`、`current_permission_mode`、`mcp_servers[].source`、分类 `id`）；标题等辅助请求不再发送 `thinking` 参数（#366）。

#### 已知缺口

- `src/services/compact/autoCompact.contextWindow.test.ts` 与 `idleCompaction.test.ts` 的部分用例依赖本机环境变量与凭证，在云容器中失败，改动前后一致，不影响运行时行为。
- 后台 Workflow 的结果行在完成后显示 “Completed …”，官方保持 “/workflows to view dynamic workflow runs”；两者渲染逻辑相同，差异来自 task 保留时长。#79（工作区 MCP 审批存储、插件仓库分级）与 #366 的 `display: "updates"`/`clear_thinking`、`/stats` 界面移植留到后续版本。

### 测试覆盖

- 每个 PR 在重建的 binary 上以 tmux 与脚本化假 Messages API 对照官方 2.1.311；多轮对照（项目共享目录 `research/multiturn-2026-10-29/` 与 `research/multiturn-2026-10-30-evidence/`）：假 API 37 步 dev 37/37 ×5、官方 35/35 ×5；权限模式转换 36 步修复后 36/36，与官方一致；真实模型 13 轮工具命中 dev 39/39、官方 36/39；Agent SDK probe 两侧均 32/33。
- PR CI：Windows e2e、macOS Seatbelt e2e、Linux 沙箱测试、官方对照与 Linux x64/arm64 搜索工具构建（#331）。
- 发版前在 `dev` 上运行 `make release-check` 与 `make build`，并以重建的 binary 跑过 SIGINT SessionEnd、`CI=true` 无凭证 `-p` 与 team shutdown 三项回归。

## 2026-10-27 - v2.1.295 - MCP v2 SDK、Windows 原生沙箱、沙箱网络与工具提示词对齐官方 2.1.311、/code-review 技能、agent 面板、DO_NOT_TRACK

### 版本状态

- 发布候选：`dev` 合并到 `master` 后打 tag `v2.1.295`。本条目汇总 `v2.1.294` tag 之后至 PR #258 的全部变更（第一次 dev→master PR #251 合并后未打 tag，PR #252 至 #258 一并归入本版本）；`Makefile VERSION` 与 README 发布版本同步为 `2.1.295`，`package.json` 保持 `0.0.0-dev`。版本号与官方版本号无对应关系（本轮对照基线为官方 2.1.303 至 2.1.311）。
- PR #189 至 #208 的变更记在下方 2026-10-26 未归版本条目中，保持原样，也属于本版本。

### 关联提交

- PR 合并提交（`git log --first-parent 576998d..dev`）：#209 文档同步；#210 MCP v2 SDK；#212、#214、#216 Windows 沙箱与 Windows e2e；#218 沙箱网络；#220、#222、#224、#228、#234、#236、#240 工具与提示词对齐；#226、#230 workflow 与 `/code-review`；#232、#243、#248、#249 界面；#238 子代理工具；#241 Linux 沙箱测试 CI；#252 master 合回 dev；#253 macOS 沙箱 e2e CI；#254 遥测开关；#255 `claude ssh`；#256、#258 VS Code 插件与 Agent SDK；#257 MCP 与子代理。
- 对应 issue：#201、#211、#213、#215、#217、#219、#221、#223、#225、#227、#229、#231、#233、#235、#237、#239、#242、#244、#245、#246、#247；#80、#81、#82、#88、#152、#158。

### 变更内容

#### 需要用户处理的行为变化

- MCP 改用 v2 SDK（`@modelcontextprotocol/client`、`core`、`server` 2.4.0），连接 stdio、http 与 claude.ai 代理服务器时先用 `server/discover` 协商协议 2026-07-28，失败再回退 `initialize`；`MCP_PROTOCOL_NEGOTIATION=legacy` 关闭协商（#210）。
- 自定义 `ANTHROPIC_BASE_URL` 也使用原生 tool search（beta header、`defer_loading` 与 `DeferredToolPlaceholder`），不再退回文本形式；网关拒绝这些字段时自动去掉延迟工具重试一次，之后本进程内不再启用 tool search；也可设 `ENABLE_TOOL_SEARCH=false`（#227、#235）。
- 自定义 base URL 不再发送 `prompt-caching-scope` 与 `scope: global`（#233）。
- 旧的 `/review` 命令移除，改为 `/code-review` 技能的别名；`/ultrareview` 保留（#229）。
- 内置 workflow 只保留官方 2.1.310 的 `deep-research` 脚本，fork 自有的 code-review workflow 移除（#225）。
- `TaskOutput` 工具移除，后台任务提示改为 `SendMessage`；`SetGoal`/`ClearGoal` 合并为延迟加载的 `Goal` 工具；TodoWrite/Task 工具只在旧模型、后台任务、`--tools` 指定或 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 时提供；headless 会话不提供 AskUserQuestion（#219、#221）。
- in-process teammate 改为 agent 面板中的行，`@` pill 行、`ctrl+t` teammate 视图、`shift+↑/↓` 选择与 `ctrl+shift+o` 预览移除（#244）。

#### 沙箱

- Windows 原生沙箱：Windows binary 内置 `srt-win.exe`，Bash 与 PowerShell 在沙箱内运行；隐藏命令 `claude sandbox install|status` 安装与检查，沙箱账号与官方共用 `ClaudeCodeSandbox`；Windows 上 Terminal 不开沙箱会话（#211、#217）。
- 托管或 `--settings` 强制沙箱、`allowManagedDomainsOnly` 与 strict allowlist 下，网络放行只取可信来源；网络询问按权限模式回答：bypass 放行、dontAsk 拒绝、auto 拒绝并提示用 `allowed_domains`（#217）。
- Bash、PowerShell 与 Monitor 新增 `allowed_domains` 参数：auto 模式下经分类器审核后只对该条命令放行所列域名（#217）。

#### 对齐官方 2.1.303 至 2.1.311 的工具与提示词

- 订阅用户默认对主对话、SDK、auto mode 与记忆检索请求使用 1 小时 prompt cache（#221）。
- tool search 从第一个请求起带 `DeferredToolPlaceholder`，第一次 ToolSearch 不再重写整段对话 cache；延迟工具公告改用官方文案（#223、#239）。
- Read 结果不再附加恶意软件提醒，每次 Read 约省 80 tokens；精简提示词模型使用官方精简版 Grep 描述（#219、#221）。
- Monitor 默认提供；子代理可使用 Monitor、SendMessage 与 TaskStop（只能停自己的任务），可向 `main` 发消息，新建 agent 会被告知可联系的其他命名 agent（#237）。
- Write/Edit 在写入无需询问时可跳过“先读后写”检查（旧模型保持严格检查）（#239）。
- 新增官方 `/code-review` 技能（effort 级别、`--fix`、`--comment`、`--max-findings`、沿用上次级别、`ultra`）；`/simplify` 对齐官方；prompt 命令支持官方的按次 effort 与上下文 hooks（#229）。

#### 隐私与遥测

- 设置 `DO_NOT_TRACK=1` 等同于关闭遥测：即使已 opt-in，也不发送 1P 事件、GrowthBook、BigQuery 指标与问卷；`CLAUDE_FORCE_DISPLAY_SURVEY` 不再绕过 opt-in 与停用设置；未启用反馈问卷时拒绝上传 transcript（#81）。

#### VS Code 插件、Agent SDK 与 MCP

- 回应 `get_sandbox_dialog`，新增 `claude edit-sandbox-settings --json`，VS Code 插件的 `/sandbox` 对话框可读写沙箱设置，检查与官方 2.1.311 一致（#158）。
- `set_max_thinking_tokens` 支持 `thinking_display`（只改显示时保留预算，`null` 恢复启动设置）；`claude -p` 文本输出（或无 `--verbose` 的 json）默认发送 `thinking.display: "omitted"`；`thinking.display` 只发给支持它的模型与平台；`system/init` 带 `original_cwd` 与 `memory_paths`（#152、#88）。
- agent 的 `tools:` 支持 `mcp__srv` / `mcp__srv__*` 授予整个 MCP 服务器，`disallowedTools` 也作用于 agent 的内联 MCP 服务器；项目、本地与插件 agent 的内联服务器 `headersHelper` 不带凭证环境变量，项目 agent 需等待目录信任；未完成的运行会清掉 hand-back 状态（#82）。

#### `claude ssh`

- Esc 中断后不再显示内部的 `[ede_diagnostic]` 文字，改为显示 `[Request interrupted by user]`；`claude ssh --local` 退出时的恢复提示保留 `--local`（#80）。

#### 界面

- notice 消息带状态点并用非活动颜色，完成的后台 agent 通知写作 `finished`（#231）。
- agent 面板最多显示 5 行，随选择滚动并标示 `↑/↓ N more`；超过 3 个闲置 teammate 折叠为一行（#242、#244）。
- 输入框下的 `/` 与 `@` 菜单高度为终端一半（至少 6 行），选中行带 `❯`；长通知改为截断，不再挤压模式行；安装检查结果写入 debug 日志（#245、#246）。
- 尚无已跟踪文件的 git 仓库中，`@` 建议也列出未跟踪文件（#247）。

#### 已知缺口

- `src/services/compact/idleCompaction.test.ts` 的 1 小时 cache 用例依赖本机凭证，只在设置了 `ANTHROPIC_API_KEY` 的环境中通过；`src/hooks/fileSuggestions.untracked.test.ts` 在 `~/.claude` 下有技能文件时可能等不到未跟踪文件合并而超时。两者都是测试环境问题，不影响运行时行为。
- Bedrock 无 AWS 凭证时 `claude -p` 仍重试约 3 分钟才失败（#16）。

### 测试覆盖

- 每个 PR 在其 worktree 上重建 binary，以 `-p` 与 tmux 配合脚本化假 Messages API 跑案例，并与官方 2.1.303/2.1.310/2.1.311 binary 对照；验收记录在 `research/acceptance/`（项目共享目录）。
- Windows：`.github/workflows/windows-e2e.yml` 在每个 PR 上跑沙箱、fork 功能、跨会话通信与 Direct Connect e2e，并与官方 2.1.303 对照（#213、#215）。
- Linux 沙箱：`.github/workflows/linux-sandbox-tests.yml` 安装 bubblewrap、socat 与 ripgrep 后跑 `src/utils/permissions/permissions.networkLists.test.ts` 与 `src/utils/sandbox/sandbox-adapter.test.ts`（#241）。
- macOS 沙箱：`.github/workflows/macos-e2e.yml` 在每个 PR 上以 Seatbelt 沙箱跑 fork 与官方 binary 的 e2e（#253）。
- 发版前在 `dev` 上：`make release-check`、`make build` 通过；877 个测试文件逐个单独运行，失败的只有已知的环境相关用例与偶发的 `ModsPane.focusRing295` 绘制计时用例（单独重跑通过）；以重建的 binary 跑过 SIGINT SessionEnd、`CI=true` 无凭证 `-p` 与 team shutdown 三项回归。

## 2026-10-26 - Terminal 进沙箱、resume 提示与 npm 插件安全修复、补齐官方界面设置

### 变更内容

#### 安全

- 退出时的恢复提示改为 `claude --resume <session id>`，不再打印会话标题；标题含 `$()` 时，粘贴旧提示会执行其中的命令（#206）。
- 来源为 npm 包的插件安装时带 `--ignore-scripts`，不再运行包的生命周期脚本（#206）。
- 内置 Mods 归档里的 `telemetry` Mod 不再注册，设了 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1` 也不加载（#206）。
- 开启 `sandbox.enabled` 时，Terminal 的 `new-session` 在 Bash 沙箱里启动，遵守 `excludedCommands` 与 `dangerouslyDisableSandbox`；Linux 下沙箱内命令仍有自己的 PTY，`Ctrl+C` 和 `resize-pane` 可用，终端关闭时清理沙箱；Terminal 仍不享受沙箱 auto-allow（#202、#205）。

#### 对齐官方 2.1.303 的设置与界面

- 空闲压缩：主对话使用 1 小时 cache、闲置 54 分钟且对话不少于 200k tokens 时先压缩；`idleCompaction: false` 或 `/config` 关闭，`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` 调阈值；新增 `ENABLE_PROMPT_CACHING_1H=1` 在不依赖 GrowthBook 的情况下打开 1 小时 cache（#207）。
- `timeFormat` / `timeZone`：预设或 strftime 格式，用于 transcript 消息时间戳；`/config` 新增 Time format（#207）。
- `subagentStatusLine`：agent 面板有子代理时每 5 秒运行命令，按输出改写各行文字；需要工作区信任；空 `content` 保留该行（官方会隐藏）（#207）。
- `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`：workflow 中的 agent 统一使用该模型，覆盖工具参数、frontmatter 与 `CLAUDE_CODE_SUBAGENT_MODEL`（#207）。
- `spellcheck`：用 aspell / hunspell / ispell 检查输入框英文单词并加下划线，只读用户、命令行与托管设置（#207）。
- 不在白名单内但回应 Kitty 键盘协议查询的终端也启用扩展按键，`Ctrl+Enter` 可用；白名单加入 Warp（#207）。
- 新增内置技能 `/dataviz`，内容取自官方 2.1.303（#207）。
- Gateway 模型自动发现默认开启，`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=0` 关闭（#207）。

#### 修复与文档

- `claudeCode.claudeProcessWrapper` 直接指向本 binary 时，插件会把自带的 `native-binary/claude` 路径作为第一个参数传入；启动时略过这个参数，插件的插件面板与 `auth status --json` 不再报 `unknown option '--json'`（#189）。`get_usage` 抓取用量失败时写入 warn 级 debug 日志。
- 构建时对 `src/` 的 `.ts`/`.tsx` 运行 React Compiler（与官方构建一致，保留手写 `useMemo`/`useCallback` 依赖），状态变化不再让整棵 Ink 树重新渲染；外部构建的 `useMoreRight` stub 回传稳定的回调，`PromptInput` 的 memo 不再每次失效。tmux 实测串流 CPU 由 952 降至约 590 ticks、打字 300 键由 537 降至约 420–510（官方 2.1.303 为约 420 与 366），VS Code 终端中的卡顿明显减轻（#191）。
- OpenAI provider 新增 `/daybreak blue|red|off` 切换网络安全访问档位（#192）。
- `compact.codex.keepPostCompactAttachments` 生效：Codex 式压缩写摘要时按设置保留重新附上的附件（#195）。
- SQLite 记忆检索并发刷新时不再重复写入 transcript 片段（#197、#198）。
- Terminal 的 `new-session` 参数说明写明 `command` 是单个可执行文件、`args` 是它的参数；`command` 含空格时错误提示改用 `args`（#203、#204）。
- 文档：Codex 式压缩、`/vim`、跨会话 held 消息、VS Code ChatGPT 账号（#194）；用官方 Agent SDK 打开 fork 功能的示例（#199、#200）；README 宣传视频（#196）。

### 测试覆盖

- React Compiler：`src/moreright/useMoreRight.test.ts`（两次调用回传同一组回调，修复前失败）；把 `src/` 以相同配置编译后跑 154 个 UI 测试文件，与未编译结果对照，差异仅来自测试直接 eval 源码文本或把组件当普通函数调用。
- 插件 wrapper 参数：`src/entrypoints/processWrapperArgs.test.ts` 覆盖 macOS 与 Windows 自带 binary 路径会被略过，一般参数与 prompt 中的相同字样不受影响。
- `src/tools/TerminalTool/TerminalTool.test.ts`（沙箱开启时 `new-session` 经 `wrapWithSandbox` 启动、关闭时清理、`dangerouslyDisableSandbox` 在沙箱外；`command`/`args` 说明）、`src/utils/shell/resolveDefaultShell.test.ts`。
- `src/memdir/memoryIndex.test.ts`（并发刷新只写入一次）、`src/services/compact/codexCompact.test.ts`（保留与丢弃附件计数）。
- `src/utils/plugins/pluginLoader.npmInstall.test.ts`（假 npm 断言 `--ignore-scripts`）、`src/plugins/builtinMods.test.ts`、`src/services/compact/idleCompaction.test.ts`、`src/utils/timeFormat.test.ts`、`src/utils/spellcheck.test.ts`、`src/utils/model/agent.test.ts`、`src/components/Settings/configRows.test.ts`、`src/skills/bundled/dataviz.test.ts`、`src/ink/terminal.extendedKeys.test.ts`；tmux 前后对照见 PR #208。

## 2026-10-25 - v2.1.294 - 权限、自动模式、Hooks 与沙箱对齐官方 2.1.303，背景会话、SQLite 记忆、跨会话通信与 Agent SDK / VS Code 兼容

### 版本状态

- 发布候选：`dev` 合并到 `master` 后打 tag `v2.1.294`。本条目汇总 `v2.1.292` tag 之后至 PR #185 的全部变更；`Makefile VERSION` 与 README 发布版本同步为 `2.1.294`，`package.json` 保持 `0.0.0-dev`。版本号 `2.1.294` 与官方版本号无对应关系（本轮对照基线为官方 2.1.303）。
- 范围一（2026-10-20 至 2026-10-23）：PR #83 并入的 PR #37、#39、#41、#43、#45、#48、#50、#52、#54、#56、#58、#61、#63、#64、#66、#68（经集成分支 #70）、`dev` 直接合并的 7 个功能分支、2026-10-20 的 4 个直接提交，以及 PR #84、#86、#89、#90。归版前的 23 条原始条目与逐项测试见[v2.1.293 详细记录](docs/archive/implementation-records/changelogs/2026-10-23-v2.1.293-details.md)。
- 首次推送 tag 的 release workflow 仅 Windows 在 `verify-bundled-image-runtime` 失败（runner 的 TEMP 为 8.3 短路径 `RUNNER~1`，本版本起 Read 对短路径强制询问，`dontAsk` 下被拒），npm 未发布；验证脚本改为先展开临时目录的长路径（#180），之后将 tag 移到修复后的提交。
- `v2.1.293` 曾发布到 GitHub Release 与 npm，之后撤回；其全部内容并入本版本，并追加 VS Code 插件在 ChatGPT 登录下的账号与用量显示修复（#183）。npm 不允许重用已撤回的版本号，因此改发 `2.1.294`。
- 范围二（2026-10-23 至 2026-10-25）：PR #91 至 #177 中合并到 `dev` 的 PR，归纳在下方「2026-10-23 之后」各分组；下方 2026-10-23、2026-10-24 的 9 个未归版本条目保持原样，也属于本版本。

### 关联提交

- `ec9a0c1` PR #83 合并提交，内含 `a728a27` #70（`9dce6a8` #37、`7441714` #39、`93ad15c` #43、`5e0e2e7` #54、`76b6f26` #58）、`720a578` #61、`0001a8b` #63、`9bbbdaa` #64、`4d7f128` #48、`227facf` #41、`d1a9da4` #45、`cc0e3b0` #50、`bc37b93` #52、`2d346f1` #56、`d5fe4d1` #66、`4854cef` #68，以及集成修复 `a9de890`、`d172dc1`。
- 功能分支合并：`224a402` hooks-parity、`1321688` monitor-tool、`5e18f3b` memory-local-enable、`1187910` autocompact-agent-fields、`da2e3ba` keybindings-growthbook-defaults、`510d1bc` mods-2.1.303-parity、`46766d7` permissions-automode-parity，集成修复 `30dce66`。
- 直接提交：`9e7173c`、`529c3e7`、`97c6d72`、`4fbf315`（stream watchdog、无人值守重试、默认模型与回退模型链）。
- 2026-10-23 至 2026-10-25 的 PR 合并提交（`git log --merges ed2347e..57091b9`）：#91 Direct Connect；#93、#94、#95、#96 启动与 SDK 0.3；#99、#100、#102、#107、#112、#115、#117、#120、#122、#124、#126、#166 Workflow；#105、#106、#129、#132 斜杠命令；#114、#119、#134 跨会话通信；#133、#136、#138、#150 背景会话；#143、#147 提示词与 SQLite 记忆；#156、#162、#164、#170、#172 Bash 沙箱；#153、#159、#165、#175、#177、#185 Agent SDK 与 VS Code 插件；#169 Codex 客户端版本；#171、#174 界面修复；#148、#149、#151、#154、#157、#160、#173、#176 文档与技能。
- 2026-10-23 后续：PR #84（Bash 允许规则覆盖工作目录内写入询问、官方路径询问文案，Closes #77）、`df7cc70` PR #90（Agent Teams 改回需要环境变量）、`d6819a6` PR #89（`autocompact_state` 按模型解析窗口）、`ed2347e` PR #86（README 与 dev 同步）。

### 变更内容

#### 需要用户处理的行为变化

- Agent Teams（TeamCreate、teammate、SendMessage 等）与官方 2.1.303 一致：外部用户只有设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 或传 `--agent-teams` 才启用，GrowthBook 停用开关照旧生效（2026-10-21 曾改为默认启用，2026-10-23 按用户决定改回）。
- 自动模式分类器规则（`autoMode.*`）不再读取项目 `.claude/settings.json` 与 `.claude/settings.local.json`，只认用户、`--settings` 与托管设置（对齐官方 2.1.207）；项目与本地设置中的 `permissions.defaultMode: "bypassPermissions"` 与 `"auto"` 一样被忽略。
- 项目与本地设置的 `env` 不再能设置 `CLAUDE_CONFIG_DIR`、`TMPDIR`/`TMP`/`TEMP`/`CLAUDE_CODE_TMPDIR`、`HOME`、`CLAUDE_CODE_DISABLE_ATTACHMENTS`，以及开启或改写遥测导出的变量（`CLAUDE_CODE_ENABLE_TELEMETRY`、`OTEL_EXPORTER_OTLP_*`、`OTEL_*_EXPORTER`、`OTEL_LOG_*` 等）；仍可把 exporter 设为 `none` 或关闭 `OTEL_LOG_*` 开关，被忽略的键记录一次警告。
- 被 git 跟踪的 `.claude/settings.local.json` 视为仓库内容：工作区未显式信任时其 `permissions.allow` 规则不生效（deny/ask 仍生效），项目设置也不能自行批准 `.mcp.json` 服务器（对齐官方 2.1.196）。
- MCP allow 规则只放行它点名的 server：`mcp__a` 不再放行名为 `a__b` 或 `a_` 的 server，server 名含 `__` 时写 `mcp__<server>__*`（对齐官方 2.1.299）；单段 `dir/**` allow 规则（如 `Edit(src/**)`）只匹配 `<cwd>/dir`（对齐官方 2.1.214）。
- plan 模式下 allow 规则、PreToolUse hook 与 Mods `tool.check` 的 allow 都不再让写入类工具直接执行，改为提示 `Cannot call <tool> while in plan mode.`（对齐官方 2.1.136、2.1.299）。
- hook matcher 中含连字号的名称改为精确匹配，逗号分隔的 matcher 现在会生效，匹配整个 MCP server 请写 `mcp__brave-search__.*`（对齐官方 2.1.191/2.1.195）；插件 hook 的 shell 形式命令引用 `${user_config.*}` 会报错拒绝执行，请改读 `$CLAUDE_PLUGIN_OPTION_<KEY>`。
- Stream idle watchdog 默认开启（Anthropic 与 OpenAI provider），响应流 5 分钟无事件即中止重试，`CLAUDE_ENABLE_STREAM_WATCHDOG=0` 关闭；`CLAUDE_CODE_MAX_RETRIES` 上限改为 15，仅在 `CLAUDE_CODE_RETRY_WATCHDOG` 下解除。
- 后台记忆提取、Session Memory 与终端失焦 5 分钟后的会话回顾默认开启；`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`autoMemoryEnabled: false`、`CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` 或 `awaySummaryEnabled: false` 关闭，`-p` 仍不提取。
- 启用 `Monitor` 工具后，Bash/PowerShell 拒绝以 `sleep N`（N ≥ 2）开头的前景命令；`/loop` 只给提示、不给间隔时改为动态自排程，不再默认每 10 分钟的 cron。
- `--dangerously-skip-permissions` 下写入 `.git/`、`.claude/`、shell 配置等受保护路径不再弹出确认（对齐官方），`rm -rf /` 这类灾难性删除仍要求确认。
- 项目 `.mcp.json` 与插件的 MCP `headersHelper` 不再继承凭证类环境变量（`ANTHROPIC_API_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、云厂商密钥）；项目 helper 在 `claude -p` 下须先信任目录才执行（对齐官方 2.1.237）。
- Mods 作者声明改用官方 2.1.303 完整声明体，声明中本构建未实现的调用会以点名该调用的错误拒绝；`strictPluginOnlyCustomization` 只锁定非插件来源的 hooks，插件 Mods 照常加载。
- `/feedback` 与反馈、记忆、压缩后问卷改为跟随 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY` opt-in，在 `DISABLE_TELEMETRY`、非必要流量开关或网关 base URL 下保持关闭（#69）；BigQuery 指标导出同样受这些开关停用（#47）。

#### Bash、文件、MCP 与 WebFetch 权限规则

- Bash deny/ask 规则匹配 `sudo`、`doas`、`env`、`nohup`、`exec` 等执行包装命令后面的命令与带展开值的环境变量前缀，bypass 下同样拒绝（对齐官方 2.1.113、2.1.214）；bypass 下 `sh -c` 脚本里删除 `/` 或主目录的 `rm` 要求明确确认（对齐官方 2.1.246）。
- `Bash(find:*)` 等 allow 规则不再放行 `find -exec`/`-execdir`/`-ok`/`-delete`；`tee` 目标按写入路径检查；`Read()` deny 覆盖 `tac`、`egrep`、`fgrep`、`< file` 与选项值里的路径；`sandbox.excludedCommands` 须复合命令每段都命中；超过 10,000 字符或带悬空 `&&`/`||`/`|` 的命令一律确认。
- 权限规则支持 `Tool(param:value)` 语法（deny/ask 按工具输入参数匹配，值支持 `*`，例如 `Agent(model:opus)`）与工具名位置的 `*` 通配（`"*"`、`"Web*"`），allow 仍只接受 MCP 通配（对齐官方 2.1.166、2.1.178）。
- MCP allow 规则支持工具名通配（`mcp__srv__get_*`），deny/ask 规则 `mcp__a__b` 能拦到名为 `a__b` 的 server，`mcp__*` 放行全部 MCP 工具；子代理 `disallowedTools` 支持 `mcp__srv`、`mcp__srv__*` 与 `mcp__*`（对齐官方 2.1.178）。
- 文件路径规则：符号链接目录上的 deny/ask 同时作用于真实路径，allow 须覆盖路径的每种写法才放行，重复 `/` 合并；Windows 盘符、`//c/...`、`~\` 与 `\` 开头的规则按官方解析。
- 受保护文件清单补齐官方 2.1.303 的 37 项（`.npmrc`、`.yarnrc*`、`bunfig.toml`、`.bazelrc`、`.pre-commit-config.yaml`、lefthook、gradle/maven wrapper、`.devcontainer.json`、`pyrightconfig.json`、`.envrc`、`.zshenv` 等）与 `.husky`、`.cargo`、`.devcontainer`、`.yarn`、`.mvn`、`.config/git/` 目录，acceptEdits 等模式写入前询问。
- `WebFetch(domain:...)` 的 deny/ask/allow 规则优先于内置预批准域名，并支持 `*.example.com`、`api-*.example.com`、`domain:*` 通配。
- 默认权限模式下，`Bash(touch:*)` 这类 Bash 允许规则（精确或前缀）可以放行工作目录内的写入命令（如 `touch tl-x`），不再被路径检查改成询问（`-p` 下不再拒绝，对齐官方 2.1.303）；只有「路径在工作目录内、没有其他原因」的询问可被覆盖，安全检查、Edit deny 规则、工作目录外路径、含 `cd` 的复合写入、`cp`/`mv` 带 flag 等仍询问或拒绝。Bash 路径询问改用官方文案：工作目录内为 `<cmd> in '<path>' needs approval. The path is inside the working directories for this session (...)…`，工作目录外为 `… The path is outside the working directories for this session (...). Allowing runs the command as written.`，输出重导向同步（#77）；PowerShell 未改。
- 启用 `allowManagedPermissionRulesOnly` 时，设置重新加载保留 `--disallowedTools` 与会话内 deny 规则（对齐官方 2.1.257）；仓库、用户、`--add-dir`、MCP 与第三方插件 skill/命令的 `allowed-tools` 不再预先批准工具。
- 读取 UNC 路径（`//host/share`、`\\host\share`）与含可疑 Windows 路径写法的读取强制人工确认，分类器、hook 与 allow 规则都不能放行。

#### 权限模式、自动模式与分类器

- 新增 `--safe-mode` 与 `CLAUDE_CODE_SAFE_MODE`（对齐官方 2.1.169）：停用 CLAUDE.md、自定义 skills/commands、插件（含 hooks、MCP、Mods）、非托管 hooks、全部 MCP 服务器、自定义 agents、output styles、workflows、keybindings、LSP 与自动记忆。
- 权限模式 `default` 对外更名为 Manual：`--permission-mode manual`、`"defaultMode": "manual"` 与 SDK 均接受并等同 `default`（对齐官方 2.1.200）；新增 `--permission-prompts host|none`，`--print` 下 `none` 时需要提示的操作本地直接拒绝（对齐官方 2.1.259）。
- 自动模式设置新增 `autoMode.hard_deny` 与 `autoMode.classifyAllShell`（对齐官方 2.1.288）；对话超出分类器上下文时拒绝本次调用并在下一次请求前强制压缩；新增 `claude auto-mode reset [-y]`；`CLAUDE_CODE_AUTO_MODE_MODEL` 对所有用户生效，设为分类器不能用的模型时改用默认模型并记录一次。
- 进入 auto 时剥除来自 settings、`--settings`、托管策略与 skill/命令 allowed-tools 的危险 allow 规则，auto 期间修改 settings 后重新剥除，离开 auto 时还原且不产生重复或丢失（对齐官方）；`Monitor` 与 `Terminal` 的 allow 规则在 auto 下同样搁置。
- PermissionRequest hook、SDK `updatedPermissions` 与权限对话框建议中的 `setMode` 改走与 Shift+Tab、SDK `set_permission_mode` 相同的切换闸门（bypass 策略与可用性、auto 闸门、plan 可用性）；分类器检查进行中切换模式时丢弃结果并按新模式重判；SDK `set_permission_mode` 之后重判等待中的 `can_use_tool` 请求。
- 自动模式分类器以 Sonnet 5 或 Opus 4.8 运行时改用官方 2.1.303 的 `<severity>` 两阶段输出格式与阈值，其他模型仍用 `<block>`；请求失败每个模型只重试 4 次，不可用时约 15 秒内拒绝；拒绝消息前缀与权限规则提示对齐官方；内置 soft_deny 规则同步官方 2.1.303。
- `disableAutoMode` 不再写入 circuit breaker，移除后无需重启；会话中途新增该设置立即退出自动模式；SDK `set_model` 切到不支持自动模式的模型时退出自动模式；OTel `tool_decision` 事件新增 `permission_mode` 与 `classifier_verdict`。
- 权限模式变化时写入 transcript `permission-mode` 记录，`--resume`、`--continue`、`/resume` 与 `-p --resume` 还原该模式（仍经切换闸门，命令行显式模式优先）。
- `/permissions` 新增 Auto mode 分页（列出分类器规则，可新增与删除用户规则，首条规则自动以 `"$defaults"` 保留内置规则）；新增 `/auto-mode-setup`（内置 skill，按官方提案规则生成 `autoMode` 提案，经用户同意后只写入用户设置）。
- `/yolo` 与 SDK `set_permission_mode` 一致：bypass 被策略停用时直接回报不切换，未同意过 bypass 时先显示警告对话框；未经同意或启动旗标时 Shift+Tab 轮替不出现 bypass；Shift+Tab 切换失败时显示错误并重置意图。
- acceptEdits、auto、bypass 下仍弹出的权限对话框多一行说明原因（安全检查、hook、Mod `tool.check`、ask 规则或分类器不可用）；每次模式切换写入 debug 日志 `[permission-mode] from -> to (source: ...)`。

#### Terminal、SDK 与 headless

- `Terminal` 工具接入权限检查：`new-session` 与 `send-keys` 按 Bash 规则判定（default 询问、dontAsk 拒绝、auto 经分类器），`send-keys` 按会话累积整行命令再判定，分段送出也会命中规则；只读动作直接放行。
- PermissionRequest hook 在纯 `-p`/`--print` 下也会触发（对齐官方 2.1.268），其 `updatedInput` 重新经过 deny/ask 规则与安全检查，`setMode: bypassPermissions` 在 bypass 不可用时被忽略（对齐官方 2.1.110）。
- SDK `set_permission_mode` 收到未知模式时返回错误并带 `error_code`（`invalid_mode`、`bypass_disabled`、`bypass_not_launched`、`auto_mode_settings` 等）；canUseTool 回调返回 allow 时可省略 `updatedInput`；格式错误的结果以说明预期格式的消息拒绝；`updatedInput` 不符合工具 schema 时工具不执行并说明是权限处理方配置问题。
- 交互式会话中后台子代理需要确认的操作改为在主会话弹出权限对话框并标示来源（如 `Bash command · from the general-purpose agent`）；`-p` 与 SDK 会话仍拒绝并说明原因。

#### Hooks

- PreToolUse 与 PermissionRequest hook 的 `updatedInput` 按工具输入 schema 校验：未知字段丢弃，类型错误或被 `validateInput` 拒绝时拒绝该次调用（对齐官方 2.1.300，Mods classic 路径同样适用）。
- `UserPromptSubmit` hook 在 skill 或自定义斜杠命令展开之前运行，拦截时命令正文的 `!` shell 命令不再执行；匹配值为空的事件只触发未设置 matcher 的 hook（对齐官方 2.1.275、2.1.299）。
- hook 输出中的 `<system-reminder>` 标签被转义（对齐官方 2.1.292）；settings 中未知事件、坏 matcher 或坏条目单独丢弃并警告，PreToolUse/PermissionRequest 的坏条目仍使整个文件不生效；形如 `{...}` 但不是合法 JSON 的 stdout 报告为 hook 错误。
- command 与 HTTP hook 新增 `onFailure`（`continue`/`block`）；同一事件的 prompt/agent hook 最多 12 个并发；PreCompact hook 可阻止压缩；Stop 与 SubagentStop 可返回 `additionalContext`。
- 新增 `PreModelSwitch`、`PostModelSwitch`、`DirectoryAdded`、`MessageDisplay` 事件（`MessageDisplay` 每个文本块只触发一次，与官方逐行刷新不同）；SessionStart 可返回 `sessionTitle` 与 `reloadSkills: true`；command hook 获得 `$CLAUDE_EFFORT` 与输入 `effort.level`；`--debug` 记录每个 command hook 的结果与耗时。

#### 子代理、Agent Teams 与 SubagentHandback

- Auto mode 下 Agent 工具启动的子代理通过新的 `SubagentHandback` 工具交回最终报告，只有该次调用的内容作为结果送达（对齐官方 2.1.303）；`SubagentHandback` 只能由分类器放行，block 时报告仍送达但附 `SECURITY WARNING`，报告以 `[Subagent hand-back]` 框架呈现并中和伪造标签；`CLAUDE_CODE_SENDMESSAGE_HANDBACK=0` 停用。
- 已在运行的子代理跟随主会话当前的权限模式（对齐官方）：Agent 调用显式 `mode` 与 workflow 阶段的 `permissionMode` 作为上限；子代理声明 `permissionMode: auto` 而自动模式不可用时沿用父会话模式。
- 安装了注册 `tool.check` 的 Mod 后，auto、dontAsk 与无法弹出提示的后台场景照常工作：Mod 只对其 filter 命中的工具生效，剩余的 ask 走当前模式处理；Mods `tool.check` 路径下 bypass 对受保护路径同样不再询问。
- 进程内 teammate 在 leader 处于 bypass、acceptEdits 或 auto 时改用 leader 的模式（含回合进行中），leader 在 default 或 plan 时 teammate 保留自己的模式；teams 面板发给 teammate 的模式切换请求经与 SDK 相同的闸门；一次性提示「Teammates keep their own permission mode」只在确实有 teammate 停在其他模式时显示。

#### 请求韧性与模型

- 新增无人值守重试模式 `CLAUDE_CODE_RETRY_WATCHDOG`（429/529 持续退避、其他瞬时错误默认重试 300 次、spend cap 类 429 立即失败），以及 `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS`、`CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`、`CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS`、`CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`。
- OpenAI provider 的 408/409/429/5xx 请求错误改走统一重试策略；`usage_limit_reached`、`insufficient_quota` 与认证错误仍立即失败。
- 新增 settings `fallbackModel`（数组，最多 3 个）与 `--fallback-model` 逗号列表：主模型连续 529 时按链依次切换，下一轮用户输入回到主模型；新增 `ANTHROPIC_DEFAULT_MODEL`（优先级低于 `--model`、`ANTHROPIC_MODEL`、settings `model` 与组织默认模型）。
- 自定义 `ANTHROPIC_BASE_URL` 且无可用 Anthropic OAuth 时，fast mode 组织状态从缓存读取，不再把网关密钥送往 api.anthropic.com（#46）。

#### Monitor、/loop、记忆与压缩

- 新增 `Monitor` 工具（默认建置启用 `MONITOR_TOOL`）：后台运行监看命令，stdout 每行作为 `Monitor event` 通知唤醒模型，200ms 内合并、超长截断、速率抑制与持续洪泛自动停止；`timeout_ms` 默认 300000，交互模式最长 30 分钟、`-p` 最长 10 分钟；权限沿用 Bash 规则，`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 下不提供。
- 新增 `ScheduleWakeup` 工具：`/loop` 动态模式下由模型选择下次唤醒秒数（60–3600）、原因与重新送入的输入，`stop: true` 取消待触发的动态唤醒；`/loop 5m …` 仍走 `CronCreate`；两个工具在 OpenAI provider 下同样可用。
- 新增 `/recap`：立即生成一到两句会话回顾（支持 `-p`）；回顾复用主对话 fork；载入记忆文件时删除不可见字符并转义伪造的 harness 标签。
- 新增 `/autocompact [auto|<tokens>]` 与设置 `modelSettings.<model>.autoCompactWindow`（按模型保存自动压缩窗口）；自定义 Agent、插件 agents、`--agents` JSON 与 Mods `agent.register` 支持 `autoCompactWindow`（子代理窗口上限）与 `omitClaudeMd`；切换到更小上下文窗口的模型后由上一个模型先生成摘要。
- 远程 stream-json / SDK 会话的 `autocompact_state` 改为按当前模型即时解析窗口：`/autocompact` 写入的 `modelSettings.<model>.autoCompactWindow` 与会话中途的设置变更都会反映到 `effective_window`、`threshold` 和 `source`，与实际触发自动压缩的窗口一致；此前只读取启动时的顶层 `autoCompactWindow`（PR #89）。
- 新增设置 `worktree.baseRef`（`fresh`|`head`）；`EnterWorktree` 新增 `path` 参数进入已有 linked worktree，以 `path` 进入的 worktree 不会被清理删除。

#### 快捷键、Vim 与 GrowthBook 默认值

- GrowthBook 关闭时按官方 2.1.303 取已 GA 的默认值：`~/.claude/keybindings.json` 自定义快捷键、ToolSearch 延迟工具增量宣告、`/model` `/effort` `/fast` 中途立即生效、ECONNRESET/EPIPE 重试前关闭 keep-alive、精简系统提示词开场句等；`/keybindings`、`/doctor` 快捷键诊断与热重载对所有用户启用。
- 新增 `chat:sendNow`（`Ctrl+Enter`，或 `Ctrl+X` 后 `Ctrl+S`）中断当前回合并立即送出；`Ctrl+J` 默认绑定 `chat:newline`。
- Vim 模式新增 `%` 配对括号跳转，以及 VISUAL（`v`）与 VISUAL LINE（`V`）选区操作；footer 与 statusLine `vim.mode` 显示 `VISUAL` / `VISUAL LINE`。

#### Mods API

- 新增 `$.session.append` 与 `session.append` hook、`prompt.mention` hook、`$.ui.notify`、`$.session.identity()`、`$.tool.register` 的 `isDeferred`；`agent.spawn` 覆盖 workflow 脚本的 agent 与 Agent resume；`tool.check` 回执新增 `setting` 与 `decider: 'host'`；subagent 与 teammate 回合也触发 `turn.start`；`skill.prompt` 事件新增 `frontmatter`、`source`、`pluginName`、`path`。
- `$.http.fetch` 响应正文上限 4 MiB 并按官方处理重定向；`$.env.set` 改为返回 `{}` 或 `{ deny }`；`$.session.compact` 先报告 `DISABLE_COMPACT` 与正在运行的 turn；headless 无 surface 时 `$.ui.open` 回执 `isPlaced: false`。
- Mods `Text` 支持 `size`、`weight`、`mono`、`tabular`、`dir`，`Box` 间距接受 `xs`..`xl`，`Input` 支持 `rows` 多行输入。

#### 2026-10-23 之后：背景会话与 daemon

- 新增背景会话（默认构建启用 `BG_SESSIONS`、`DAEMON`）：`claude --bg <提示>` 或 `/background` 把会话交给按需启动的 daemon，`claude agents` 一屏查看等待、运行与完成的会话，`claude attach`、`claude logs`、`claude stop`/`/stop`、`claude rm`（同时清理 worktree）与 `claude daemon status|logs|stop [--any] [--keep-workers]`、`/daemon` 管理（#131、#135）。
- 背景 worker 运行在独立 PTY host 下；daemon 在最后一个 worker 结束后自动退出（此前 `claude stop` 后 daemon 一直把 worker 计为运行中）；socket 与信号处理兼容 macOS、Windows 命名管道与 Termux（#137）；agents 视图标题显示配置的 `uiName`。

#### 2026-10-23 之后：跨会话通信

- 空闲会话收到的跨会话消息以 peer 输入框架呈现（#109）；权限模式不一致被暂扣的消息弹出官方「Held message from another session」Deny/Deliver 对话框，发送方收到 `[Cross-session delivery notice]`（#110）。
- `SendMessage` 支持 `notify_when_idle` 与 `msg_id`，结果文本与官方一致；`ListAgents` 改为官方文本列表，列出本会话、子代理、teammate 与 peer（#111）。

#### 2026-10-23 之后：Dynamic Workflow

- Workflow 脚本 agent 与官方 2.1.303 对齐：经子代理系统提示与 provenance 框架下发、文本结果 NOTE、默认停滞超时与并发覆盖，`agent()` 的 `effort`、`disallowedTools`、`bashCommandClamp` 生效，同前缀 agent 错开启动，运行行显示官方「Large workflow」提示；运行记录按官方目录与 v2 journal key 保存。
- `/workflows` 与详情对话框可把动态 workflow 保存为命名 workflow；移除 `WorkflowTool` 动作工具，已保存的 workflow 通过 `Workflow({ name, args })` 运行；新增内置 `workflow-authoring` skill 与官方精简版 Workflow 工具提示。

#### 2026-10-23 之后：斜杠命令与界面

- 新增 `/skill-doctor`（列出加载了但从未使用、占用上下文的 skill，含 7 天 token 列）与 `/focus`（每轮只显示提示、一行摘要与回复），对齐官方 2.1.303。
- 回合进行中 `/permissions`、`/skills`、`/tasks`、`/stats`、`/help`、`/theme`、`/config`、`/add-dir` 等立即打开；`/usage` 对 API key 与网关用户开放，`/cost` 并入 `/usage`，`-p "/usage"`（及 `/cost`、`/stats`）输出文本；`/diff` 仅在全屏下立即打开。
- `/skills` 可在 on / 仅名称 / 仅用户调用 / off 间切换并写入 `skillOverrides`；重试从第一次起在 spinner 行倒计时；排队消息显示 send-now 提示；MCP 批准对话框文案与默认焦点对齐官方；`!` 输入原样保留在 transcript。
- 修复：全屏下 Terminal/Monitor 详情对话框重叠、Monitor 事件行显示第一行输出、`/keybindings` 模板的 `Scroll` 上下文报错、effort 变化时 footer 提示不更新、非全屏退出时 resume 提示与最后一帧重叠、`.mcp.json` 中被跳过的条目导致有效 server 不再询问批准。

#### 2026-10-23 之后：记忆与提示词

- 新增 `memory.sqlite.enabled`（及 `memory.sqlite.scopes`）：不再每次请求注入 MEMORY.md，改用 SQLite FTS5 索引与新 `SearchMemory` 工具检索记忆文件与过往 transcript，每条用户提示自动附上最相关的 5 个记忆文件；新增 `/setup-memory-db` 与 `/memory` 中的索引重建（#145）。
- 新增 `memory.extraction`（`sessionEnd` 默认 / `everyTurns` / `off`）：后台记忆抽取默认改为会话结束（退出、`/clear`、`/resume` 或 `-p` 结束）时执行一次（#146）。
- auto memory 段落与 Read/Edit/Write/WebFetch/WebSearch 等工具描述改为官方 2.1.303 精简版；自定义 `ANTHROPIC_BASE_URL` 且未设置 `ENABLE_TOOL_SEARCH` 时保留 tool search（不送 beta header，以文本宣告已发现工具），不再把全部延迟工具描述内联（#139、#140、#142）。

#### 2026-10-23 之后：Bash 沙箱

- `@anthropic-ai/sandbox-runtime` 升级到官方 2.1.303 同版本 0.0.80，新增 `sandbox.credentials`、`network.deniedDomains`、`strictAllowlist`、`tlsTerminate`、`filesystem.disabled` 等设置；仓库设置不能放宽沙箱，相关键只从用户、托管或 `--settings` 读取（#167）。
- `dangerouslyDisableSandbox` 的命令离开沙箱前询问，只有显式 allow 规则可免询问；`!` 命令在 strict 模式下也在沙箱外运行；沙箱内 `TMPDIR` 为每用户 `/tmp/claude-{uid}`；`Monitor` 命令不套用沙箱自动放行；linked worktree 只开放主仓库 `.git` 写入且 hooks/config 只读；托管设置忽略的条目在 `/status` 与 `/doctor` 中提示（#155、#161、#163、#167）。

#### 2026-10-23 之后：Agent SDK 与 VS Code 插件

- 回应官方 VS Code 插件 2.1.303 自绘界面所需的 26 个控制请求（`get_status`、`get_usage`、`get_memory_dialog`、`get_hooks_listing`、`background_tasks` 等），插件对话框不再报 `Unsupported control request subtype`（#158）。
- 新增 `--session-mirror`、`--resume-drops-turn`、`--managed-settings`、`--project-config-root`；`--tools` 拒绝列表外的全部基础工具；背景子代理消息带 `parent_tool_use_id` 串流，`task_*` 事件带 `run_id`、`spawn_depth`，背景 agent 运行时先保留 result、在 `task_notification` 之后送出；`stop_task` 对未知或已结束的任务回报成功（#88）。
- ChatGPT 登录（`CLAUDE_CODE_USE_OPENAI=1` 且使用 `~/.codex/auth.json` 的 ChatGPT 凭据）时，`initialize` 的 `account` 和 `claude auth status --json` 回报 ChatGPT 邮箱、账号名和方案（`authMethod` 为 `chatgpt`），且不带 `apiProvider`；VS Code 插件把任何非 `firstParty` 的 `apiProvider` 视为第三方，会隐藏账号、方案以及 5 小时和 7 天用量条。OpenAI API key 模式仍回报 `apiProvider: "openai"`（#183）。

#### 已知缺口

- Bash deny 规则命中时的拒绝消息仍沿用旧的「was blocked … allowed working directories」文案（官方为 `Permission to use Bash with command … has been denied.`）；PowerShell 的路径询问文案未改。
- teammate inbox 中的 `mode_set_request`/`team_permission_update` 仍会套用（官方直接丢弃）；官方 tmux pane teammate 对照未做。
- `/auto-mode-setup` 为 prompt skill，没有官方的非互动参数与 recon 流程；Auto mode 分页没有内置规则停用开关与 environment 文件编辑；Windows/UNC 路径规则只有单元测试。
- `MessageDisplay` hook 不做官方的逐行刷新；启动与插件安全的若干官方对齐项由用户决定暂缓。

### 测试覆盖

- 每个 PR 在其 worktree 上重建 `make build` 产物，以 `-p` 与 tmux 配合脚本化假 Messages API 跑案例，并与官方 2.1.303 binary 同条件对照；验收报告在 `research/acceptance/accept-*.md`，证据在 `research/probe/`（项目共享目录）。
- 权限规则：`src/tools/BashTool/bashPermissionHardening.test.ts`、`shouldUseSandbox.test.ts`、`src/utils/permissions/permissions.test.ts`、`permissions.mcpRules.test.ts`、`permissions.planMode.test.ts`、`filesystem.parity.test.ts`、`filesystem.pathRules.test.ts`、`filesystem.protectedFiles.test.ts`、`permissions.managedOnly.test.ts`、`permissionsLoader.localTracked.test.ts`、`src/tools/WebFetchTool/WebFetchTool.permissions.test.ts`、`src/services/mcp/headersHelper.test.ts`、`projectApproval.trust.test.ts`。
- 权限模式与自动模式：`permissions.autoModeSafety.test.ts`、`yoloClassifier.officialPrompt.test.ts`（含 `fixtures/autoModeDefaults303.json`）、`yoloClassifier.severity.test.ts`、`autoModeStash.test.ts`、`permissions.staleClassifier.test.ts`、`permissions.approveForMe.test.ts`、`approveForMe.test.ts`、`permissions.bypassSafety.test.ts`、`permissionSetup.test.ts`、`permissionSetup.resume.test.ts`、`permissionControl.test.ts`、`src/utils/settings/applySettingsChange.autoMode.test.ts`、`src/hooks/toolPermission/permissionModeUpdates.test.ts`、`permissionLogging.test.ts`、`handlers/recheck.test.ts`、`src/cli/structuredIO.recheck.test.ts`、`src/utils/conversationRecovery.permissionMode.test.ts`、`src/components/permissions/rules/AutoModeTab.test.ts`、`src/skills/bundled/autoModeSetup.test.ts`、`src/commands/yolo/yolo.test.ts`、`src/tools/TerminalTool/TerminalTool.test.ts`、`src/utils/safeMode.test.ts`、`src/cli/print.permissionPrompts.test.ts`、`print.permissionRequestHooks.test.ts`。
- Hooks：`src/services/tools/hookUpdatedInput.test.ts`、`toolHooks.test.ts`、`toolExecution.test.ts`、`src/utils/hooks.matcher.test.ts`、`hooks.sourceScope.test.ts`、`hooks.schemas.test.ts`、`hooks/hooksConfigManager.test.ts`、`messages.hookReminderEscape.test.ts`、`settings/hooksResilience.test.ts`、`processUserInput/processUserInput.mods.test.ts`、`src/services/compact/compactApiError.test.ts`、`src/utils/sessionStart.test.ts`。
- 子代理与 Teams：`src/tools/SubagentHandbackTool`、`src/tools/AgentTool/runAgent.handback.test.ts`、`permissions.subagentHandback.test.ts`、`src/utils/subagentHandback.test.ts`、`AgentTool/permissionMode.autoMode.test.ts`、`runAgent.subagentStop.test.ts`、`resumeAgent.permissionMode.test.ts`、`agentToolUtils.mcpDisallowed.test.ts`、`src/tools/WorkflowTool/runWorkflow.test.ts`、`src/utils/agentSwarmsEnabled.test.ts`、`src/utils/swarm/inProcessRunner.permissionMode.test.ts`、`teamHelpers.test.ts`。
- 设置与遥测：`src/utils/managedEnv.test.ts`、`managedEnv.launchEnv.test.ts`、`src/tools/SkillTool/managedRulesOnly.test.ts`、`src/commands/feedback/index.test.ts`、`src/services/api/metricsOptOut.test.ts`、`src/utils/fastMode.gateway.test.ts`。
- 请求韧性与模型：`src/services/api/withRetry.test.ts`、`claude-stream-watchdog.test.ts`、`claude-model-contract.test.ts`、`src/utils/model/model.test.ts`。
- Monitor、记忆、压缩与界面：`src/tools/MonitorTool`、`src/tools/ScheduleWakeupTool`、`src/skills/bundled/loop.test.ts`、`src/memdir/neutralizeMemoryContent.test.ts`、`extractMode.test.ts`、`src/services/awaySummary.test.ts`、`src/commands/autocompact/autocompact.test.ts`、`src/services/compact/autoCompact.contextWindow.test.ts`、`sessionCompact.mods.test.ts`、`src/tools/AgentTool/loadAgentsDir.agentFields.test.ts`、`src/utils/worktree.baseRef.test.ts`、`src/tools/EnterWorktreeTool/EnterWorktreeTool.test.ts`、`src/services/analytics/growthbook.cached.test.ts`、`src/keybindings`、`src/components/PromptInput/PromptInput.sendNow.test.tsx`、`PromptInput.cycleModeError.test.tsx`、`src/screens/REPL.submit.test.ts`、`src/hooks/useVimInput.test.tsx`。
- 2026-10-23 后续：`src/tools/BashTool/bashPermissionHardening.test.ts`（两种解析模式：`Bash(touch:*)`、`Bash(touch tl-x)` 与管道形式放行 `touch tl-x`；无规则时询问且为工作目录内文案；工作目录外与混合路径仍询问；安全检查、`cd` 复合、`cp -f`、Edit deny 不被覆盖；输出重导向文案，修复前失败）；`src/utils/agentSwarmsEnabled.test.ts`（未设置时关闭、`1`/`true` 启用、`0` 关闭、`--agent-teams` 强制启用）；`src/services/compact/autoCompact.contextWindow.test.ts` 与 `src/cli/print.streamState.test.ts`（按模型窗口后 `autocompact_state` 的窗口、阈值与 `source: "settings"` 与引擎一致，修复前失败）。
- Mods：`bun test src/services/mods`（`sessionAppend`、`promptMention`、`toolCheckReceipt303`、`uiNotify`、`sessionIdentity`、`declarationsOfficial303` 等）、`src/components/ModsPane.test.tsx`、`make check-mods-control-types`。
- ChatGPT 账号：`src/utils/openai-auth-env.test.ts` 覆盖 `getChatGPTAccountInformation` 在 ChatGPT 登录、非 OpenAI 模式和 API key 优先三种情况下的结果（修复前失败）。
- 2026-10-23 之后的测试覆盖见各 PR 与 `docs/features/` 中的终端验收截图；发版前在 `dev` 修复了 `tsc` 与 `lint` 的 7 个错误（`hostControlRequests.ts` hooks 元数据类型、`SearchMemoryTool` 渲染与测试、`usageNonInteractive.test.ts` 命令类型收窄），并以重建的 binary 跑过 SIGINT SessionEnd、`CI=true` 无凭证 `-p` 与 team shutdown 三项回归。
- 各分支均通过 `tsc`、`make build` 与 `bun run check:changelog`；`bun scripts/build.test.mjs` 覆盖默认 feature 集合包含 `MONITOR_TOOL`、`EXTRACT_MEMORIES` 与 `AWAY_SUMMARY`。逐条目的测试清单见详细记录。

## 2026-10-24 - ChatGPT 登录：Codex 客户端版本跟进最新 Codex CLI

### 变更内容

- ChatGPT 登录下请求 `chatgpt.com/backend-api/codex` 时，`client_version` 改为 Codex CLI 版本 `0.164.0`，不再误送 Claude Code 自身版本号；`/responses`、`/models` 与 `claude ssh` 代理同时带上 `version: 0.164.0` header，与 Codex CLI 0.164.0 一致（#168）。
- Codex 版本集中为 `src/services/openai-oauth/client.ts` 的 `OPENAI_CODEX_CLIENT_VERSION`，之后跟进 Codex 版本只需改这一处。

### 测试覆盖

- `src/services/api/openai-compat.test.ts`、`src/utils/model/openaiModelOptions.test.ts`、`src/services/api/bootstrap-openai.test.ts`：断言 ChatGPT 请求的 `version` header 与 `client_version` 参数。

## 2026-10-24 - Dynamic Workflow：撞到 claude.ai 用量上限时暂停等待重置

### 变更内容

- 与官方 2.1.303 一致：claude.ai 订阅用户的 workflow Agent 因用量上限（带配额头的 429）停止时，工作流暂停到重置时间后 30–90 秒，再以 `<label> (after usage limit)` 重跑等待中的 Agent；同一时间只有一个等待，期间新 Agent 不会启动；重置超过 24 小时或本次运行已等过 2 次时直接失败并写明原因（#127）。
- 新增设置 `autoContinueAtUsageLimit`（默认开启）；关闭后撞到用量上限的 Agent 直接失败，等待中关闭则这些 Agent 不再重跑。带配额信息的用量上限错误不再做无意义的立即自动重试。
- 等待期间后台任务列表显示 `Paused · usage limit resets at <time>`，输入框下方的工作流行显示为 paused 并带重置时间。

### 测试覆盖

- `src/tools/WorkflowTool/workflowUsageLimitWait.test.ts`：官方常数、日志文字、多个 Agent 加入同一等待、过期重置上限、过远重置、设置关闭撤销与中止。
- `src/tools/WorkflowTool/workflowScriptRuntime.test.ts`：等待后以 `(after usage limit)` 重跑并完成；不能等待时只调用一次并在 `<failures>` 报告。
- `src/services/api/errors-quota-limits.test.ts`、`src/components/CoordinatorAgentStatus.test.ts`、`src/utils/settings/compactSettings.test.ts`、`src/tools/WorkflowTool/workerBackgroundLifecycle.test.ts`（背景子 Agent 失败时保留配额信息）。

## 2026-10-24 - VS Code 插件：支持 /memory、/skills、/hooks、/permissions、/diff 与背景任务控制请求

### 变更内容

- 新增控制请求 `get_memory_dialog`、`get_skills_dialog`、`get_hooks_listing`、`list_permission_rules`、`get_workspace_diff`、`get_task_output`、`background_tasks`（含 `tool_use_id` 单个任务）、`message_rated`、`submit_feedback`，VS Code 插件的对应对话框不再报 `Unsupported control request subtype`（#158）。
- `get_task_output` 在任务结束、已从会话状态移除后，仍可按 shell 任务 id 读取输出末尾 8 KiB。
- `submit_feedback` 回报 `unavailable_reason`，不从宿主上传反馈。

### 测试覆盖

- `src/cli/print.sdkControlRequests.test.ts` 新增：上述请求的成功与拒绝路径（未知任务、已结束任务、错误的评分参数）。

## 2026-10-24 - VS Code 插件：支持 /status、/usage 等宿主控制请求

### 变更内容

- 新增 VS Code 插件（2.1.303）自绘界面所需的控制请求：`get_status`、`get_usage`、`get_session_cost`、`list_models`、`get_binary_version`、`file_suggestions`、`get_plan`、`export_conversation`、`rename_session`、`set_prompt_suggestions_paused`。此前插件的 /status 等界面报 `Unsupported control request subtype`（#158）。
- `get_usage` 在 ChatGPT 登录的 OpenAI 模式下按窗口长度回报 5 小时与 7 天额度，并把各额度行列在 `model_scoped`；API key 与第三方 provider 回报 `rate_limits_available: false`。
- `initialize` 与 `list_models` 的模型项新增 `resolvedModel`。

### 测试覆盖

- `src/cli/print.sdkControlRequests.test.ts` 新增：上述请求均返回成功且格式与官方一致（status 行均为纯文本、cost 去除 ANSI、`rename_session` 拒绝已切换的 session_id）；ChatGPT 额度窗口映射。

## 2026-10-24 - VS Code 插件 / Agent SDK：支持 --thinking-display，mcp_status 列出 SDK MCP 服务器

### 变更内容

- 新增隐藏参数 `--thinking-display <summarized|omitted|highlights>`，与官方 2.1.303 一致写入 API 的 `thinking.display`。此前 SDK 设置 `thinking.display` 时 CLI 报 `unknown option` 并以 code 1 退出，VS Code 插件面板无法启动会话（#152）。
- `mcp_status` 在回应前先完成 SDK MCP 服务器连接，`initialize` 之后、首轮开始前或握手进行中查询时不再返回空列表；并发的 SDK MCP 更新合并为同一次连接，避免重复握手（#152）。

### 测试覆盖

- `src/services/api/claude-model-contract.test.ts` 新增：显式 thinking display 出现在实际请求的 `thinking` 字段，未设置时不出现。
- `src/cli/print.mcpControl.test.ts` 新增：`initialize` 后立即连续两次 `mcp_status` 都返回已连接的 SDK 服务器，且只建立一次连接。

## 2026-10-23 - 内建 Mods 扫描结果缓存：第一轮不再重新扫描 agents-md

### 变更内容

- 官方内建 Mods 位于每次启动都经过 digest 校验的只读缓存树，其 `loadModDeclaration` 扫描结果（agents-md 50 个模块，约 170–190 ms，且阻塞第一个 API 请求）现缓存到 `<cache>/<digest>.declarations/<key>.json`，key 含 CLI 版本、插件路径、入口、options 与 tier；缓存树之外的 Mod 仍每次扫描。
- SDK 单轮 `-p` 启动从约 0.6 s 降到约 0.37–0.42 s（首次启动写缓存约 0.55 s；官方 2.1.303 约 0.5 s）。AGENTS.md 仍在第一轮请求中生效（缓存命中与未命中均已验证）。

### 测试覆盖

- `src/plugins/builtinMods.test.ts` 新增：官方内建树的扫描写入缓存并在源文件移除后仍返回相同声明、不同 options 走独立 key；缓存树之外的 Mod 每次重新扫描且不写缓存。

## 2026-10-23 - 无头启动：跳过默认关闭的沙箱依赖探测并并行校验内建 Mods 缓存

### 变更内容

- `isSandboxingEnabled()` 先读取 `sandbox.enabled`，默认关闭时不再执行会 spawn 子进程的依赖探测（`-p` / SDK 每轮启动约 95 ms）。开启沙箱时的判定顺序与结果不变。
- 内建 Mods 缓存树的完整性校验 `treeDigest` 改为并行读取、按序哈希，digest 值不变，现有 `.complete` 继续有效；约 850 个文件的校验从约 70 ms 降到约 11 ms。
- 合计 SDK 单轮 `-p` 启动从约 0.77 s 降到约 0.6 s（官方 2.1.303 约 0.5 s，剩余差距见 issue #92）。

### 测试覆盖

- `src/plugins/builtinMods.test.ts` 既有用例覆盖缓存复用、损坏树恢复与被修改树的重建，digest 兼容性由 `.complete` 比对用例保证。
- `src/cli/print.sdkSystemPrompt.test.ts`、`src/cli/print.sdkControlRequests.test.ts` 覆盖无头启动路径。

## 2026-10-23 - Agent SDK 0.3 兼容与二进制启动加速

### 变更内容

- 兼容 TypeScript Agent SDK 0.3.x 在 `initialize` 中以 `string[]` 发送的 `systemPrompt`：未设置时（SDK 发送 `[""]`）恢复为 SDK 的最小系统提示，不再发送完整的 Claude Code 提示；自定义 `systemPrompt`（字符串或数组，数组各段以空行拼接并去掉 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`）与 `agent` 主线程提示重新生效；`getContextUsage()` 不再报 `e.match is not a function`。
- 新增 SDK 控制请求 `reload_skills`、`reload_output_styles`、`read_file`（与 Read 工具相同的读取权限判定，默认上限 1 MB，支持 base64）、`update_settings`（与官方相同的白名单：`localSettings` 只接受 `outputStyle`，`userSettings` 只接受 `effortLevel` 且不写入 `max`，未启用的 setting source 与远程传输会拒绝）、`mcp_read_resource`（只读取本进程连接的 MCP 服务器的 `ui://` 资源）。
- 二进制打包改用 `bun build --compile --bytecode`，启动时不再解析约 35 MB 的 JS：`--version` 约 550 ms 降到约 65 ms，SDK 单轮 `-p` 约 1.6 s 降到约 0.75 s。

### 测试覆盖

- 新增 `src/cli/print.sdkSystemPrompt.test.ts`，覆盖 `[""]` 保持最小提示且 `get_context_usage` 正常回应、数组拼接并去掉缓存边界、字符串照旧生效。
- 新增 `src/cli/print.sdkControlRequests.test.ts`，覆盖 `reload_skills`、`reload_output_styles` 的回应，`read_file` 的权限拒绝、截断与 base64，`update_settings` 的白名单与写入内容，`mcp_read_resource` 的 scheme 与服务器检查。

## 2026-10-23 - Direct Connect：server 实现、cc:// 解析修复与默认构建启用

### 变更内容

- 默认构建启用 Direct Connect：`claude server --port <port> --auth-token <token>` 启动 session server，`claude cc://<host>:<port>/<token>` 连接（交互式 TUI 或 `-p` headless），无需再设置 `CLAUDE_CODE_RECOVER_FEATURES=DIRECT_CONNECT`。
- `claude server` 原先只是不监听端口的空壳，现在用 Bun.serve 提供 `POST /sessions`、`GET /sessions/:id/ws` 与 `DELETE /sessions/:id`：每个请求校验 Bearer token，每个 session 在请求的 `cwd`（不存在时退回 `--workspace`）启动 `claude -p` stream-json child，工具权限请求转给 client 处理；`--idle-timeout`、`--max-sessions` 生效，banner 打印可直接使用的 `cc://` URL，运行期间写 `~/.claude/server.lock`。
- `claude server` 默认绑定地址由 `0.0.0.0` 改为 `127.0.0.1`；需要远程访问时显式传 `--host`，banner 会提示明文 HTTP 风险。
- `cc://host:port/<token>` 按官方格式解析为 `http://host:port` 与路径 token（此前未带 `?serverUrl=` 时请求原样发往 `cc://` 地址，必然失败）；`?serverUrl=` 可改写 HTTP 基址，`cc+unix://` 与格式错误的 URL 直接报错且不回显 token。
- 创建 session 的请求体改为官方字段 `cwd`、`permission_mode`、`session_key`（`--dangerously-skip-permissions` 映射为 `bypassPermissions`），失败时错误信息附带 server 返回的 response body。
- `claude server` 在终端里按 Ctrl+C 原先停不下来：启动期的 early-input 捕获把 stdin 置为 raw mode（ISIG 关闭），Ctrl+C 变成无人读取的字节而非 SIGINT；server 命令现在先停止捕获并恢复 cooked mode，Ctrl+C 走 `gracefulShutdown`（结束 child、删 lock，退出码 0）。
- client 校验 server 消息的 `StdoutMessageSchema` 原先不接受 CLI 实际发出的 `apiKeySource` 值（如 `ANTHROPIC_API_KEY`、`none`），导致 `system` init 消息被整条丢弃；`ApiKeySourceSchema` 现接受 `utils/auth.ts` 的 `ApiKeySource` 值。
- `claude cc://… -p` 原先什么都不做，现在发送 prompt、按 `--output-format` 输出 text/json/stream-json、收到 `result` 后按 `is_error` 设定退出码；未加 `--dangerously-skip-permissions` 时拒绝所有工具权限请求。

### 测试覆盖

- `bun test src/server/parseConnectUrl.test.ts`：官方格式、IPv6、percent-encoding、`?serverUrl=` 覆写、`?token=` 兜底、`cc+unix://` 与错误输入（不回显 token）。
- `bun test src/server/directConnect.e2e.test.ts`：用 Bun.serve 假 server 验证 `POST /sessions` 载荷与 Bearer token、错误附 response body、WebSocket 上 assistant/`can_use_tool`/result 收发与 client 回送 user、`control_response`、interrupt，以及 headless 的 text/stream-json 输出、权限允许/拒绝与断线退出码。
- `bun test src/server/server.test.ts`：真实 `startServer` + `SessionManager`（脚本化 child）验证 token 校验、请求体校验、`can_use_tool` 往返、`permission_mode` 透传、`session_key` 复用、`--workspace` 回退、`--max-sessions`、单 client attach、DELETE 与 idle timeout，并确认日志不含 token。
- `make build && CLAUDE_DIRECT_CONNECT_BINARY=$PWD/built-claude bun test src/server/directConnect.binary.test.ts`：编译后的 binary 运行 `claude server` 对接脚本化 Messages API，`claude cc://… -p` 验证权限拒绝/允许、stream-json、错误 token、lockfile、SIGTERM 退出，以及通过 `script` 分配 pty 后 Ctrl+C 能停掉 server 并删 lock；未设置该变量时跳过。
- `bun scripts/build.test.mjs` 断言默认 feature 集包含 `DIRECT_CONNECT`；`bun test src/server/directConnectManager.test.ts` 新增 CLI 实际发出的 `system` init 消息必须转发到 `onMessage`，其余用例保持通过。

## 2026-10-20 - v2.1.292 - 自动模式、Workflow、MCP 与插件生命周期对齐及 Linux 发布门禁

### 版本状态

- 发布版本：`v2.1.292`。`release-validation` 四路发布门禁在 `97ed301` 上通过（详见下方测试覆盖），其后有记录门禁结果与发布状态的文档提交；首次推送 tag 后 release workflow 的 Node 构建产物启动失败；修复后第二次运行仅 Windows 在 `--help` 失败（CRLF 检出改变了哈希固定的 Mods 声明资产）。第三次运行四个平台构建与 release 产物上传均通过，npm 发布因 `NPM_TOKEN` 被拒（401）失败，改为 npm trusted publishing（OIDC）。修复后均复跑相关测试与 release-check，并将 tag 移到最终修复提交。版本号 `2.1.292` 与本 fork 跟踪的官方基线一致，`Makefile VERSION` 与 README 发布版本同步为 `2.1.292`，`package.json` 保持 `0.0.0-dev`。
- 汇总 `v2.1.219` 之后至本版本 tag 的变更：原 `v2.1.280` 候选从未打 tag，其 2026-09-30 至 2026-10-13 的内容并入本条目；新增 2026-10-14 至 2026-10-17 的直接提交、PR #5、#6、#8、#10、#11、#13、#14、#15，以及 `release/v2.1.292` 上的发布准备修复。同一范围内下方 2026-09-15、2026-09-18、2026-09-19 三个未归版本条目保持原样，也属于本版本。

### 关联提交

- PR 合并提交：`6d96b73`（#5）、`b369eb8`（#6）生命周期审查；`5560c3d`（#8）MCP 准入与 Agent 权限模式；`7166e74`（#10）插件生命周期；`34d1599`（#13）MCP 完整性；`fd11faf`（#11）、`6a1cdbc`（#14）、`cf50f5c`（#15）Esonhugh-Marketplace。逐 PR 提交与直接提交见[v2.1.292 详细记录](docs/archive/implementation-records/changelogs/2026-10-18-v2.1.292-details.md)。
- 2026-10-14 至 2026-10-17 直接提交 `cbb28b0`..`fecf45f`（自动模式、模型目录、Workflow 语义、Channels、teammate mailbox、Mods Pane 交互、用量面板），列表同见上述详细记录。
- 原 `v2.1.280` 阶段的 Mods 分组包含 `e3e0c8f`、`338d488`、`8ff3c3f`、`b325dd2`、`8a94a5a`、`3a4929d`、`d757015`、`5acd2a3`、`6f8d8da`、`e3b2ff1`、`0bb0e00`、`8059f4a`；邻近夹具修复与剩余测试覆盖分别提交。
- 2026-09-30 至 2026-10-07 的逐批提交与验证细节见[v2.1.280 阶段历史记录](docs/archive/implementation-records/changelogs/2026-10-07-v2.1.280-details.md)。

### 变更内容

#### 需要用户处理的行为变化

- 插件选项与插件 MCP 的 `${user_config.*}` 值（`pluginConfigs`）只从用户设置、`--settings` 和托管设置读取；仓库 `.claude/settings.json` 中的 `pluginConfigs` 不再生效，需要时移到 `~/.claude/settings.json`。保存插件选项只写该插件条目，不再把合并后的 project/local 键（hooks、permissions、env）复制进用户设置。
- 安装插件时按 manifest/marketplace 的 `defaultEnabled` 写入依赖闭包内各插件的启用状态：`defaultEnabled: false` 的插件安装后为禁用（已启用的依赖方需要它时除外），需要时用 `/plugin enable` 启用；内联插件没有显式设置时也遵循该字段。
- Agent 声明的 `permissionMode` 对齐官方 2.1.292：父会话为 `bypassPermissions`、`acceptEdits` 或 `auto` 时不生效，声明 `bypassPermissions` 不再提升普通会话的权限；`bubble` 保留 plan/dontAsk 父会话的模式。spawn、runAgent 回退与 resume 共用这一规则，恢复的 Agent 模式同样钳制到父会话当前模式。
- 存在企业 MCP 配置时跳过 Agent frontmatter 中的 MCP 服务器；其余情况遵循 `allowedMcpServers`/`deniedMcpServers` 与项目禁用，并拒绝保留名称及仅宿主可用的传输（sdk、IDE、claude.ai 代理）。
- `CLAUDE_CODE_REMOTE` 改为真值判定，`0` 不再视为远程会话；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 与 `DISABLE_TELEMETRY` 仍按变量是否存在判定（与官方及 `v2.1.219` 一致）。
- Esonhugh-Marketplace 只在 `enabledPlugins` 引用它时声明（同官方 `claude-plugins-official` 的 fallback 声明方式），首次安装由交互式启动检查负责；删除后不会在下次启动被重新克隆，`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` 与启动检查的重试退避恢复生效，离线启动不再每次安装失败。
- Esonhugh-Marketplace 自动安装状态改存 `~/.claude.json` 的 `esonhughMarketplaceAutoInstall*`，不再与官方 CLI 共用 `officialMarketplaceAutoInstall*`，两边不再互相跳过安装；升级后启动检查会按新键重新执行一次。
- project/local 设置中的 `defaultMode: "auto"` 被忽略，只有 policy、用户和 flag 设置可授予自动模式；其他权限模式仍按设置层级生效。
- Workflow 对齐官方 2.1.292 默认开启（Pro 计划除外），不再需要 `enableWorkflows: true`；可用 `disableWorkflows`、`CLAUDE_CODE_DISABLE_WORKFLOWS` 或 `CLAUDE_CODE_WORKFLOWS=0` 关闭，README 的 Workflow 章节列出全部方式。

#### MCP

- 按名称查找 MCP 配置时应用会话准入规则（企业独占、仅插件锁定、`.mcp.json` 批准、`allowedMcpServers`/`deniedMcpServers`）：`claude mcp get` 对待批准、已拒绝或已禁用的服务器显示状态而不启动；Agent 按名引用与 print 模式 reconnect/auth 不再连接未批准服务器；`mcp remove` 仍可清理已保存凭据。
- `claude mcp get` 对省略 `type` 的 stdio 服务器显示 Type/Command/Args；未写 `type` 的 stdio 服务器退出时同样执行 SIGINT/SIGTERM/SIGKILL 回收，CLI 退出后不再残留子进程。
- `tools/list`、`resources/list`、`prompts/list` 跟随 `nextCursor` 最多读取 20 页；配置接受 `type: "streamable-http"` 并按 http 处理。
- `claude mcp serve` 不再声明 outputSchema，按输入 schema 校验参数，客户端取消时中止工具；`/mcp enable X`、`/mcp disable X` 对已处于目标状态的服务器提示 already enabled/disabled，不再反向切换。
- MCP 配置文件按服务器逐项校验：无效条目带原因（`invalid_config`、`unknown_type`、`url_missing_type`）跳过，不再丢弃整个文件；`--mcp-config` 输出跳过警告，`claude mcp list` 显示被跳过的条目。
- 服务器配置支持 `timeout`（单服务器工具超时，不小于 1000ms，优先于 `MCP_TOOL_TIMEOUT`）、服务器级 `alwaysLoad`、`oauth.scopes`（在 OAuth 流程中请求）与 `bareElicitationCapability`。
- 新增 `claude mcp login <name>`（支持 `--no-browser`）与 `claude mcp logout <name>`，用于 HTTP/SSE 服务器并复用 `/mcp` 的 OAuth 流程；claude.ai connector 仍提示到 `/mcp` 处理。
- `claude mcp list` 显示待批准和已禁用的项目服务器且不连接它们；`/mcp reconnect all` 重连失败及需要认证的服务器；`-p` 模式下 `/mcp` 输出状态摘要，控制操作与官方一样仅限交互模式。
- Agent frontmatter 服务器使用 `agent` scope，与父会话 `--mcp-config` 配置相同的内联服务器不再共用并关闭父会话连接；并发 Agent 共用的内联连接改由最后结束的 Agent 关闭。
- print 模式 `mcp_reconnect`、`mcp_toggle` 使用会话当前配置（来自设置文件的服务器除外），不再重复创建 client 和工具；`mcp_set_servers` 与 reconcile 按规范化前缀移除工具，名称含 `.` 或空格的服务器不再遗留工具。
- 工具结果对齐官方 2.1.292：带 `structuredContent` 的结果保留图片和资源块，并在末尾追加 JSON 文本；`isError` 合并全部文本块与资源链接；资源工具在任一已连接服务器支持资源时只保留一份，重连后不再累积。
- 客户端能力对齐官方 2.1.292：roots 包含附加工作目录并在目录变化时发送 `notifications/roots/list_changed`；声明 URL 模式 elicitation（主机名黑名单或 `bareElicitationCapability` 时为 `{}`，拒绝该字段的 Java SDK 服务器以 `{}` 重连一次）。
- http 服务器的 initialize 收到非 JSON-RPC 的 4xx（401/403/429 除外）时回退旧 HTTP+SSE 传输；调用仍在连接中的服务器的工具时最多等待 min(连接超时, 10s)，不再立即报 "No such tool"。
- 手动重连先解除旧 client 的 onclose，不再与自动重连并行而泄漏连接；被禁用、切换或配置变更取代的自动重连丢弃结果并关闭该连接，不覆盖较新的状态。

#### 插件与 Marketplace

- 新增 `--plugin-url <url>`（可重复，按空白拆分，同官方）为本次会话加载插件 ZIP：仅 http/https，30 秒超时，声明与实际大小上限 256 MiB，先写 `.part` 再改名进 0700 会话缓存，重新下载失败时复用上次归档，日志只记录 URL 的 origin 和 path；遵循 `NO_PROXY`，`disableSideloadFlags` 拒绝该参数，受限策略与 `--plugin-dir` 一样丢弃 URL 插件。
- 插件加载按 local > project > user > managed 选择与当前会话相关的安装记录，不再采用共享 `installed_plugins.json` 中其他项目的过期项目级记录；project/local 安装（含启动时选择的安装）记录会话原始 cwd，`cd` 后安装的插件可以正常卸载。
- `/reload-plugins` 先写 AppState 再让 Mods 重新投影运行时注册的 Agent，不再覆盖它们；禁用最后一个提供设置的插件时重置设置缓存；后台 marketplace 安装后运行完整加载器，新声明的 github/url 插件无需重启即可缓存；重载计数不含内置插件。
- Marketplace 重新克隆先写入临时目录，成功后才替换，离线或远端不可达时保留现有克隆；`known_marketplaces.json` 在跨进程锁下合并写入，并发 autoupdate/add/remove 不再丢失或复活条目。
- 已是最新版本的插件更新不再重建版本目录，同版本跨 scope 安装复用已有目录；自动更新按 marketplace 原始名称刷新，含大写字母的名称（包括 Esonhugh-Marketplace）恢复刷新，失败次数计入统计。
- 已注册 directory marketplace 的插件与官方一样原地读取源目录（`installed_plugins.json` 版本不随之前进）；源目录被删除时报告官方文案 `Plugin directory not found at path: …`，不再显示原始 ENOENT。
- LSP 配置接受官方 `requestTimeout`（默认 60 秒，按请求生效）与 `diagnostics`（为 false 时忽略 publishDiagnostics），使用这些字段的插件不再被 schema 拒绝。
- Esonhugh-Marketplace 插件的 hook 遥测按官方 marketplace 计数（名称比较改为大小写无关）；启动安装提示改为显示 Esonhugh-Marketplace，不再写作 "Anthropic marketplace"。

#### Agent、任务与 Teams

- 发往已终止或失败 owner 的子 Agent 通知改投主线程；owner 结束时只清理自身的非 Agent 通知，后台子 Agent 的结果保持排队；通知入队后才标记已通知，并发终态路径去重；Agent 通知与 Workflow 一样转义并限长。
- 后台 Agent 结束时仍有待发的 SendMessage 文本，会再运行一轮投递（官方 stranded resume）；ESC 批量终止覆盖 parked owner，只报告实际终止的 Agent；子任务均已标记通知但没有结果的 parked owner 解除等待并报告完成。
- 达到 `MAX_SUBAGENT_DEPTH` 的 Agent 不再获得 Agent 工具（调用时检查保留）；解析后的 `Agent(x, y)` 子集传入子上下文；只有 fork 子 Agent 向下传递 querySource；移除 worktree 时只清除 worktree 字段；transcript 无变化时跳过周期性摘要 fork。
- 前后台续接为保留任务追加流式消息，后处理抛错时保持 completed，killed/failed 前刷新进度用量；恢复失败的 parked owner 获得结束时间与回收宽限期。
- Team 文件改用异步锁写入，成员移除、模式同步与隐藏面板可以持久化，TeamDelete 不再因残留成员被拒；TaskStop 与 SDK `stop_task` 可以停止 in-process teammate；交互、`-p` 与 mailbox attachment 三条 shutdown_approved 路径统一结束 teammate 任务。
- 任务收尾：bash 任务由 killTask 发出 SDK stopped 事件；Workflow 不再在 XML 通知之外重复发送 SDK `task_notification`；完成的后台主会话任务获得回收期限；Workflow 进度事件只保留最近 200 条；清空 mailbox 加锁，已读消息不再在每次轮询时重写。
- teammate mailbox 写入失败不再视为已投递：spawn 写入初始指令失败即中止并关闭新面板，shutdown 与 plan 审批报告未发送，广播列出写入失败的收件人；resume 能找回内置 teammate 定义，并拒绝 resume 无法恢复的 teammate 名称。

#### 启动、设置、Workflow 与 Mods

- 每帧开始时同步读取真实终端尺寸：此前产品繁忙时 Bun 推迟派发 SIGWINCH，resize 后仍可能按旧尺寸绘制数帧（实测最长约 250ms）；尺寸变化时沿用原有 resize 处理。
- 标签页的按键归属改为读取同步更新的焦点与 opt-in 状态：此前 `/config` → Stats 中快速按 ↓ 再按 Tab（或在 React 提交前到达的后续按键）会被外层设置页抢走，OpenAI 图表加载后的第一次 ↓ 可能被丢弃，刚进入图表就按 ↑ 也会把焦点交回外层。
- 提交输入时通过输入框句柄同步清空草稿；此前 Mods `prompt.read()` 要等输入框重新渲染才看到空草稿，提交的本地命令（如 Mods 建议）抢先执行时会读到刚提交的文本，高负载下偶发 `suggestion=hidden`。
- 原生终端采集的帧边界标记库在 Linux 上同样加载（仍只在设置 `CLAUDE_PRIVATE_NATIVE_JOURNAL_LIBRARY` 的采集环境中生效，普通会话不受影响），供 Linux 发布门禁记录逐帧证据。
- 移除 `main()` 提前注册的 SIGINT 处理器，Ctrl+C 进入 graceful shutdown，SessionEnd hook、清理注册表与 Mods 释放得以执行；`main()` 拒绝时以错误退出；退出时关闭 InteractiveTerminal PTY 会话。
- CI/测试环境只在没有其他凭据来源（`ANTHROPIC_AUTH_TOKEN`、apiKeyHelper、OAuth token 文件或非一方 provider）时才要求 Anthropic 凭据，`claude -p` 不再因此挂起。
- `/config` 修改默认权限模式只写 `defaultMode`，不再把 project/policy 的 allow/deny 规则复制进用户文件；"Use auto mode during plan" 显示运行时值，在策略或 flag 强制关闭时锁定；托管设置 `managedSourcesBehavior: "merge"` 对限制性键取最严格值。
- 设置来源的 plan 默认模式在 planModeAvailable 关闭时降级为 default 并提示，不再拒绝启动；显式 `--permission-mode plan` 仍报错。
- `/config teammateDefaultModel=<auto|inherit|model>` 与对话框写入相同值，拒绝选择器未列出的模型，行校验器在写入时执行；`workflowKeywordTriggerEnabled`、`skipWorkflowUsageWarning` 进入设置 schema，Dynamic workflows 行锁定为策略有效值。
- 声明式 Workflow 的默认并发上限 `min(16, max(2, CPU 数-2))` 与官方一样只在运行时排队，不再拒绝 spec：4 核及以下机器上含多个独立 phase 的 workflow 不再被静默丢弃，只有 spec 显式写 `defaults.maxConcurrency` 时才校验；单个 phase 的并发也受该上限约束。
- Workflow 终态任务在结束时间加面板宽限期后回收；交互式 `/workflows` 合并已持久化的运行记录，回收后的运行仍可只读查看；与官方一样只列出当前会话发起的运行（其他会话的运行可按 run id 查看），列表行指标以耗时开头（`0s · 2 agents · 4 tok`）。
- Workflow 启动只解析 meta 并编译脚本，不再预执行脚本体，语法检查在 Bun 1.3.14 与 1.4.2 下均生效，内联脚本（含覆盖已保存 workflow 的内联脚本）编译失败时不再在 `.claude/workflow-runs` 留下文件；失败的 `agent()` 返回 null 并列入完成通知的 `<failures>`，单次运行最多 1000 次 `agent()` 调用；resume 拒绝运行中或没有 journal 的运行。
- Mods 热重载期间不释放替换激活仍在使用的 MCP 服务器，Worker 退出时释放；`tool.call` 只在调用源自用户本人交互时附加 `consent`；hook 外启动的模型调用随激活卸载中止；首次 bind 失败不再让 `receive()` 永久等待。
- Mods `$.session.turns` 在 REPL、print 与 QueryEngine 共用计数；`$.env.set` 的写入随激活结束失效，拒绝重定向宿主凭据或向子进程注入代码的变量名；插件根目录轮询忽略 `node_modules`、`.git`。
- Mods 在 session.start、plugin.register 中调用 `command.run`、`prompt.submit`，以及在 turn.start、turn.step、prompt.mention 中调用 `prompt.submit`，均改为拒绝而非死锁；turn.complete 中可以提交 prompt。
- Mods Pane：点击未聚焦面板正文获取键盘焦点、点击外部释放；空 composer 且无对话框时 Escape 请求关闭未聚焦的可关闭面板；滚轮按 transcript 方式加速，重叠滚动按顺序应用。

#### 权限、模型与 Channels

- 自动模式对齐官方 2.1.292：Claude 登录与 API key 均可使用，移除 "Enable auto mode?" 确认，Shift+Tab 与 `--permission-mode auto` 直接进入，首次说明只显示一次；OpenAI 模式只在 ChatGPT OAuth 登录时以 "auto (Approve for me)" 提供；Claude 4.0 模型不进入自动模式。
- Claude OAuth 下获取服务端模型目录（按组织缓存，失败时回退旧缓存），`/model` 与 `--model` 列出并接受目录模型，Default 跟随账户或组织默认模型；effort 符号改为官方 xHigh/Max 样式。
- Channels 消息中的 `@path` 和 `@server:uri` 不再作为附件读取；内容中的闭合标签被转义，不能伪造其他来源的消息块。

#### 已知缺口（本轮）

- 已知缺口：Coordinator 模式不在默认构建中，需要构建时设置 `CLAUDE_CODE_RECOVER_FEATURES=COORDINATOR_MODE` 并在运行时设置 `CLAUDE_CODE_COORDINATOR_MODE=1`；MCP step-up 重新认证对话框、resource templates 与 completion、`mcp_tool` hooks、MCP Tasks、空闲超时、协议版本协商及 claude.ai connector 的 `mcp login` 仍未实现；前台 Agent 结束时待发的 SendMessage 仍会丢弃；headless 模式的非 sync 插件刷新尚未对齐；保留 marketplace 名称同时接受 anthropics 与 esonhugh 组织来源，此为有意保留；官方 `/code-review` 不走 workflow、官方 workflow worker 类型为 `workflow-subagent`，以及进入 REPL 前等待 served 模型目录（最多约 1.75 秒）尚未对齐。`/workflows` 子命令出错时（如 workflow、模板名或模板文件不存在或无效）没有任何输出，错误只写入 debug 日志，此为 v2.1.219 起的既有问题。
- 已知缺口：发布门禁的 `terminal-interaction`、`terminal-canonical-diff` 只差 `full_terminal_coverage`，`builtin-mods` 只差 `terminalEvidence` 的产品时序保留；两者要求完整 termios、无观测时序与真实 child read/parser/owner 证明，原生采集协议在 macOS 与 Linux 上都尚未实现，相关断言保持不变。

#### 原 v2.1.280 阶段（2026-09-30 至 2026-10-16）

- 验收基础设施：新增 Darwin shared-slot 原生采集器，保持原 write/writev/NOCANCEL 及 errno；丢失、截断、来源或时序不明继续拒收。修复 native probe 的空 packet 收据和异常回收，新增 live CAS/循环复用与 partial/EFAULT 回归。21 项局部 probe 通过；完整无 ACK Ink/TTY/输入验收未闭合，不宣称 Mods/UI 发布通过。

- 用量面板：对齐固定官方 2.1.292，读取 usage 接口 `limits[]` 中按模型划分的周窗口，在 `/usage` 的 Sonnet 行之后显示 `Current week (Fable)` 等允许列表内模型的用量；允许列表取 `tengu_usage_overage_included_models`，缺省为 Fable 系列，surface 行和其他模型不显示。响应头 `7d_oi` 窗口进入原始用量，`seven_day_overage_included` 限额文案为 `Fable limit`，SDK 限额类型同步。达到 Fable 限额后的 usage credits 确认对话仍未实现。
- 终端选区：选区滚动、输入跟随与复制去重已合入；`$.ui.selection()` 读取当前选中文字，存在可确定的消息归属时附带 `requestId`，并保留已持有的 VM 回调。完整 terminal/diff/browser Client 生命周期仍未通过验收。
- Mods 注册与类型：空模式 `!*` 不匹配事件，校验器识别合法 bare `on` helper；Worker 限制同一原始模式的重复注册。静态校验不执行 helper，重复调用的动态检查仍由 Worker 负责。声明测试复用各自的本地/官方编译缓存，保持原有期限与类型断言。
- 作者测试：每个文件的 HOME 放在作者目录之外；成功、失败和终止后只回收本次运行创建的 HOME 与内联插件目录，保留并发运行文件。测试 registrar 的异步注册、catch 和惰性流行为仍未合入，README 示例按当前可用入口修正。
- 会话与 Agent：加入拥有明确归属的 transcript 读取器，收紧带标签 Agent ID 的生成和解析；mailbox 写入成功后返回内部确认，释放锁失败单独记录。公开 transcript 接线、teammate 身份/恢复及确认回执的消费者仍有未提交部分。
- SDK 模型切换：队列消费等待已接收的 `set_model` 校验，紧随其后的用户消息使用新模型及其默认 effort；stdin 控制消息继续处理。普通 Sonnet 请求省略显式 `high` 的既有差异保持记录。
- 已知缺口：托管 Mods 准入依赖的原生文件监听测试、Client 故障次数和保留焦点测试仍阻塞相应产品组；caller chain、Worker reload 及 teammate 恢复不能据本轮局部通过视为完成。官方基线保持 2.1.292，既有 Button/Pane/diff 2.1.295 与 OSC 7501 2.1.296 专项不变。

- Mods 模块入口：对齐固定官方 2.1.292，hooks.json 接受不带 ./ 的文件名及嵌套路径；前导 / 仍从声明文件所在目录拼接，目录越界和外部符号链接继续拒绝。十组真实 CLI 的准入结果及 hook 回执一致；完整 hooks.json 和 Mods/UI 兼容仍待验收。

- Mods 文件状态：对齐固定官方 2.1.292，末端符号链接因循环或超过系统跳转上限无法跟随时，fs.stat 返回链接自身元数据并省略 realPath；路径中间的循环链接仍报错。macOS 13 组真实 CLI 完整回执逐字匹配；完整文件 API 和 Mods/UI 兼容仍待验收。

- MCP 指令上下文：SDK 连接保存 initialize 返回的 instructions，普通连接与 SDK 共用长度处理；对齐固定官方 2.1.292，将指令通过消息传给模型。默认上限 2048 个 UTF-16 单元，可用 CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH 配置正整数；截断避免半个代理对并打印原长度和上限。 磁盘记录及恢复上下文尚未对齐。

- SDK 动态 MCP：stdio 配置在创建连接前复制 `args`，省略参数数组时返回固定官方 2.1.292 的展开错误，失败结果仍可查询和移除；显式 `args: []` 可用。系统启动错误文案和完整 MCP 生命周期继续独立对齐。

- SDK MCP 元数据：连接成功后保存 initialize 返回的 serverInfo，状态回执保留服务器名称、版本和合法扩展实现信息；对齐固定官方 2.1.292。

- SDK MCP 状态：新增独立于 scope 的 source 定义来源字段，对齐固定官方 2.1.292 的用户、动态、插件和 SDK 来源；同步可选字符串 schema 与类型定义。完整 MCP/Mods 生命周期仍待独立对齐。

- 自动压缩来源：对齐固定官方 2.1.292 的原生 1M 模型默认值和未知模型窗口保护；保留显式 1M、已知旧模型、禁用自动压缩、已声明能力及 inference profile 的来源边界。共享解析结果同时用于远程状态和压缩阈值，避免 reactive 模式将受保护窗口误当作 `auto`；实际 API 超限后的 reactive 压缩仍待验收。

- SDK 模型切换：`set_model` 先验证自定义模型，再修改会话状态；失败保留原模型，返回官方 2.1.292 的具体错误和可选错误码。API 验证期限为 5 秒，超时取消请求，晚到结果不缓存；串行切换期间仍处理其他控制消息，类型和 schema 保留错误码。
- 自动压缩窗口：环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 对齐固定官方 2.1.292 的整数前缀、整值科学计数法和千位分隔符解析；限制为 100,000–1,000,000 tokens，再按模型窗口限制。无效值保留原有回退，压缩阈值和远程 `autocompact_state` 使用同一结果，非法／超上限值打印诊断。
- 新增隐藏选项 `--plugin-dir-no-mcp`：每次接收一个路径，可重复使用；保留插件命令和 Mods，跳过引擎的 MCP 发现。与 SDK 跳过来源合并，过滤重叠的环境变量来源，显式普通 CLI/SDK 来源仍可发现 MCP；托管策略拒绝在加载前生效。
- 会话插件路径：`--plugin-dir` 和 SDK 启动来源支持父目录、ZIP、大写扩展名及单层包装目录；跳过 MCP 的来源标记随展开结果保留。ZIP 按内容复用缓存，更新时发布完整目录，失败时保留旧缓存；预览更新不替换运行中的版本，退出清理会话缓存。
- SDK 启动插件：新增 `--await-initialize`，在启动加载前接收 `initialize.plugins`，支持跳过 MCP 发现、保留后续输入及托管策略拒绝；重复初始化只返回 `plugins_applied`，不动态加载插件。空白行和无结尾换行的处理对齐固定官方 2.1.292。
- Mods 自身预算排除调用 hook 前的 UI 权限同步等待，避免插件尚未执行就被误判超时；保留默认 50ms 编辑预算。普通/Vim 真实 CLI 的填入、编辑回执、预算和 composer 绘制与固定官方 2.1.292 一致，完整 UI 和 Client 生命周期仍待验收。

- 插件缓存：对齐固定官方 2.1.292 的 14 天孤立版本保留期和临时目录名规则，保护已安装引用、新临时目录、ZIP 与目录重填，保守处理安装记录读取失败并避免跟随标记/版本链接。macOS 真实启动的保留、清理及文件内容结果与官方一致；其他平台和存储后端仍待验收。
- Mods guard：运行时名称与存储 ID 对齐 `cc-plugin-sec-default` / `cc-plugin-sec-default@builtin`；排序配置保留官方旧别名 `sec-default@builtin` 并归一化大小写，阻止外部插件冒充宿主 guard。只有管理员策略或服务器已验证的远程策略可以显式移除 guard；磁盘缓存继续提供普通策略值，但其 `prependPlugins` 不能撤销 guard。固定官方 2.1.292 的默认、缓存空排序、自定义排序和新旧名称真实启动场景通过对照；远程刷新及跨平台管理员来源仍待验收。
- Mods 工具权限：`tool.check` 回执补齐经典 Hook 事件来源、与最终裁决相符的嵌套规则及 allow／ask 的命中规则回退；公开查询不运行经典 Hook。经典命令 Hook 的拒绝消息补齐事件／工具错误前缀，且保留策略来源，防止格式化影响受保护的策略裁决。固定官方 2.1.292 的四个真实 CLI 场景中，经典 Hook 结果和权限查询回执一致；完整工具契约继续独立验收。
- Mods 作者工具回执：从最终工具消息生成公开结果，区分权限／插件拒绝与普通执行错误，合成结果保留 mapper 生成的文本；内部引用、只读标记与模型上下文继续留在 middleware。新增作者、工具、结果类别、文本长度和耗时诊断，不记录参数值。固定官方 2.1.292 的八个有效回执结构一致；插件拒绝归因的后续修复见下一项，完整工具契约继续验收。
- Mods 权限归因：真实工具检查保留相同裁决的原权限来源、已批准输入和空原因时的拒绝消息；只有实际调用 `next` 才采用核心输入改写。改变裁决时按匹配插件名单生成拒绝／审批消息，短路仍保留匹配插件、重复注册只计一次，并区分缺省和空字符串原因。新增工具、核心调用状态、hook 裁决和插件名单诊断。固定官方 2.1.292 的十一组真实 CLI 场景中，查询、调用和事件记录逐项一致；connector ceiling 及完整工具生命周期继续验收，子 Agent 检查身份的后续修复见下一项。
- Mods 工具检查身份：真实子 Agent 的权限检查携带与 `tool.call` 相同的 `agentId`，主循环、作者工具调用及公开查询不冒用 Agent 身份。恢复省略的宿主元信息，拒绝显式改变固定字段，并返回带实际插件名与字段名的 `HooksError`。增加 Agent ID 和检查阶段诊断，不记录参数正文。固定官方 2.1.292 的四个真实 CLI 场景中，按调用 ID 核对的身份、查询及完整错误一致；原始请求交错仍有差异；控制子任务返回时机后双方均产生额外完成请求，请求数量不作为独立失败判据。完整 Agent 生命周期继续验收。
- Agent 启动回执：对齐固定官方 2.1.292 的内部元信息提示、SendMessage 摘要参数及等待完成通知的操作说明；可读输出路径缺失时使用无路径回退，不再生成空 `output_file`。三项完整文字断言和两组真实 CLI 文字对照通过；条件共享目录提示、其他结果分支与完整 Agent 生命周期继续验收。
- Mods 不可用工具：`$.tool.call` 和 `$.tool.check` 抛出带实际调用插件名的 `HooksError`，作者输入不能伪造归因；保留动态工具退役后不可执行的检查。新增方法名、工具名和不可用结果诊断，不记录参数值。固定官方 2.1.292 的 Bash check／call、Read check 三项真实错误回执一致。
- Mods 作者诊断：`plugin validate` 保留 hook 注册顺序和各自 matcher，展示正则、列表、嵌套字段及可追踪常量；仅在没有直接调用时列出排序、去重后的 helper 来源，静态扫描不执行模块代码。固定官方 2.1.292 的七个 CLI 场景中 hooks/calls 输出一致；其他警告和诊断仍待对齐。
- 终端状态：按固定官方 2.1.296 探测 OSC 7501，使用 root 主记录、状态/等待种类、任务进度及后台任务子记录；仅发送变化，删除和退出时清理。无应答、禁用终端标题及后台会话不发送报告。等待消息包含完整命令、路径或 URL，与官方一致；缺少数据源的活动文本和回合结束摘要仍待接入。
- 远程 SDK：发送 `active_goal` 与 `autocompact_state`，同步目标、模型及活动压缩窗口变化并去重，切换 session 后失效旧快照，退出释放订阅；普通本地会话不发送这两类帧。已核对六个固定官方 2.1.292 初始化场景；窗口简写解析和 `set_model` 校验回执差异仍待修复。
- Mods 修复：公开 telemetry 调用恢复经过 hook 链和内置发送门控；notice 对齐 AskUserQuestion 底部位置；headless `turn.complete` 的 `command.run` 不再等待被当前 hook 持有的队列。保留 Privacy Mode，完整交互及多插件生命周期继续验收。

- 修复 Mods Pane 已显示但快捷键尚未登记、或重绘后仍指向旧 drawing 的时序窗口；action 在 layout commit 同步登记和释放，保留可核对动作/代次/准入状态的调试日志。

- 内置官方 diff Mod 的固定来源升级至 2.1.295；校验最新完整模块、身份模块、原始注册闭包及 scan，打包与运行加载同一来源。沿用官方最新 dock 行数、滚动偏移及无顶部留白布局；保留损坏/过期归档的明确错误与原生恢复，完整 UI/发布验收继续独立结算。见[diff 来源记录](docs/research/mods-shipped-diff-295-20261010.md)。

- 对齐官方 2.1.295 Pane 的控件/标签/关闭位置焦点环、可滚动内容优先级及标签选中/hover 样式；RenderElement Button 鼠标激活保留自定义键盘槽位。内部关闭位置移动经过真实 ui.focus 协商及取消/迟到保护，不改变作者公开 undefined focus 的释放含义；修复 Client Input 后 Tab 导航，完整发布门禁仍独立结算。见[Pane 焦点记录](docs/research/mods-pane-focus295-20261009.md)。

- Mods Button 对齐官方 2.1.295 的字符串/Text children、稳定 guest handle 和绘制持有生命周期；作者声明按固定摘要投影两个 Button 定义，其他声明仍为 2.1.292 基线。终端补齐挂载点击稳定期、窗口激活/点击处置和语义输入批次刷新；新增真实 Worker、Ink 与隔离终端验收入口，完整 Mods/UI 与发布仍待闭合。见[Button 验收边界](docs/research/mods-button-295-validity-20261009.md)。

- 对齐官方 2.1.295 绘制后的 hover 重新命中、四次连续变化后的 1000ms 暂停、指针恢复、文本内部空格点击及可见 absolute 溢出命中/按轴裁剪；Button、Box 和 Text 的内部类型与 host 属性分别接线。专项验收增加静止指针、按钮移动和 resize 样式检查，完整 Mods/UI 与发布门禁继续独立结算。

- 修正 native resize 消费层把 broker 已读 tail 等同内核 write 前缀的误拒收；继续用原 Mach/write 记录重算前缀并核对原件、唯一请求窗口和后续物理帧。保留历史失败收据，新增 tail 落后正例及越界负例，不据局部回放提升完整 native 或发布结论。

- Builtin 终端验收在原 sandbox 内启动 native broker，在 ready/Popen 前固定普通屏幕起点与原始 parser 状态；按实际输出前缀和物理 marker 比较普通屏幕帧。归档重验依据同次回执读取副本，保留原 JSON/摘要且不依赖原 cache；删除守卫按实际 backend 分别校验 native 或 legacy 关闭原件；child 读取核对全部 broker 字节，并只按实际查询识别终端应答。APFS 副本保留独立 inode 与完整逻辑字节，避免为稀疏 journal 分配空槽；完整输入归属、时序与发布门禁仍单独验收。见[验收范围](docs/research/mods-builtin-native-normal-root-validity-20261009.md)。

- native 终端验收记录实际 child 的 read/readv/NOCANCEL、errno 和不可变成功前缀，补齐 PTY 别名、短读、EOF、EAGAIN/EBADF/EFAULT、容量不足与非法元数据拒收。实际 CLI 回归核对唯一 /exit 字节并输出独立读取证明；parser、消费 owner、状态与帧因果及时序门禁继续保持未覆盖。

- 修正原生终端验收消费者的bounded/full与legacy条件混用；按登记协议核对必需原件，并分开结算资源关闭、物理证据与完整覆盖，未覆盖的完整门禁继续失败。

- 修复 builtin 证据归档后原始 producer 路径与 archive 路径的校验回归：保留原始启动记录字节，以同次归档收据和 parent 登记核对映射及摘要。补充源/目录替换、缺失归档、完成标志和耦合摘要伪造的拒收回归；完整终端覆盖及发布结论仍单独验收。

- 验收有效性：resize控制器保存真实Mach send/return与caller身份；独立回放按同案时钟关联内核ACK和实际正输出帧，异步发布尾不充当执行时间。旧Native50的27通过/3失败保留，完整input owner、timing和发布仍未通过；见[请求时钟处置](docs/research/mods-native-driver-clock-validity-20261009.md)。

- Mods process.run：宿主合并信号保留首个原始取消原因（包括false/null/0/空字符串）；实际operation signal交付core，公开失败按固定官方2.1.293的HooksError语义包装。补齐独立截断标志、恰好4MiB的UTF-8边界和真实start/stop/TERM/KILL/close摘要日志；终止允许2000ms宽限并复验PID起始身份，处理helper首次失败后恢复与group TERM失败后的PID兜底；终止失败保留errno、identity查询exitCode、后代未知状态与原取消原因，避免无界结算等待及把查询失败当作退出。完整input owner、无观测时序、终端/Client发布验收仍未通过。

- 修复原生终端验收报告被旧格式拒收的问题；严格校验实际resize请求与后续绘制帧，CLI fixture在真实命令前后保存请求与返回边界，故障fixture原子发布实际EAGAIN回执，保留完整门禁未通过状态。使用方法与证据边界见[原生报告消费契约](docs/research/mods-native-report-contract-validity-20261009.md)。

- canonical 验收接入真实 native marker/write span、host launch 与 Mach geometry，严格关联当前动作窗口、DOM pane 和零输出的同 root 来源；保留合法失败 write/retry 与原 errno，resize 严格绑定发送前边界及实际 ACK/返回配对，最终认证已记录的 exact frame，原始输入文件 exclusive/no-follow 0600 创建。live、最终及归档重验一致，旧 resize RED、child input owner 和完整发布仍未闭合，见[原生 canonical 绑定](docs/research/mods-native-canonical-binding-validity-20261009.md)。

- 验收采集：原生writer批处理已排队prefix，避免重复重建已发布帧；producer退出与外层collector EOF分阶段核对，保留原关闭预算、内存上限及全量原件拒收。Native43完整30项27通过3失败，真实关闭/完整90帧与122项IO已保存；CLI/frame文件14通过1个resize失败。受控积压正例不替代真实UI或完整发布，见[发布积压与关闭验收](docs/research/mods-native-publication-close-validity-20261009.md)。

- 验收有效性：native身份/退出分别绑定实际关闭原件，拒收错误JSON类型、FIFO/链接及不完整diff子测试；新增真实CLI原件负例和关闭状态清理回归。15项完整CLI/frame文件通过；Native41 完整默认动态矩阵及原有七项追加目标共30项：27通过、3失败。完整时序、input owner和发布保持未通过。见[原生身份验收处置](docs/research/mods-native-identity-validity-20261009.md)。

- 原生验收实时前缀：默认 broker 通过有界独立 writer 发布真实 frame/IO，拒收溢出、篡改和 final 原件不一致，不新增产品 ACK。新二进制完整12项 CLI/frame文件及相关回归通过；Native40 完整30项27通过3失败，旧后端字段关联、输入owner、时序与完整发布仍未闭合。见[实时前缀验收](docs/research/mods-native-live-prefix-validity-20261009.md)。

- Workflow 等待实际 Agent 任务终态，转后台继续同一 stream；转发真实进度，取消保留原原因并隔离无关 Agent。完成、失败与停止通知绑定 task/tool ID、已测用量和输出，暂停不发送终态通知，结束 run 不重复执行或通知。详见[生命周期验收](docs/research/workflow-agent-lifecycle-validity-20261009.md)。

- native resize 验收：owned broker 在真实 `TIOCSWINSZ` 前后记录 Mach 时钟与内核尺寸；时钟跨 JSON 使用精确 uint64 十进制字符串。独立回放按 syscall prefix 应用尺寸变化，在帧输出结束点逐 cell 比较；重叠、身份/几何不符及缺失括号继续拒收。真实默认 CLI 的一次 resize/正常退出局部回放已通过，完整 native 与发布门禁继续保持未通过。

- 首次 seal 拒收：native broker 关闭时从内存原件提前固定 producer expectation，sealer只读并绑定prepare身份，禁止从当前cleanup重新生成摘要；真实first-seal复制负例拒收删input/重编号/改两份cleanup。该证明以prepare及producer原件保持独立为前提。

- IO 原件完整性：owned broker 正常关闭时固定摘要/数量/末尾 identity，并由独立expected绑定；回放要求完整连续raw覆盖，拒收裁剪、重编号与IO/cleanup耦合改写。完整几何历史、输入owner与完整验收继续保持未通过。

- 验收拒收：默认 native capture 显式绑定 backend 和 IO 初始几何，没有 native 括号的 observed resize 不允许固定尺寸回放的局部通过；缺失或不匹配的几何收据保持失败。Python broker/replay 入口禁止生成源码 bytecode，新增拒收及初始化回归；完整发布验收未通过。

- 默认终端验收采集接入 Darwin shared-slot broker：预先绑定 observer，原生执行期间用有界内存保存记录，不等待 frame ACK 或同步落盘；溢出保持失败且继续 PTY 转发，退出后保存原件及故障收尾。新增真实默认 broker 启动/退出和预存文件拒收回归；完整 geometry/input/时序与发布门禁仍未通过。

- 验收证据：将 Darwin native journal 接入实际 Ink layout/write/snapshot，私有采集模式关闭旧 FIFO ACK 和同步 frame mirror；回放重新绑定原始 packets/raw、registration 与本轮身份，拒收同时改写 output/cells 的派生数据。新增真实 CLI 固定几何逐帧及 tmux 启动超时回收；完整默认 no-ACK/resize/input/diff 生命周期和 Mods 发布门禁仍未通过。

#### Mods 焦点组合键

- 已持键 Pane 的裸 Tab、Shift+Tab、上下键和人工 Band 导航保留同插件、同 key 控件的独立槽位；自动或改写焦点保留首匹配规则。私有宿主回执区分真正接受与 withholding，避免按相同坐标误移焦点；请求被 withholding 时，改写回执也保留已获焦的原槽位。人工 Pane 跨插件导航携带实际目标 plugin，维持 person 来源，作者公开参数不增加内部字段。

- 草稿实际改变时作废挂起焦点请求并清理控件 holder；显式持键后允许非空草稿的自动首焦。跨插件同 key 按已协商的 plugin 与 element 选择真实 DOM owner，避免回执与实际按键归属分离。
- `release-check` 增加 README 测试路径检查；历史工作区未交付的夹具从当前可执行用法中分开记录，缺失路径继续拒收。

- 补齐官方 `abovePrompt:focus` 与 `abovePrompt:toggle` 默认定义和宿主操作，依次访问 Band 实际控件、可见 Pane 正文及 composer；未持键面板不再提前抢占裸 Tab，避免组合键前缀遗留导致下一次 Tab 被取消并吞掉。
- 焦点回归同时核对组合键终态、宿主快照与实际 DOM 控件，覆盖官方 diff 的 source、空 base 控件和独立 Tab 导航；验证环境启动失败与未闭合的物理帧证据单独保留，完整官方兼容及发布门禁继续执行。

#### 终端验收帧关联

- 明确区分实际输出事务与零输出逻辑观察；仅在start/end之间发生真实resize且原始输出区间为零时，比较resize前状态，然后完整回放外部变化。字符、宽字符、样式、光标、buffer、root和后续新geometry检查保留。
- 补足输入/几何/逐帧及退出收据的封存和fresh replay；未知、缺失、错案、跨运行和不完整清理继续拒收。第30轮29项中23通过、6失败，完整验收仍未通过；无需ACK的采集链仍在开发。

#### 终端 broker 生命周期

- 增加可运行的真实 PTY broker 和回归脚本，修复部分启动泄漏、恢复 TTY 失败跳过清理、waitpid 状态登记与终态回执的信号窗口；保留原始 EOF/退出事实、失败原因和逐项清理错误。
- 源缓存删除拒绝异常完成、未观察 physical EOF 或有清理错误的回执；旧格式和缺证据保持失败并保留原件。
- [有效性与用法](docs/research/mods-broker-lifecycle-validity-20261008.md)记录真实 RED、测试超时/沙箱错误处置及完整验收边界；不声称同步 ACK 时序等价或完整 Mods/UI 已通过。


- 修复内置 Mods 验收缓存含 FIFO 时归档失败；限定排除并记录真实 IPC 端点，校验源/副本 manifest，保留原报告字节。归档失败、producer 缺 EOF/reap 或删除前最终快照失配或出现新增/替换特殊端点时保留源缓存，业务及终端门禁继续独立拒收。见[归档有效性](docs/research/mods-builtin-evidence-archive-20261008.md)。
- 修复显式 nested Agent 在工具已可用时仍被跳过解析的问题；缺席/禁止时保留类型元数据，权限与深度检查继续生效。使用和同轮验收边界见[嵌套工具准入](docs/research/mods-nested-agent-availability-20261008.md)，完整发布验收仍在进行。
- 增加 Darwin 原生 syscall 输出观测与严格字节验证：包含 NOCANCEL、别名 fd、部分写入、errno 和独立 pipe/PTY EOF；采集无 ACK，不完整证据拒收，启动与故障实验不替代完整 UI/时序验收。使用方法与边界见[原生采集记录](docs/research/mods-native-write-capture-validity-20261008.md)。
- Mods终端观测绑定已提交DOM的私有身份、实际焦点与几何；保留合法plain空Button的逻辑焦点席位，缺失/隐藏/foreign控件仍拒绝。第十七轮29项27通过2失败；干净源码第十八轮29项22通过7失败，首次Tab未前进及终端收尾未通过，整体验收仍失败、同步采集时序仍不等价；实现与必验边界见[终端验收有效性](docs/research/mods-terminal-evidence-validity-20261008.md)。
- 接通 Mods Pane / PaneField 的 `Ctrl+X X` 人工关闭与自定义 `pane:close`，覆盖 Input/Select 和真实 Band consumer；关闭 hook 前释放宿主与字段焦点，阻止被否决关闭后的旧焦点请求迟到恢复。使用与验收边界见[关闭与验收记录](docs/research/mods-pane-close-and-acceptance-20261008.md)。

- 完善 code-review 空变更 Scope 的同轮原生身份、请求回执和通知核对，保存专属输入快照；最终汇总重验全部快照与证明哈希。修复 provider 收尾后 wire 空表、请求线程提前结算和合法异步时序误拒绝。
- 收紧发布验收：追加目标也必须有同次运行的有效断言；缺失或未声明的证据、仅空文件或目录不能通过。`--targets builtin-mods` 保留其他必验目标及独立 readiness，readiness 和本地生命周期使用隔离 dummy 认证。测试入口执行全部已定义的 retained 回归。
- 接通远程 prompt 编辑、补全及元素焦点，18 类客户端控制均有运行入口；对齐只读事实、UTF-16、Unicode 候选、排队/撤销、渲染焦点、控件归属、迟到 deny 和 system/ui_focus。使用方法见 README，固定官方 2.1.292 对跑与完整验收边界见[编辑与焦点专项](docs/research/mods-remote-composer-292-20261008.md)。
- 修复 Mods capability 异常 catch 对 Proxy 原型和 name getter 的执行风险，保留安全消息和原始错误身份；真实 Worker、编译故障注入与其范围见[异常边界专项](docs/research/mods-capability-error-audit-20261008.md)。
- 修复 Mods 宿主与嵌套回调的取消原因丢失：保留原始错误对象、预先取消和局部 clock 信号，继续执行撤销、进程回收及有界 stream 收尾。详见[取消与缺口复核](docs/research/mods-cancellation-audit-292-20261008.md)。
- 远程滚动：SDK `ui_scroll` 与插件 `$.ui.scroll` 共用视图位置；接通排队增量合并、只读事件信息、程序移动后的过期回执拒绝、按所属插件查找控件位置，以及 `system/ui_scroll` 与跟随末尾推送。详见[滚动专项](docs/research/mods-remote-scroll-292-20261008.md)。

- 集中完善 Mods 生命周期与作者工具、官方 2.1.292 类型与 diff、终端及部分 SDK UI、Agent/fork 和会话恢复；开放 Channels，修复 OAuth 与模型缓存隔离，增加 OpenAI Daybreak 配置，并保留 Privacy Mode。

- 新增无终端 Mods Pane 登记与 SDK 列表、显示、焦点、关闭控制；支持 system/ui_panes 状态推送，焦点请求和实际焦点分开保存，按远程 viewport 放置等待项。
- 对齐 Pane 同 ID 更新的插件归属、可选属性替换、跨插件关闭、重复关闭去重、异常恢复及标题 Unicode 校验；关闭时撤销外部绘制与 Client 地址。

- 原生验收对零写入观察新增原始 marker/全部 syscall 前缀证明和明确的 pre-layout 比较边界；实际输出事务与 resize 重叠继续拒收。专项修正官方 Button 点击后的键盘焦点前置，增加关闭位置往返；本地焦点差异及完整发布仍未通过。

### 测试覆盖

- PR #5、#6、#8、#10、#11、#13、#14、#15：每项修复都有先在修复前失败、修复后通过的回归测试；PR #8 中断言旧 Agent 权限模式行为的测试按官方 2.1.292 预期更新。
- 上述 PR 合并后，全量测试按文件隔离运行，剩余失败与合并前基线一致，未新增失败；`make release-check` 通过。
- 每个 PR 均用新构建的 binary 与合并前 binary 做 A/B 验证，交互场景（如 PR #10 的 REPL 插件重载）用脚本驱动 tmux，PR #13 等以非交互 CLI 对照为主；该验证按 PR 分别进行，不等同于完整发布门禁。
- 2026-10-14 至 2026-10-17 的直接提交除 `8153447`、`3b0a568`、`d326fc5` 外均附带定向测试，结果以各提交为准，本条目不另作完整验收结论。
- 发布构建所用 Bun 从 1.3.14 升级到 1.4.2（`packageManager` 与 release workflow），`bun install --frozen-lockfile` 在 1.4.2 下沿用现有 `bun.lock`。
- 固定 Bun 1.3.14 下按文件隔离运行全量 753 个测试文件，与 Bun 1.4.2 对照：发现并修复 1.3.14 下 Workflow 语法预检失效；基线失败中 5 个过时测试按代码与官方 2.1.292 行为更新，`workflowSpec` 随 Workflow 并发修复通过，其余失败均归因于环境（需 macOS、root 运行、容器缺 zsh 或不回收孤儿进程、4 核下的固定超时），另有 `Stats.openai` 依赖固定 100ms 等待而不稳定；Bun 1.3.14 构建的 binary 通过 `--version`、`--help`、`mcp list`、`plugin marketplace list` 冒烟。
- 发布门禁新增 Linux 实现（`docs/research/linux-release-gate-design-20261019.md`）：`scripts/linux-sandbox-exec.py` 以 user/mount/net 命名空间与 Landlock 替代 `sandbox-exec`（禁网模式另加 seccomp 拒绝 IP/packet socket 与 io_uring），执行前逐项自检越界；`scripts/native-terminal-journal-linux.c` 以 seccomp `RET_TRACE` + ptrace 采集 Bun 的裸 write 系统调用，写入与 Darwin 相同的共享槽日志并以 `LINUX_V1` 区分方法集；`mods-process-spawn`、`builtin-mods` 与两个终端 target 在 Linux 上运行，机制不可用时直接失败，retained 模式仍只支持 macOS。Darwin 的隔离与采集方式不变；`builtin-mods` 的终端证据对原生采集改用原生校验器，这一修正在两个平台同样生效（产品时序要求不变，结论仍为未通过）。Linux 原生 normal origin 记录实际 tmux 版本，Darwin 仍固定 tmux 3.6b。Linux resize 区间打开期间，追踪器扣住产品的 SIGWINCH 与新写入；已返回但追踪器尚未记下返回时间的写入完成登记后，区间才会打开，避免负载下误判写入与 resize 重叠。Linux 门禁的环境要求见 README。
- `release-validation` 四路门禁在 `97ed301` 上通过：相关测试按文件隔离在 Bun 1.4.2 下运行（694 个文件，除 DiffSidebar、processRunPsFailure 环境基线外通过；`examples/mods` 下 3 个需 Mods 测试运行器的文件运行方式不匹配、未计入；关键测试另在 Bun 1.3.14 下通过）；`make release-check` 通过；`built-claude` 两轮完整 binary 矩阵（一轮加 CPU 负载）29 个 target 全部记录，除已知缺口中的 `full_terminal_coverage` 与 `builtin-mods` 产品时序外全部通过，另有脚本驱动的 tmux 场景覆盖 Workflow 语法预检与并发、目录 marketplace、`/workflows` 会话范围、提交草稿、Stats 嵌套 Tabs 与启动期 resize；版本与文档审计通过。门禁期间修复的 Linux resize 区间、tmux 漏收 SIGCHLD、`/goal` 草稿恢复均附回归测试；三个仅在 Linux 暴露的测试改为在 Linux 上实际覆盖其契约。
- 首次推送 `v2.1.292` 后 release workflow 四个平台均在 `Verify CLI version` 失败：Mods 测试运行器对 `node:vm` 使用具名导入，打包后 `dist/cli.js` 在未开启 `--experimental-vm-modules` 的 Node 22 下链接失败；npm 未发布。改为命名空间导入，`make release-check` 增加与 CI 相同的 Node 构建、`--version`、`--help` 检查（构建到 `dist/` 下独立临时目录，不覆盖与 `make build` 共用的 `dist/cli.js`），修复前该检查失败、修复后通过。
- 移动 tag 后的第二次 release workflow 中，Linux 与 macOS 构建通过，Windows 在 `Verify CLI help` 报 `Mods Button declaration source identity changed`：仓库没有 `.gitattributes`，Windows runner 默认 `core.autocrlf=true`，检出时把 `assets/mods-2.1.292.d.ts.txt` 与 `assets/mods-button-2.1.295.json.txt` 转为 CRLF，SHA-256 与 `buttonChildrenDeclarations.ts` 中固定值不符。新增 `.gitattributes` 将 `/assets/**` 标为 `-text`；回归测试用 `git -c core.autocrlf=true cat-file --filters` 模拟该检出并比对存储内容，修复前失败、修复后通过。
- 第三次 release workflow 的 `npm whoami` 返回 401：npm 已撤销 classic token，granular token 有效期上限 90 天，不再适合长期存放在 CI。发布 job 改为 trusted publishing：job 级 `id-token: write`，发布前用 Node 24（npm 11.5.1+），删除 `NPM_TOKEN`、`_authToken` 与 `npm whoami`；`prepare-npm-package` 为主包与平台包写入指向本仓库的 `repository` 以通过 provenance 校验。`scripts/build.test.mjs` 断言上述 workflow 与包元数据，修改前失败、修改后通过；需在 npmjs.com 为 5 个包配置 GitHub Actions trusted publisher（`Esonhugh/claude-code`、`release.yml`）。

- 用量面板新增投影函数、Ink 渲染和响应头/文案三组测试，先在 HEAD 复现缺失行后通过；真实 CLI 的 `/usage` 面板与固定官方 2.1.292 对照见本次提交记录。
- 各提交在纯 HEAD 加候选补丁中通过类型检查、lint、对应测试及提交门禁。runner 的清理场景在真实子进程中连续五轮通过；相同成功/失败场景的三端 CLI 结果一致，候选清理范围更接近官方。
- 模型切换回归先在 HEAD 源码和二进制中复现；校验延迟 1.5 秒的三方对照确认候选使用新模型和 `medium` effort，其余场景没有新增差异。该受控 API 验证不代替完整 UI 或真实模型质量评估。
- 模型结果补充原有 SDK effort、fork 回执、Worker classifier 和不透明 provider 值测试；mailbox 使用真实文件及注入的解锁错误验证确认结果。被阻塞的新测试保留在工作区，未作为通过项提交。

- 在两个现有测试文件中增加 28 组环境值回归及生产阈值断言；16 组 macOS 真实 CLI 对照固定官方 2.1.292，覆盖上下限、非法值、设置回退、百分比和普通本地会话。设置／实验配置解析保持原有语义；远程 Mods 不可用提示仍与官方有差异；完整压缩引擎和 SDK 生命周期继续单独验收。
- 跳过 MCP 的 CLI 入口新增 7 项参数和环境过滤测试；37 组 macOS 真实入口对照固定官方 2.1.292，通过命令发现、初始化回执、session.start 文件标记、MCP 启动/握手/工具发现、来源优先级与托管拒绝验收。远程/CCR、故障重连及完整 UI 生命周期继续单独验收。
- 会话路径新增 9 项测试，覆盖父目录分类、ZIP、缓存刷新、损坏/越界归档和预览保留；固定官方 2.1.292 的 8 组普通 CLI、16 组 SDK 启动路径对照通过。该对照只验收命令发现、初始化回执、退出/错误输出及路径约束，不包含隐藏 CLI 选项、完整 MCP 握手或 UI 生命周期。
- SDK 启动插件新增 18 项确定性测试；19 组真实 stdio 对照覆盖初始化回执、命令可见性、MCP 发现与握手、文件输入和策略拒绝。完整 SDK 字段与远程传输不计入本项兼容结论。
- 作者诊断：7 项定向测试由失败转为通过，CLI 旧预期依据官方实测改为精确 matcher/helper 输出；隔离 `--changed` 门禁、六个相邻文件、类型、lint 与构建通过。只验收 hooks/calls 文本，不宣告全部 `plugin validate` 输出兼容。
- OSC 7501：四个定向文件 43 项通过；真实 PTY 对照包含权限、提问、完成、错误、焦点/按键、关闭开关和退出清理。后台子记录 working/title/clear 已对照，父子根时序及缺少数据源的两类 msg 不计为已通过。
- 远程 SDK 状态流：5 项定向测试、隔离提交门禁及六个官方 CLI 初始化场景通过。共享工作区仍有 Vim、声明等测试失败；隔离提交通过不等于整个工作区、完整 Mods/UI、diff、浏览器 Client 或发布通过。

- Native39 完整门禁正常收尾：30项 / 27通过 / 3失败。code-review、workflow、workflow-retry-partial-failure、workflow-failure-detail 均通过最终验收；其余失败为 builtin-mods、terminal-canonical-diff、terminal-interaction。整体仍未通过。 完整源码回归和默认验收入口通过，子测试执行数量及日志保留；共享 WIP 的私有合并回归另验，不冒充同一 binary source。原生帧关联、输入 owner、终端时序与完整 Mods 发布继续保持未通过。

- 接通 $.process.spawn 真实子进程、同步流、raw/wrapped receipt、middleware 与环境归属；正常返回保有流，超时及卸载停止自己的孩子，catch 使用新信号。新增 Worker、严格作者类型及 plugin test runner 矩阵；最终14文件746通过、7项原有skip、0失败，私有合并快照44通过。新binary在Native36通过此能力的八项CLI契约和最终原件重查；完整门禁24通过/6失败，不能宣告Mods/UI或发布通过。见[流专项](docs/research/mods-process-spawn-validity-293-20261008.md)。
- process.spawn 真实作者 CLI 入口成为必需 mods-process-spawn target；driver持有关闭摘要、binary/probe/root和全部proof map，最终必须固定唯一断言ID并重读全部原件、重新计算契约。缺target及七种最终误接收的默认入口RED保留，修复后默认回归通过。

- Native35 两批修复的准确合并source：28 collector、11真实CLI/frame、4 buffer、89 Bun及release-check通过；完整29项仍23 passed/6 failed。129帧/5owned resize与终态native/IO摘要匹配、资源清理完整，整体native/Mods/发布仍failed，见[最终处置](docs/research/mods-native-payload-closure-validity-20261008.md#native35-最终处置)。
- 原生终端证据补充真实 tcsetattr 的内核前后模式及 syscall 括号，按实际 output flags重放write/frame/resize prefix；覆盖失败errno、overflow及歧义拒收。完整 mode/input/lifecycle仍未通过，见[模式观测记录](docs/research/mods-native-termios-observation-validity-20261008.md)。
- 首封native验收另核对终态IO摘要与producer ioClose，拒绝独立重放后修改输入清单仍借旧physical通过。
- 首封native验收固定内存来源的raw/records/metadata摘要，拒绝producer与IO不变的等长write/raw/snapshot耦合篡改；解码只消费已校验bytes，最终manifest再次匹配。真实首封RED/GREEN及边界见[内容闭包记录](docs/research/mods-native-payload-closure-validity-20261008.md)。
- Native33 本批冻结候选完整默认矩阵及追加项29/29记录、23 passed/6 failed；真实diff与交互125帧、五次owned resize的有限物理回放通过，正常EOF/reap及资源清理完整。整体native/Mods/四路发布仍未通过，失败分类与原始manifest见[resize验收记录](docs/research/mods-native-resize-bracket-validity-20261008.md#native33-最终处置)。

- 关闭功能干净候选的相邻四文件 291 项通过，`make release-check` 通过；共享工作区冻结候选的相邻五文件 308 项、验收驱动回归、类型与构建检查通过。完整 29 项真实终端矩阵已执行，26 通过、3 失败，整体未通过；不能将源码结果视为完整 UI/diff 或发布通过。详见[关闭与验收记录](docs/research/mods-pane-close-and-acceptance-20261008.md)。

- 本批验收器干净候选33项、保留工作区 WIP 的提交后像40项 retained 与原有断言通过。最终封存修复后的完整私有工作区矩阵28项执行、26通过、2失败，整体未通过；[Scope 与封存复核](docs/research/release-scope-identity-validity-20261008.md)记录真实失败、制品及范围。
- 验收器六个缺口均有干净 HEAD 的失败对照，修复候选的原有断言和 25 个 retained 回归通过。完整工作区的新制品矩阵仍为 28 项执行、25 通过、3 失败，整体未通过；帧诊断不能代替完整终端验收。详见[验收有效性记录](docs/research/release-acceptance-validity-20261008.md)。
- 已完成分项回归、类型与构建检查；18 类远程控制已接通，完整 UI/diff、浏览器 Client 与发布矩阵仍须闭合；已修复此前 host callback 取消回归，验证范围见[取消专项](docs/research/mods-cancellation-audit-292-20261008.md)。当前结果见[实现审查](docs/research/mods-implementation-audit-20261007.md)，逐轮证据见 [mods-test.md](mods-test.md)。

- SDK Pane 的真实 Worker、协议类型与官方 2.1.292 / 新候选 / 完整工作区控制验收见 [Pane 控制专项](docs/research/mods-pane-controls-292-20261007.md)；未覆盖的完整 UI/diff 和其他远程控制继续分别验收。

## 2026-09-19 - Mods 分页焦点与自适应布局修复

### 版本状态

- 未发布；保持版本与依赖不变。以下修复不解除旧 Workflow timeout、PTY 退出码异常的推送门禁。

### 变更内容

- 修复 Mods 分页复用 DOM 行时旧逻辑 key 和 plugin 行坐标未注销的问题，保留同 key 其他有效节点；host snapshot 同步焦点不再反馈成新的人工导航。跨页回调返回旧窗口槽位 key 时，在确认同一 DOM 已成为新绘制的请求目标且带 autoFocus 后交接焦点，避免选中项和实际焦点错位。连续导航等待已开始的绘制完成及对应 snapshot 实际提交后再解析下一目标，无重绘时直接继续；Escape、隐藏、owner 切换和卸载释放等待，替代绘制不再受旧绘制阻塞，后续独立焦点移动不复用旧分页交接，不使用固定延时。
- Button/Select/Input 的 key 复用既有 UI 字符串长度与总量预算，不再因完整文件路径超过64字符拒绝官方 diff 绘制；保留控制字符校验和精确 key 身份。
- Select/Input 的焦点高亮随实际 focus/blur 更新，不再出现 Input 始终高亮或 Select 入焦不可见。
- Diff 使用与插件绘制一致的 body 宽度预算，并按嵌套 Code 容器的实际 Yoga 宽度约束布局，替代固定76/80列；重绘和终端 resize 更新可用宽度与滚动范围。局部布局的 metrics 回报在 commit 完成后读取 viewport，避免父 ref 尚未重挂时的空指标触发更新循环。
- Dock 正文高度按实际 viewport 回报，composer 高度改变后重新绘制插件，焦点操作不再把测量值重置为终端估算值；Pane 保留基础高度并伸展填满可用空间，支持缩小后恢复，不将高度修复等同于插件虚拟分页的尾部可达性保证。
- Mods Pane 获焦时 transcript 让出 PageUp/PageDown 等键盘滚动，保留 Pane 外滚轮与失焦后的原快捷键行为；不再由 legacy handler 提前消费 Pane 的翻页输入。文件控件被详情重绘移除后，失效焦点回到 Pane 正文，方向键滚动正文而非误入辅助控件；Tab 仍可进入控件，Input/Select 保留自身按键消费。

### 测试覆盖

- 增加真实文件 key、五行窗口延迟重绘的16文件正反分页回归，覆盖逐次和连续方向键；补充精确注销、host 焦点回声、控件高亮、109/110列切换及嵌套 padding 的红绿验证。
- 新制品的限定 scripted tmux 验收、相邻回归及未覆盖项记录在 `mods-test.md` 对应历史轮次中；历史失败保留，不以本轮局部结果声称全仓或官方完整 parity 通过。

## 2026-09-19 - Mods 输入链与 SSH 长临时路径修复

### 版本状态

- 未发布；版本与依赖保持不变，不创建 tag 或 release。以下修复不覆盖上一轮失败，也不宣称官方完整兼容或 full-covered。

### 变更内容

- Mods Pane 增加受 composer/dialog 所有权约束的人工 Tab/鼠标入焦；方向键按可见控件顺序导航，使用 middleware 最终焦点落点并串行处理连续输入，Escape 取消待处理焦点。
- Pane 的 Button action 接入既有 keybinding/chord 系统，补齐 diff 文件导航与 base 切换默认键位，保留用户重绑/解绑及 drawing 生命周期；已被 legacy handler 消费的输入不再重复激活 DOM 控件。
- 保留已有鼠标 parser 的 wheel 坐标，按实际命中 Pane body 转为相对坐标传入 ui.scroll；插件虚拟列表可自行消费滚轮，无需外层内容溢出，不抢焦或额外滚动 transcript。
- SSH control/proxy socket 使用唯一私有目录，按 UTF-8 字节预算保留 OpenSSH 临时后缀空间，过长 TMP 自动选择短临时根；清理不递归删除仍存活的 socket，失败可诊断并重试。
- SSH child close/error 的 proxy 清理异常在事件回调边界记录，避免同步逸出；显式 stop 仍保留错误与重试语义。

### 测试覆盖

- SSH 长路径、多字节、并发目录、真实本地 UDS、启动失败和清理重试取得红→绿；主线程追加 close/error 两项红→绿，相邻10文件142 pass / 0 fail。该结果不代表真实远端 SSH 集成。
- Mods 输入链的红绿、相邻回归、提交后完整自动化及新制品 scripted tmux 结果见 `mods-test.md` 第 8 节；CHANGELOG 内嵌制品，后续动态测试结果不改变已构建内容身份。
- Workflow 原5000ms超时仍未定因；一次有界诊断的目标通过，但镜像漏内嵌 CHANGELOG 导致完整前缀不合格，不把未复现当成修复。指定 settings 的官方检查在 sandbox 编译前置受阻，official 未启动，不据此判断认证或 gate；推送门禁仍保留。

## 2026-09-18 - Mods 生命周期、宿主能力与兼容性收口

### 版本状态

- 未发布；记录 Mods 实现系列及本轮 settings/Escape 修复，不代表公开包已包含这些变更，不创建 tag 或 release。
- `Makefile VERSION` 保持 `2.1.219`，`package.json` 保持 `0.0.0-dev`；测试计划和最终验收记录位于根目录 `mods-test.md`。
- 本地源码支持范围、官方完整类型通过、本地运行官方插件原件与官方 binary runtime parity 分别判定，不宣称全官方 API、全部平台或 full-covered。

### 关联提交

- `fb7b441`、`54695c3`、`1476236` — Mods 基础生命周期、tool middleware、inline 启停与研究记录。
- `3dd5536`、`2899097`、`96e68bf` — accepted settings 内容身份、managed source merge 与 hook provenance。
- `83f72ac`、`9a1f602`、`e859a75`、`ad9af61`、`24e416c`、`9f64669` — loader/Worker 契约、fs/process/store、scoped classic hooks、命令、Pane 与宿主准入。
- `eb2c146`、`d48c698`、`164e811` — managed 工具审核与 prompt/turn/command 接线、初始化期间的草稿所有权。
- `462c676`、`1f09ebb`、`bc34711` — queued admission/public turn 生命周期、Pane resize 焦点与 mode-only managed precedence。
- `446eb28`、`d421338`、`19638f5`、`6c7b0e0`、`a46ed1a` — provenance、SSH/Workflow 回归与历史兼容性证据。
- `c006eeb`、`8de982f`、`0da3f73` — 本轮 hooks snapshot 审核边界、非法 remote managed 磁盘缓存回退和 Pane Escape 所有权修复。
- `be36848`、`ef1f440` — Mods 使用与测试方案；首次 SSH bootstrap 测试同步调整，后续完整复验仍重现。
- `d9a28d1` — SSH 测试用 awaited React `act` 等待 effects/state commit，显式验证 callback 安装并保证清理；保留全部原断言，不修改生产语义。

### 变更内容

- 可信 Plugin 可声明 Function Hooks modules；采用固定源码快照、共享 Worker 和独立 activation VM，按 register、engine.create、准入、session.start barrier 发布能力。
- 增加作用域能力与 lazy continuation，保留在途 generation；技术 reload 失败保旧，refuse/disable/remove 撤旧，取消和 Worker 失效不重放宿主副作用。
- 接入 tool/prompt/turn middleware、activation-owned commands、terminal Pane、session/settings、fs/process 和 JSON store；普通模型工具继续经过 managed hooks、schema 与权限主管线。
- 排队输入保存已完成的 admission，drain 不重复运行 prompt hooks；public turn 身份与初始化输入消费、新草稿恢复分离，避免队列或 barrier 导致重复注入和草稿覆盖。
- Pane resize 保留已有焦点，禁用释放 command/UI 所有权；本轮阻止 overlay 持有键盘时 composer 记录 Escape，避免快速关闭 Pane 误开 Rewind。
- 本轮移除 hooks snapshot 更新中的隐式磁盘 cache reset，使外部 settings 候选不能绕过 ConfigChange；可信启动/worktree cwd 转换显式刷新缓存。
- 本轮在 settings 边界验证 remote managed 磁盘缓存；非法 remote 层保留诊断但不参与 precedence/merge，合法 MDM、file、HKCU 层可接替，不把 schema 重依赖引回 leaf cache。
- README 增加 Mods 加载、启停、生命周期和可信代码边界；研究报告标清历史首批范围，根目录 `mods-test.md` 记录完整测试方案及后续结果。

### 测试覆盖

- 三项产品修复均取得最小红→绿；settings 四文件相邻回归117 pass / 0 fail，UI 相邻回归25 pass / 0 fail。首轮提交后 `make release-check`、`make build` 通过，版本保持不变。
- 首轮261文件独立进程为260 qualified、1565 registered pass / 3 Peer fail、106个完成脚本；同进程 raw 为1565 pass / 4 fail / 1 error，额外SSH readiness顶层失败确实存在。Mods 子集22文件559 pass / 0 fail / 0 skip，不能与全清单重复相加。
- 后续完整复验分别暴露既有SSH ControlPath长TMP限制、短TMP runner遗漏Peer fixture授权及SSH readiness再次失败，原始记录全部保留。最终SSH测试修复在两次完整清单中均完成；两轮分别1565 pass / 3 Peer fail与1564 pass / 4 fail，第二轮新增Workflow command-runner的5000ms超时、根因未定。Peer身份环境限制保留，历史PTY异常本轮未重现，不称根因已修复。
- 新binary的官方diff原件补验中，inline Enter、详情滚动、两级Escape及fullscreen鼠标row/边缘按钮分别通过；部分方向键导航、fullscreen快捷键与滚轮失败，不能宣称终端交互完整兼容。命令/UI smoke的13条通过不替代活跃Agent/Workflow/后台任务验收。
- 当前整体未通过，推送门禁仍阻塞；完整数字与证据见 `mods-test.md`。官方2.1.272自然gate限制、remote managed编译制品公开入口限制单列；父LCOV不能覆盖Worker/VM/child/compiled。CHANGELOG参与制品内嵌，结果回填后的构建与smoke另列身份，不沿用首轮制品hash。
- 已完成的真实 `@esonhugh/claude-code@2.1.219` 上下文对比：默认首轮内容 81984→74771 bytes，减少 8.80%，主要来自工具集合/描述差异；统一 Read-only 后六次规范化请求相同。不是功能等价优化、真实 tokenizer/计费测量或新构建的结果。

## 2026-09-15 - 独立会话通信、Plan 模式开关与运行时兼容性

### 版本状态

- 未发布；本条目覆盖 `v2.1.219..d7a939c`，不修改版本号、不创建 tag，也不代表公开产物已经包含这些变更。
- 当前本地发布线和 `Makefile VERSION` 保持 `2.1.219`，`package.json` 保持 `0.0.0-dev`。
- 同机 peer messaging 已在 macOS 当前构建中完成真实双向交互验证；Linux 和 Windows 的实现与静态/构建证据不等同于三平台完整原生运行验收。

### 关联提交

- `4444348` — 捕获同步 subprocess spawn 失败并按既有无抛出契约返回结果。
- `239893b` — 增加兼容官方协议的本地独立会话发现、收发、策略、回执、UI 和生命周期实现。
- `fb79ed0` — 通过 `planModeAvailable` 设置显式控制新进入 Plan mode 的能力。
- `f156fd4` — 对齐 Linux peer registry 的 PID domain 与进程启动身份。
- `0541ae4` — 修复跨会话启动竞态、macOS socket namespace 和运行时兼容细节。
- `b999302` — 增加 Windows process-start identity，并扩展 Windows x64 binary 构建目标。
- `dadf5b8` — 为受 guard 保护的版本读取统一注入 binary build macros。
- `d7a939c` — 去除 peer ingress 中重复的安全与回复提示。

### 变更内容

#### 独立 Claude 会话通信

- 新增 `ListAgents`、`SendMessage` peer 路由、`/list-agents` 和 `/peers`，允许同一 config 范围内的独立本地 CLI 发现并按名称、`name [ref]`、session UUID 或精确 `uds:` 地址通信；本进程 Agent 和 Teams 的既有路由优先级保持不变。
- 本地消息使用 official-compatible `msgV: 1` JSON-lines wire；macOS/Linux 使用 Unix domain socket，Windows 使用 named pipe，并通过独立 key 文件中的随机 token 完成首帧认证。
- Registry 记录协议、endpoint、session、名称、cwd、PID domain 和操作系统进程启动身份；发现时过滤当前实例、过期进程、PID reuse、namespace 不匹配和不兼容协议。
- 入站策略支持 `accept`、`hold` 和 `refuse`；空闲接收可唤醒队列，忙碌时保持队列顺序，hold 消息可在策略放行后处理，会话切换和退出会结算未处理消息。
- Peer 输入在 transcript 中使用独立 sender 标签和 provenance，禁用 slash command 与 attachment 解释，并明确声明其不是用户指令或权限批准；模型可按需通过 deferred `SendMessage` 回复。
- 发送成功只确认 transport write，不宣称对方已经接受或处理；`held`、`delivered`、`refused`、`dropped` 和 `expired` 通过关联 control receipt 独立更新。
- macOS 默认 socket namespace 对齐官方 `/tmp/cc-socks`；`/list-agents` 等命令等待 messaging setup 完成后再构建，避免启动时永久缓存缺失命令。
- Linux 使用 boot ID 与 PID namespace inode 组成 PID domain，并读取 `/proc/<pid>/stat` start time；Windows 使用 `OpenProcess` / `GetProcessTimes` 获取 FILETIME identity，并在 key/registry 中与其他平台字段分开保存。
- Peer 安全与回复提示只在 queued command 转换为 API attachment 时注入一次，避免 ingress 和 normalization 两次追加相同上下文。

#### Plan 模式和运行时可靠性

- `planModeAvailable` 显式控制 `/plan`、EnterPlanMode、Plan-sensitive tool schema、mode cycle、提示和 Agent 启动参数；关闭后禁止新进入 Plan mode，但保留已存在限制的退出路径。
- 同步 subprocess spawn 失败现在转换为稳定的 `execFileNoThrow` 结果，不再绕过调用方的错误处理契约。
- Binary 构建为 feature/version guard 注入一致的 macros，避免源码构建与 standalone 产物对受保护版本读取产生不同结果。
- Binary packaging 增加 Windows x64 与 Windows x64 baseline 目标；baseline 用于不具备 AVX2 的兼容环境，不代表 Wine 或 Windows 原生交互已经完整验收。

### 测试覆盖

- Cross-session 专项 Bun tests 隔离运行 40 passed / 0 failed，覆盖 UDS listener、分帧与认证、registry/discovery、PID reuse、接收策略、队列上限、session switch、receipt、`ListAgents`、`SendMessage`、print mode、prompt normalization 和进程身份。
- 当前 `built-claude` 双终端交互通过：模型经 ToolSearch 发现 deferred `ListAgents` / `SendMessage`，按 `name [ref]` 投递，接收端使用来信 `from` 地址自主回复精确 nonce，发送端真实 enqueue/dequeue 并显示回信；两端 `/cost` 可用，退出后 socket 已清理。
- 补充受控实验确认，仅依靠 peer prompt 中的回复提示即可触发 ToolSearch → deferred `SendMessage` → 真实回程；该实验不证明模型会对所有普通 peer 消息主动回复。
- 20 个隔离 OAuth fixture 的五角色 A/B 实验完成 20/20 transcript、`/cost`、statusline 与 debug/API usage 取证；B 组 10/10 形成 transport write → enqueue → dequeue → 后续模型响应。每个五会话 cluster 的平均 input-total 增量为 1,639 tokens，未观察到可稳定归因于 peer messaging 的 cache-hit 下降；该实验未覆盖模型自主选择 `SendMessage`，自主回复由上述补充实验单独验证。
- macOS 当前 binary 的同机双向发现、投递、自主回复和清理已运行验证；Linux 完成受限的本地身份/registry 验证，Windows 完成官方制品静态分析、process identity tests 和 x64/baseline 构建，Windows 原生完整 CLI↔CLI 与 Linux onboarding 后完整链路仍标记为 not covered。
- `make build`、peer 相关 ESLint 和 `git diff --check` 通过。`bun test src` 当前为 676 passed / 36 failed / 14 errors；失败集中在全量单进程的跨文件 mock/global/env 污染。裸 `bun test` 还会扫描需要 Jest 或外部 MCP conformance harness 的 `dist/codex` tests，因此不能作为本条目的通过门禁。

## 2026-09-10 - v2.1.219 - 插件重载、按需工具与 OpenAI 可观测性

### 版本状态

- 待发布版本：`v2.1.219`；2026-09-11 第 17 轮候选工作区的四路发布门禁全部通过，相关内容随后分批提交并推送至 `master`（`b88e81a`）。尚未打 tag 或正式发布。
- 已推送候选范围为 `v2.1.218..b88e81a`，包含 teammate transcript 保留与交互修复、OpenAI 类型修复、回归测试和发布门禁改动。两份既有 `docs/design/cross-session-messaging*.md` 设计草稿未提交，不属于本次发布内容。
- `Makefile VERSION` 与 README 本地发布线更新为 `2.1.219`；`package.json` 保持 `0.0.0-dev`。

### 关联提交

- `2ed520d`、`d5f1b98` — 插件更新后完整重载当前会话及设计说明。
- `cca3bfb`、`12a473d`、`fdd93e6`、`f796b86` — Workflow/Terminal 按需工具定义、上下文统计与 OpenAI 工具发现。
- `389a4e3`、`591087e`、`0f1febc`、`3d0525f` — 通用工具策略、单一 Workflow opt-in 设置与文档。
- `1192b1b` — `/stats` 增加 OpenAI 活动页。
- `30f754a` — 被查看 Agent 的活动显示独立于 coordinator。
- `cfe837c` — 记录 OpenAI 压缩 checkpoint 元数据。
- `59cda8d` — 统一 OpenAI instructions 序列化。
- `3dc228b`、`3c765fe`、`203131f` — 请求 wire prefix 诊断、跨 client 保留有界基线与回归测试。
- `99b9e4d` — OpenAI adapter 默认映射模型更新为 `gpt-5.6-luna`。
- `0833ba6` — OpenAI instructions 类型修复与 compact 调用契约测试。
- `2fca12e` — teammate transcript 宽限期、查看入口与导航按键隔离，以及会话插件重载回归测试。
- `c71f197`、`20115c2` — Usage 测试 mock 隔离与 Workflow fixture 显式启用配置。
- `d539543` — 确定性 binary 交互发布门禁与驱动回归测试。
- `b88e81a` — `v2.1.219` 版本配置与发布说明。

### 变更内容

- 插件 Update now 后的 `/reload-plugins` 完整应用安装版本、commands/skills 删除与替换，以及插件 MCP 重新发现；保留无关 MCP，重载不负责下载升级。
- ToolSearch 生效时按需提供 Terminal 和已启用的 Workflow schema；Workflow 使用 `enableWorkflows: true` 显式启用，上下文统计包含完整工具定义和已发现工具。
- OpenAI 工具搜索结果保留发现的工具名称；默认主提示集中提供通用工具与 Git 授权策略，精简 Bash schema 提示。具体行为及既有验证边界见下方 2026-09-08 条目。
- `/stats` 新增按需请求的 OpenAI 活动统计页，支持 `r` 刷新；本地统计加载、为空或失败时不阻塞页签切换。
- 被查看 Agent 的工具运行标识、loading 状态与本地 Agent spinner 使用自身状态，避免混入 coordinator 活动。
- 已查看的终态 teammate 在退出或切换后沿用 30 秒 panel 宽限期，期间允许重新打开已有 transcript；重新打开暂停回收，退出后重新计时，由既有 task GC 回收。Idle teammate 仍为 running，不按终态清理；未查看即结束或已回收的任务不在此重新打开保证内。
- OpenAI compact boundary 记录 provider、压缩前后 token、压缩调用 token 与可用的 compaction response ID。
- 普通与压缩请求统一 instructions 序列化，避免相同 system blocks 因拼接差异改变请求前缀。
- debug wire 诊断使用进程内摘要记录 instructions/tools/input 大小及公共前缀，按 thread/cache scope 与 create/compact 隔离，跨 client 保留最多 100 份基线；诊断不记录请求正文，也不证明服务端缓存命中。
- Anthropic 模型名称在 OpenAI adapter 中默认映射为 `gpt-5.6-luna`；显式 OpenAI 模型名称不变，实际可用性取决于服务端。

### 测试覆盖

- 第 17 轮候选工作区验证通过：相关 feature tests 为 146 passed / 0 failed，发布 driver 自测通过；`make release-check` 的版本、TypeScript、ESLint、imports/assets 与 diff 检查通过；`make build` 后的 scripted tmux binary gate 为 16/16 passed；release/docs 审计通过。
- 上述结果对应提交前的 `99b9e4d` 加第 17 轮基线记录的工作区改动，而非裸 `99b9e4d`；这些内容随后提交至 `b88e81a`。本次验收状态文案修订发生在该轮之后，不将该轮结果宣称为修订后 HEAD 的新一轮完整门禁。
- 新增 wire 回归断言覆盖 diagnostics disabled、跨 client 基线、create/compact 与 thread 隔离、有界淘汰及日志不含请求正文。
- 发布 driver 增补 coordinator/transcript 生命周期、插件重载、工具按需发现、OpenAI Stats、默认模型映射、wire diagnostics 与 checkpoint 元数据的交互场景及正反自测；这些场景已在第 17 轮真实 binary 门禁中通过。Workflow failure 与 partial retry 同时验证受控故障注入；自测和 binary 交互分别取证，不互相替代。
- 新场景使用隔离 dummy 认证、localhost Responses/MCP 和本地 marketplace；Stats 使用仅对子进程生效的测试 CA 与隔离 HTTPS fixture。验证范围不包含真实 OpenAI 服务可用性、模型自然调度成功率或远端 marketplace 下载。

## 2026-09-08 - 插件重载、工具按需加载与提示词精简

### 版本状态

- 未发布；本条目记录 master 的源码更新，不修改版本号、不创建 tag，也不代表公开包已包含这些变更。
- 当前本地发布线和 `Makefile VERSION` 保持 `2.1.218`，`package.json` 保持 `0.0.0-dev`。

### 关联提交

- `2ed520d` — 插件更新后的会话重载完整应用安装状态、commands/skills 与插件 MCP 连接。
- `d5f1b98` — 补充交互式插件更新与重载的设计、验证范围和限制。
- `cca3bfb` — Workflow 工具改为显式启用并延迟加载 schema。
- `12a473d` — Terminal 工具 schema 延迟到发现后加载。
- `fdd93e6` — 上下文统计包含完整工具定义，并区分已发现与未加载工具。
- `f796b86` — 在 OpenAI 搜索结果转换中保留已发现工具名称。
- `389a4e3` — 集中通用工具策略并精简 Bash 指引，补充专项测试。
- `591087e` — 统一使用 `enableWorkflows` 作为 Workflow opt-in 设置。

### 变更内容

- `/plugin manage` 的 Update now 更新安装缓存和记录后，通过 `/reload-plugins` 将已安装版本应用到当前会话；重载不承担 marketplace 升级或重新下载。
- 插件重载清除安装快照并完整替换 commands 与独立 skills，包括删除项与空集合；已安装的本地 marketplace 插件使用安装缓存版本，不绕过 update 读取已修改的 source。
- 显式插件重载在配置未变化时也清理插件 MCP 旧连接，再重新发现；不强制重启无关 MCP，清缓存也不会为了清理而启动未连接服务器。
- 重载摘要分别统计 commands 和 skills；MCP/LSP 数量表示配置数量，不表示异步服务已就绪。设计与验证边界见 [插件 marketplace 架构说明](docs/architecture/plugin-marketplace.md)。
- Terminal 和已启用的 Workflow 工具在 ToolSearch 生效时按需提供 schema；ToolSearch 未启用时仍可直接提供完整定义，不将 deferred 标记视为无条件隐藏。
- Workflow 使用 `enableWorkflows: true` 显式启用；功能未启用时不能通过 ToolSearch 将其加载。
- 上下文分析按工具名称、描述和输入 schema 估算工具开销，并将已发现的 deferred 工具计入加载部分；compact boundary 保留的发现记录继续参与统计。
- OpenAI Responses adapter 将 `tool_reference` 转为 `Tool available: <name>` 文本，避免搜索结果变为空字符串；完整 schema 仍由请求的 tools 数组提供，混合图片结果保持图片转换行为。
- Bash 工具说明移除 Git/PR 教程；默认主提示保留简短的 Git 操作授权及 hooks/signing 要求，专用工具优先与独立调用并行策略统一由主提示提供。
- Bash 保留 description 参数，删除长示例和用词禁令；创建文件前的 ls 检查仅要求用于尚未检查的目录，允许合理使用 cd 和多行脚本。
- 自定义 system prompt 替换默认主提示的调用方，需要自行提供从 Bash schema 移出的通用策略；本次不改变 Bash 执行器或权限检查。

### 测试覆盖

- 插件重载回归测试覆盖安装快照失效、commands/skills 替换与清空、数量统计、插件 MCP 能力移除和非插件保留，以及真实 install/update 的安装缓存版本选择。
- 已有 scripted tmux 验证在同一 CLI 进程中通过 Update now 和 `/reload-plugins` 检查同名 command/skill 更新、command 新增/删除、插件 MCP 新工具调用及非插件连接保留；模型使用受控 localhost fixture，不代表真实模型服务验收。远端 marketplace 下载、skill 新增/删除、hooks/LSP 完整生命周期、连续 reload 和恰好一次重连未包含在该交互结论中。
- Bash/主提示专项测试覆盖策略归属、Git 指令开关、description schema、条件化目录检查及 cd/多行指引，连续三轮均为 10 tests、64 assertions 通过。
- OpenAI adapter 回归测试先复现工具引用丢失，再验证普通和混合图片结果；工具发现、上下文分析与 adapter 相关测试通过。
- Anthropic-compatible 与 OpenAI 路径完成 ToolSearch → CronList → 再次调用的非交互和 scripted tmux 闭环；不据此声称 auto 阈值或自然语言发现率已验证。
- 合并基础配置与 provider 配置后，Bash 专项 Anthropic-compatible 重跑完成三次交互和两次非交互样本，另一次非交互超时停止；场景包含显式行为指令，不作为自然触发率或完整通过率的证明。
- 请求级 token A/B 仅包含 Bash 工具和固定输入，两个 provider 各三对请求均净减少 774 input tokens，已计入新增 Git 主提示开销；这是受控最小请求的 API usage 差值，不是完整 CLI 上下文下降比例，也不是原生 Claude tokenizer 的测量。

## 2026-09-02 - v2.1.218 - OpenAI 压缩、Goal/Hook、Trust 与 SSH 可靠性

### 版本状态

- 准备发布版本：`v2.1.218`。
- 本次发布覆盖 `v2.1.217..HEAD`，包括 OpenAI 压缩、Fast mode 与图像输入、Goal 与 Hook 生命周期、TrustDialog 风险提示、SSH 部署和 release gate 改动。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.218`。

### 关联提交

- `82999e8` — 在重复 OpenAI remote compaction 时保留上一轮 opaque compaction item。
- `7745df6` — 为手动 OpenAI compaction 创建独立 turn scope。
- `beffbf0` — 为连续阻止结束的 Stop hook 增加有界续跑与状态重置。
- `8a1f775` — 增加可持久化、可恢复的 Goal 状态与专用 Stop hook 生命周期。
- `3837ccb` — 增加交互式 `/goal` 状态查看、设置和清除流程。
- `ad16ce7` — 在 subagent query 提前失败时补跑 SubagentStop hooks。
- `850e6ce` — 为 OpenAI provider 增加 Fast mode priority 请求路径。
- `984d98b` — 更新 OpenAI Fast、Goal 生命周期与 Hook 可靠性的发布文档。
- `07d92b4` — 准备 `v2.1.218` 并扩充按变更路径选择 binary target 的 release gate。
- `e78a2bd` — 安全恢复 Goal 状态、会话 cost state 与 token baseline。
- `b143a06` — 保留 session hook 的 source、matcher、callback 与原始 hook identity。
- `3ea518f` — 完整处理 subagent 异常退出时的 SubagentStop fallback。
- `ab04807` — 在 workspace trust 对话框展示项目预授权权限和附加目录。
- `8a2e2df` — 为 SSH binary 上传复用 ControlMaster 连接。
- `06d5552` — 禁止模型通过 Skill tool 调用非交互式 Goal command。
- `555e7a3` — 在 Goal 状态视图中区分 active 状态。
- `b1a6437` — 将 SSH 部署块增大到 16 MiB，减少分块传输开销。
- `561022a` — 对齐 Goal resume 的 fresh metrics epoch 和内联生命周期提示。
- `7b1ecb8` — 为 ClearGoal tool 显示调用与结果消息。
- `42134af` — 修复 ClearGoal 结果消息未使用 Ink `Text` 渲染导致的交互式崩溃。
- `ca93894` — 补充 `v2.1.218` 的 release notes 与验证范围。
- `76ef725` — 补全 `v2.1.218` 的关联提交列表。
- `0571998` — 为 OpenAI Responses 转换用户与 Read tool 的图像输入。
- `8ae57b4` — 在构建中显式提供 bundled image processor fallback。
- `6da88a0` — 将 OpenAI 图像输入和 bundled fallback 纳入 `v2.1.218` 发布说明。
- `da1eb01` — 更新 embedded image runtime 与 scripted tmux 验证说明。
- `ee3bb5d` — 为 standalone binary 嵌入目标平台的 sharp/libvips runtime。
- `83b3d6a` — 为发布产物增加 bundled image runtime 门禁。

### 变更内容

#### OpenAI compaction

- OpenAI provider 下手动 `/compact` 即使不在 query turn 内也会创建稳定的 session、thread、turn 与 prompt cache scope，并继续使用 remote compaction 路径。
- 连续执行 remote compaction 时，后续请求会保留上一轮 opaque compaction item；压缩后继续对话也会携带该 item，避免早期会话上下文在重复压缩后丢失。

#### OpenAI Fast mode 与图像输入

- OpenAI API key 与 ChatGPT OAuth 用户现在可以使用 `/fast`；OpenAI model 不再受 Anthropic Opus 4.6 eligibility 限制，设置页、Model Picker 和 Fast mode 对话框使用 provider 对应的说明。
- OpenAI Responses 请求将 Fast mode 映射为 `service_tier: "priority"`，不发送内部 `speed` 字段；priority tier 不受支持时直接保留服务端错误，不启用 Anthropic 专属的 beta header、状态预取或自动降级路径。
- OpenAI API key 与 ChatGPT OAuth 会话现在会将用户图像和 Read tool 图像结果转换为 Responses `input_image`；独立 CLI 产物按目标平台嵌入并按需加载 sharp/libvips runtime，在原生 image processor 不可用时仍可缩放超限图像。

#### Goal 状态与恢复

- 交互式 `/goal` 无参数时打开状态视图，展示未设置、进行中、已完成或失败状态，以及耗时、turn、token 和最后检查原因；`/goal <condition>` 与 `/goal clear` 分别设置和清除 Goal，非交互式调用继续使用原有 prompt command。
- Goal 状态通过 `goal_status` attachment 持久化到 transcript；resume/continue 会恢复 active Goal 及其 source-scoped Stop hook，本地 transcript resume 会从当前时间、0 turn 和当前累计输出 token 创建新的 metrics epoch，避免把上一段会话的耗时、迭代和 token 计入 resumed Goal。
- Goal 判定为未完成时显示 `Goal not yet met… continuing` 并继续工作；完成、impossible 或 clear 时显示对应终态及 metrics。持久化 sentinel 不重复渲染，也不占用可见消息预算。
- Goal 状态视图使用独立 active 标识；ClearGoal tool 显示 `Clear active goal` 调用消息及 `Goal cleared`/`No goal set` 结果。
- 仍有后台任务运行时只延后 Goal 判定，不跳过普通 Stop hooks；Hooks 被策略限制或交互式 workspace 未信任时拒绝启动 Goal，Agent subagent 也不能通过 Skill、SetGoal 或 ClearGoal 修改主会话 Goal。

#### Prompt、Stop 与 SubagentStop hooks

- 普通 prompt hook 返回 `ok:false` 时默认阻止当前 turn，`continueOnBlock:true` 可继续；Stop/SubagentStop evaluator 返回 `ok:false` 时将 reason 注入 transcript 并继续 query，只有 Stop-class hook 的 `impossible:true` 会产生 terminal failure。
- Prompt evaluator 禁用 tools；API error 保持非阻塞。Command hook 的 exit code 2 优先于 stdout JSON，session hook 结果按 source、matcher 和原始 hook index 关联，避免 wildcard、并发完成顺序或 stale callback 串线。
- Stop hook 默认在第 9 次连续阻止结束后终止续跑并显示 warning；`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调整上限，`0` 或负数可禁用该上限，`maxTurns` 仍具有更高优先级，正常 tool round 会重置连续计数。
- Subagent query 在到达正常 hook 边界前异常退出时补跑一次 SubagentStop hooks，并保留完整 conversation、有效 permission mode、默认 timeout 和 blocking feedback；已经产生 SubagentStop progress/result 或正常完成时不会重复执行。

#### Workspace trust 与 SSH 部署

- TrustDialog 在接受 workspace 前展示项目配置预授权的 tool permissions 与 additional directories；按影响排序并清理 ANSI、控制字符和 bidi 字符，disabled 或 managed-policy 排除的来源不会进入提示。
- SSH binary 部署复用带 `ControlPersist` 的 ControlMaster，使用 16 MiB 分块降低重复握手和传输开销，同时保留逐块 checksum、重试、整文件 SHA-256 校验和原子安装。

### 测试覆盖

- OpenAI 测试覆盖 standalone turn scope、手动与连续 compaction、opaque item replay、`/fast` availability、provider eligibility、Anthropic 状态预取隔离、priority wire mapping、不支持 priority 时的错误传播，以及用户/Read tool 图像到 `input_image` 的 API key 与 ChatGPT OAuth wire 转换。
- 构建测试覆盖 image processor fallback、按目标选择和延迟加载 embedded sharp runtime、普通源码 build 隔离及 glibc/musl 依赖安装；FileReadTool 测试覆盖 PNG、JPEG、GIF 和 WebP 图像读取。
- Scripted tmux 图像门禁在当前 `built-claude` 中执行 2100×1 PNG 的 Read 流程，断言实际缩放为 2000×1，并验证单次稳定 call ID 的 OpenAI Responses `function_call_output`/`input_image` wire、prompt recovery 与进程清理。
- Goal 与 hook 测试覆盖交互式状态视图、attachment/sentinel、fresh resume metrics epoch、内联生命周期提示、success/block/impossible、后台任务延迟、command exit 2、callback identity、策略限制、长 transcript 重试和连续 block cap。
- Agent 测试覆盖 query 异常退出后的 SubagentStop fallback、完整 conversation、permission mode、blocking feedback、sidechain 记录及 exactly-once 边界。
- TrustDialog、SSH 与 ClearGoal 测试覆盖 permission/directory 风险摘要与清理、managed source 过滤、ControlMaster、16 MiB chunk、Goal 清理状态和 tool 消息。
- Scripted tmux 对照覆盖本地与官方 Goal 生命周期提示、完成 transcript replay 去重、active Goal resume fresh epoch、启动、dispatch 和 prompt recovery。
- 发布门禁运行 changelog schema/tests、TypeScript、ESLint、missing-import audit、`git diff --check`、聚焦 Bun tests 和当前源码 binary build。

## 2026-08-31 - OpenAI 手动与重复压缩修复

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.217`。
- 本条目覆盖 CHANGELOG 上次更新提交 `bdb25bd` 之后、2026-08-31 的 2 个提交。

### 关联提交

- `82999e8` — 在重复 OpenAI remote compaction 时保留上一轮 opaque compaction item。
- `7745df6` — 为手动 OpenAI compaction 创建独立 turn scope。

### 变更内容

#### OpenAI compaction

- OpenAI provider 下手动 `/compact` 即使不在 query turn 内也会创建稳定的 session、thread、turn 与 prompt cache scope，并继续使用 remote compaction 路径。
- 连续执行 remote compaction 时，后续请求会把上一轮 opaque compaction item 放在新输入之前；压缩后继续对话也会携带该 item，避免早期会话上下文在重复压缩后丢失。

### 测试覆盖

- OpenAI compatibility 测试覆盖 standalone turn scope、手动 compaction、连续两次 compaction 的输入顺序，以及压缩后继续对话时 opaque item 的保留。

## 2026-08-30 - v2.1.217 - OpenAI 会话路由与 GitHub Native 更新

### 版本状态

- 准备发布版本：`v2.1.217`。
- 本次发布覆盖 `v2.1.214..HEAD` 的 OpenAI Responses 会话路由、WebSocket/SSE 回退、Remote Compaction V2、Agent 委派提示及 GitHub Release native installer/update 改动。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.217`。

### 关联提交

- `fa385be` — 对齐 OpenAI Responses 的 session/thread/turn identity、prompt cache usage、WebSocket fallback 与 remote compaction，并减少重复 Agent 委派。
- `45c80d4` — 将 native install/update 迁移到经过 SHA-256 校验的 GitHub Release assets，并增加 Linux musl 构建。

### 变更内容

#### OpenAI Responses 会话与压缩

- OpenAI 请求按根 session 保持稳定 `prompt_cache_key`，区分 session、thread、turn 与每次 transport dispatch 的 request ID，并以 first-wins 方式保存 `x-codex-turn-state`。
- ChatGPT Responses transport 支持 WebSocket 优先及输出前 SSE 回退；输出开始后不重放请求，caller abort 不触发回退。
- OpenAI Remote Compaction V2 使用 opaque compaction item 持久化 compact boundary，并复用既有 hook、attachment、usage 和本地 fallback 生命周期。
- Agent 创建提示要求先检查是否确有必要委派，避免重复 Agent、重复上下文传递和无效迭代。

#### Native 安装与更新

- Native installer 和 `claude update` 从 GitHub Releases 查询版本、下载平台二进制，并使用同一 release 的 `SHA256SUMS.txt` 验证内容后再原子安装。
- Release workflow 新增 `linux-x64-musl` 与 `linux-arm64-musl` 构建，并在 Alpine 容器中执行验证，避免在缺少 musl loader 的 glibc runner 上产生伪失败。
- Native 自动更新与 Doctor 使用 GitHub latest release；实际版本二进制保存在 XDG data 目录，用户入口 symlink 指向当前版本。

### 测试覆盖

- OpenAI adapter 覆盖 request identity、cache usage、turn state、WebSocket fallback/abort、Remote Compaction 协议和 opaque replay。
- Native installer 覆盖 GitHub latest tag、release URL、checksum 精确匹配、二进制内容以及 native update 的 updated/already-current 状态。
- 发布前通过相关 Bun 测试、build packaging test、ripgrep tests、TypeScript、ESLint、missing-import audit 与 `git diff --check`。

## 2026-08-27 - v2.1.214 - Prompt 缓存稳定性、Effort 透传与 SSH 状态恢复

### 版本状态

- 准备发布版本：`v2.1.214`。
- 本次发布完整覆盖 `v2.1.213..HEAD` 的 21 个提交：20 个非 merge 功能、修复、测试与文档提交，以及 1 个整合 OpenAI/Skill prompt cache 修复的 merge commit；其中包括 first-party bootstrap 修复、对应测试与 release driver 调整。未跟踪的 `test-gate-bugs.md` 仅为内部 handoff，不属于发布内容。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.214`。

### 关联提交

- `818ceea` — 为模型发现缓存加入 provider/endpoint cache key，并在 provider 或 endpoint 切换时清理陈旧 Model Picker 选项；后续提交补齐 credential/account identity、endpoint 规范化与有效空列表语义。
- `b619ea1` — 按稳定核心、能力与任务动态层组织 system prompt，收敛 mode guidance，并加入可重复的 prompt cost 分析工具和测试。
- `2fd778f` — 在 custom system prompt 路径保留 proactive guidance，并修正对应 prompt 分析证据。
- `e918003` — 记录 prompt 分层候选与基线的隔离多轮 A/B 结果和证据边界。
- `3ee190c` — 补充 A/B scorer blind spots，收窄 permission、task 与 TMPDIR 结论。
- `25b0768` — 为 OpenAI Responses 请求发送稳定 session routing key，并将 cache usage 转换为 Anthropic-compatible additive buckets。
- `fbe0740` — 在生成 Skill listing prompt 前按 name 排序，避免 discovery order 破坏跨进程 cache prefix。
- `9bb1cb9` — 删除 provider-specific effort remapping，让 configured effort 原样进入 API，并贯通 `minimal` 配置档位。
- `cb00522` — 合并 OpenAI prompt cache reuse 与 Skill listing cache prefix 修复，同时保留本地 effort 透传改动。
- `65e9d88` — 允许 update-config 将不可直接表示的 Zod input 类型生成为 JSON Schema，并增加 bundled skill 回归断言。
- `b3a43ed` — 保留 OpenAI Responses reasoning summary/raw text，并将其转换为 Claude thinking blocks；补充相关 streaming 与非 streaming 回归覆盖。
- `fd4452f` — 记录官方 changelog migration candidates，明确本地 release 范围与上游迁移审计边界。
- `d961be2` — 允许 Agent 清除主会话已完成或不再适用的 active Goal，并保持主线程 Goal lifecycle 一致。
- `13ee2d4` — 同步 SSH remote 的 Goal、task、stream、tool 与 permission lifecycle，并在断线和会话替换时清理 stale runtime state。
- `4f6e02b` — 保留模型发现返回的 capability 状态，并修正 identity-aware cache 在有效空列表与失败响应下的更新语义。
- `1c739ef` — 加固 release binary driver 的 target coverage、evidence ownership、manifest 与 cleanup 验证。
- `96ad024` — 持续转发 SSH remote response text，并补齐 stream completion 与状态清理回归覆盖。
- `a79960d` — 保留 OpenAI caller metadata headers、处理无 trailing newline 的 SSE 终态，并在 SSH session 结束或断开时清理 permission state。
- `e96f037` — 加固 release validation 的 bootstrap、lease、manifest、SSH lifecycle 与 launcher 回归契约。

### 变更内容

#### Prompt 分层、模式指引与缓存边界

- system prompt 明确分为 `stable-core`、`capability` 和 `task-dynamic` 三层，稳定内容位于全局 cache boundary 之前，session-specific scratchpad 等动态内容保持在边界之后；重复 section 会去重，冲突 owner 必须显式 override。
- Plan mode 继续限制只读操作和 plan file 例外；与 Auto mode 同时启用时，Auto 只负责 Plan 已允许操作的 permission classification，不再产生可执行实现的冲突指引。
- proactive mode 不再暗示未经授权的 commit、push 或 PR；custom system prompt 在非 coordinator 会话中继续获得已启用的 proactive guidance。
- scratchpad 指引区分跨 tool call 的 session artifact 与 Bash 命令内 `$TMPDIR`，并提供 prompt dump 成本分析脚本、分层回归测试及限定结论的 A/B 评估文档。

#### 模型发现与 Prompt cache

- 模型发现缓存绑定当前 provider、ChatGPT/API 身份、gateway credential 与规范化 endpoint；发现启用时 Model Picker 只读取 identity 匹配的缓存：成功发现的非空结果替代对应 provider 的基础列表，成功但为空的结果会清空该 identity 的旧列表且不恢复 provider 基础列表，显式 current/custom model 仍可显示；切换 provider、账户、credential 或 gateway 后也不会混入上一配置的模型。模型发现关闭时，first-party bootstrap 返回的无 identity 附加模型仍按既有行为显示。
- OpenAI Responses 请求使用 session ID 填充 `prompt_cache_key`、`session-id`、`thread-id` 和 `x-client-request-id`，为同一会话后续 turn 提供稳定 routing/cache keys，支持服务端复用；caller `defaultHeaders` 中的普通 metadata header 会保留，而认证、content type 和 session routing headers 仍由 client 控制。
- OpenAI cached/write token usage 转换为 Anthropic additive usage buckets 时扣除已包含在 `input_tokens` 中的缓存 token，避免输入用量重复计算；兼容 OpenAI 与既有 Anthropic-style usage 字段；Responses reasoning summary/raw text 同时转换为 Claude thinking block，保留 streaming 与非 streaming 的可见推理内容；`response.incomplete`、`response.failed` 和 `error` 事件会保留服务端原因并作为请求错误传播，SSE 在 EOF 前没有 trailing newline 时也会处理最后一条完整事件。
- Skill listing 在格式化前稳定排序，避免不同进程中的 discovery order 改变 prompt prefix 并使 Anthropic cache 失效。
- 显式设置 `USE_LOCAL_OAUTH` 时，external build 也可使用配置的 local OAuth endpoint；未设置时继续使用 production OAuth，staging endpoint 仍仅限内部构建。

#### SSH remote 状态恢复

- SSH bootstrap replay 会将最后一个 Goal 状态恢复到本地 AppState；remote task start/progress/stop、streamed response text、response length 和 active tool ID 同步到 REPL，history replay 与 live echo 继续按 UUID 去重。
- remote terminal result、异常 SSH process exit 和显式 disconnect 会清理该 SSH session 拥有的 permission prompt、streaming tool、in-progress tool 与 background task state，避免断线后保留不可响应的 UI 状态。

#### Release validation driver

- release baseline 绑定 HEAD、完整 staged/unstaged/untracked/ignored 内容 identity 与本轮 binary metadata；binary driver 根据 committed release range 和工作树路径自动推导 mandatory feature targets，并使用隔离 dummy OpenAI endpoint 验证 effort wire、reasoning-to-thinking、模型发现空/非空状态、update-config skill 和 prompt mode cache prefix；first-party bootstrap target 必须实际命中隔离 endpoint、持久化 unkeyed cache 并由 Model Picker 消费，OpenAI error/usage 转换由 API 回归测试覆盖。
- binary driver 使用 resolved repository identity 的跨进程 lease 避免并发 gate 竞争，并在 final manifest 明确记录 normal/interrupted lifecycle 和矩阵完整性；SSH 变更会强制 isolated fake transport 的 built-binary lifecycle target。driver regression 与 scripted tmux gate 明确区分 spec、unit、fault injection 和 binary evidence；受控 workflow transient fault、稳定 Task/Run/Agent ID、terminal marker、通知、进程清理及 Git/workflow artifact 副作用任一缺失时均 fail closed；`/code-review` Scope agent 仅读取 diff stat、changed-file list 和相关 `CLAUDE.md` 等 bounded metadata，不读取完整 patch 或 changed source。

#### Effort 与 update-config

- `/effort`、Model Picker、settings Zod schema、SDK control/core schema、Agent definition 和 API adapter 新增 `minimal`；OpenAI 可选列表同时保留 `none`、`xhigh`、`max` 与 `ultra`，并向 Model Picker 和 SDK 声明 effort capability。
- configured effort 不再按 Anthropic/OpenAI provider 重写：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 和 `ultra` 均原样传入所选 API；本地编排模式 `ultracode` 仍展开为 API `xhigh`。
- bundled `update-config` skill 以 input schema 生成完整 Settings JSON Schema，并将 Zod 无法直接表示的 input 类型降为 JSON Schema `any`，避免 schema 生成阶段抛错而使 skill 不可用。

### 测试覆盖

- Prompt 专用测试覆盖 layer ordering、cache boundary、重复/冲突 section、Plan + Auto scope、scratchpad、custom/proactive system prompt、Bash/TaskCreate guidance，以及 prompt dump 分析器的稳定输出。
- API 与配置回归测试覆盖模型发现 cache identity、OpenAI request body/headers、同步与 streaming cache usage、reasoning-to-thinking 转换、Skill listing 顺序、configured effort 透传、`minimal` 的 CLI/settings/SDK/Agent schema 接受路径，以及 update-config schema JSON 生成；模型发现测试使用隔离 HOME 时不再依赖环境中预设的 custom model。
- 完整发布门禁要求同一源码状态下通过相关 `bun test`、`make release-check`、本轮 `make build` 后的 scripted tmux binary 交互矩阵和 release/docs audit；最终验收结果由本版本发布验证报告记录。

## 2026-08-22 - v2.1.213 - SSH 交互完整性、Prompt 精简与 Gateway 模型发现

### 版本状态

- 准备发布版本：`v2.1.213`。
- 本次发布的功能范围为 `v2.1.212` 之后、发布准备提交之前的 16 个功能与文档提交（`782826d..c080f70`）；发布元数据提交不计入功能提交数。范围包含 SSH local/remote 状态同步与路径交互修复、prompt context 精简，以及 OpenAI/Anthropic gateway 模型发现。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.213`。

### 关联提交

- `782826d` — 将 SSH settings 与认证保留在本地主机，并由 host-managed auth proxy 向远端提供最小接口。
- `082d331` — 同步 remote-owned history replay、消息 UUID、隐藏消息和 file-suggestion control lifecycle。
- `5b13424` — 补齐 SSH 远端目录、文件与 fuzzy suggestions 的连续路径补全。
- `b52f9a2` — 完成 managed SSH shell、history、Agent/工具显示、权限与路径交互，并精简主会话、Bash、Explore 和 Plan prompt。
- `2c860b4` — 通过 SSH control request 同步 permission mode、永久规则和取消状态。
- `a56a673` — 延长 managed SSH bootstrap timeout，允许较慢远端认证完成。
- `1b50a42` — 在远端验证 managed SSH workspace directory，避免本机路径判断污染远端行为。
- `6825bd9` — 保留 cold SSH file index build，并在当前 query 有效时有界刷新。
- `4248001` — 正确解码不完整 quoted path mention，覆盖空格和特殊字符路径。
- `b137c65` — 记录 prompt context 优化的设计、测量方法和边界。
- `df67d92` — 默认通过 attachment 暴露 Agent listing，减少基础 prompt 常驻内容。
- `0cae893` — 压缩 deferred tool namespace 指引，保留按需发现契约。
- `e742b05` — 精简 Agent orchestration guidance，删除重复说明。
- `1941b48` — 记录 prompt context 精简结果与剩余风险。
- `3133565` — 保持 deferred app namespace 相互独立，避免同名工具集合覆盖。
- `c080f70` — 增加统一模型发现入口、共享 Model Picker 缓存及 OpenAI/Anthropic gateway 回归测试。

### 变更内容

#### SSH 交互与执行边界

- SSH 本地 TUI 只负责 transport、认证 proxy 和权限交互；tools、skills、plugins、Agent、hooks、MCP、文件索引和 transcript 保持由 managed remote child 执行，避免加载本机项目上下文。
- `--settings`、`--setting-sources`、provider/upstream、Auth helper、custom headers、client certificate/key 和网络代理配置留在本地；原始配置、路径与 secret 不进入远端 argv/environment，远端 settings 也不能覆盖 host-managed provider/Auth/session 标记。
- permission mode、永久 permission rules、interrupt/cancel acknowledgement 和 replayed response 通过 control protocol 同步；失败或乱序响应不会错误提交本地状态。
- remote-owned history 在接受新输入前完成 bootstrap，保留 UUID、hidden/meta 消息、compact boundary 和顺序并与 live echo 去重；退出提示使用远端 session identity、target 和 cwd 生成可安全复制的 SSH resume 命令，本地不再双写 transcript。
- SSH `!command` 在 managed remote cwd 执行，和模型 turn 串行互斥；输入、stdout 与 stderr 以转义后的 synthetic transcript 提供给后续模型 turn，并保留中断、部分输出与退出状态。
- PromptInput 查询远端目录和 fuzzy index，支持 cold-index refresh、目录连续补全，以及包含空格、引号、反斜杠、美元符号、反引号和 Unicode 的路径。
- managed SSH bootstrap 与 workspace directory validation 使用远端语义，并为慢速认证、请求取消与断线 cleanup 提供明确边界。
- 远端 Agent 的 assistant/tool-result progress、Bash 和未知 MCP tool card 可在本地 TUI 显示；display-only fallback 不进入本地 execution catalog，也不能在本机执行。

#### Prompt context 与 deferred tools

- 主会话操作安全、Bash Git/PR、Explore 和 Plan 的静态说明在保留授权、安全、只读与输出契约的前提下合计从 13,439 缩至 3,833 字符，四类提示合计估算约减少 2,402 tokens；普通主会话冷缓存请求约减少 1,715 tokens。
- Agent listing 默认移入增量 attachment，首轮仍包含完整可用类型与权限，后续只发送增删；Agent orchestration guidance 合并重复的 foreground/background、fresh-context、briefing 和 resume 说明。
- deferred tool namespace 对同一 MCP namespace 的大列表使用汇总索引并保留精确增量状态；26-tool 样本从 935 缩至 64 字符。不同 Codex App namespace 保持独立，避免同名集合覆盖或错误路由。
- 新增 prompt context 优化设计与结果文档，记录测量基线、cache 稳定性收益、节省来源和未覆盖风险。

#### 模型发现与缓存

- `CLAUDE_CODE_USE_OPENAI=1` 时自动发现模型：ChatGPT OAuth 查询 Codex models endpoint，API key billing 查询 `OPENAI_BASE_URL/v1/models`，未配置 base URL 时使用 OpenAI 默认 API。
- Anthropic API billing 在设置 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 和 `ANTHROPIC_BASE_URL` 时查询 gateway `/v1/models`；`ANTHROPIC_AUTH_TOKEN` 使用 Bearer 且优先于通过 `x-api-key` 发送的 `ANTHROPIC_API_KEY`，普通 `CLAUDE_CODE_OAUTH_TOKEN` 不作为 gateway 发现凭据。
- base URL 会规范化为唯一的 `/v1/models` 路径；OpenAI 默认 API 过滤到受支持的 GPT/o-series/Codex 系列，自定义 OpenAI-compatible endpoint 与 Anthropic gateway 保留响应中声明 API support 的其他模型，hidden 项在 Model Picker 标记为 `(Hidden)`。
- OpenAI、Anthropic gateway 与既有 bootstrap model options 统一使用 `additionalModelOptionsCache`；启动模式固定时不再维护 OpenAI 专用缓存。
- 发现被禁用、缺少 base URL/认证、网络失败、超时或响应 malformed 时保留已有共享缓存，并回退到缓存或内置模型；成功且格式有效的空模型列表是 authoritative result，会清除对应 identity 的旧发现缓存，而不是恢复旧项。
- OpenRouter 仅作为 OpenAI-compatible `/v1/models` 测试目标，未增加 provider、路由、环境变量或专用缓存。

### 测试覆盖

- SSH focused tests 覆盖 settings/auth boundary、history replay、permission control、远端目录验证、cold-index refresh、特殊字符路径与 managed lifecycle；prompt tests 覆盖 Agent attachment、deferred namespace 和精简后的工具指引。
- OpenAI model options、bootstrap、OpenAI compatibility 和 auth env focused tests 通过，覆盖 discovery disabled、缺少 base URL、无可用 gateway auth、网络失败及失败时保留共享缓存；使用 `~/.codex/auth.json`、mjclouds Anthropic/OpenAI-compatible profile 和 OpenRouter profile 完成真实发现请求，分别发现 9、13 和 421 个可用模型。
- 使用当前源码构建 binary，并逐个打开 5 个 `~/.claude/settings*.json` profile 的 `/model` picker，验证当前项定位、滚动、方向键移动和 Esc 不保存；`v2.1.213` 完整 release gate 由本条目对应的发布验收流程执行。

## 2026-08-19 - v2.1.212 - SSH 权限同步与远程执行边界

### 版本状态

- 准备发布版本：`v2.1.212`。
- 本次发布覆盖 `v2.1.211..v2.1.212` 至 2026-08-19 的 SSH 权限模式同步、远程 shell、既有 Direct Connect 控制协议加固和本地/远端执行边界修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.212`。

### 关联提交

- `b82848a` — 同步 SSH 本地 TUI 与 managed remote child 的 bypass 权限状态，并在远端确认成功后更新本地模式。
- `3fa3cb4` — 将 shell、工具和项目上下文执行收敛到 managed remote child，并隔离本地 SSH UI 的项目设施。
- `06a9203` — 加固 Direct Connect control schema、permission cancellation 和 late response cleanup。
- `8a9381d` — 完成 remote session release candidate 的边界检查、测试与发布元数据。

### 变更内容

#### SSH 权限模式与控制协议

- `/plan`、`/yolo` 和 Shift+Tab 通过 SSH control request 同步到 managed remote child；显式 CLI permission 参数在 remote child 启动命令中转发。本地 UI 只有在远端成功确认 live mode change 后才提交模式变化，失败或乱序响应会恢复已确认状态。
- root remote child 只有在 host-managed provider、SSH remote marker 和非空随机 capability token 同时成立时才能使用 bypass；settings env 无法伪造或覆盖这些会话能力标记。
- 永久 permission updates 在 SSH、Direct Connect 和 Remote Session permission response 中保持完整；SSH manager 额外处理 replayed permission response、interrupt acknowledgement、取消超时、断线和 pending request cleanup。
- 本次发布不新增 Direct Connect transport；它在 `v2.1.211` 中已经是 HTTP session + WebSocket remote transport。本次仅使用完整 control schema 拒绝 malformed frame，跟踪 pending permission request，并在 server cancellation 到达时移除对应权限提示，避免 stale prompt 和取消后的迟到响应。

#### 远程 shell 与 transcript

- SSH 会话中的 `!command` 直接在 managed remote child 的远端 cwd 执行，不再发送给模型或误在本地主机运行；shell 与模型 turn 串行互斥，并支持中断、部分输出和明确退出状态。
- 远程 shell 输入、stdout 和 stderr 经过 XML 转义后写入 synthetic transcript，并立即尝试持久化；持久化失败会记录 debug error，但不改变已经成功的 shell 结果。后续模型 turn 可以引用内存中的真实远端输出，同时避免 transcript markup 注入。
- direct-shell control request 要求匹配每次会话生成的 capability token；缺失、空值或不匹配时 fail closed。

#### 本地与远端执行边界

- 本地 SSH 进程仅保留 TUI、SSH transport、认证 proxy、账户 onboarding 和 permission UI；tools、skills、plugins、agents、hooks、MCP、LSP、scheduler、文件索引、附件、repository context 和 remote transcript 均由 managed remote child 负责。
- SSH local UI 使用固定安全 slash-command 列表，并跳过本机 `CLAUDE.md`/Memory、Git repository、installed plugins、startup hooks、Logo recent-session preload、background housekeeping 和 spinner plugin predicate 扫描，避免把本机项目上下文泄漏到远端会话。
- SSH root argv 解析统一处理 `--`、dash-prefixed required values、agent/model precedence、auto-mode aliases 和 attached short options；明确拒绝 remote 不支持的 worktree、tmux 与 SDK URL 组合，并将 remote-owned advisor 参数转发给 managed child。
- 所有 remote execution session（Remote Session、既有 Direct Connect 和 SSH）当前都禁用本机 IDE integration、local tools 和 local skill watcher，避免本机 IDE/workspace 与远端执行上下文混用。该保守边界是 SSH 隔离所必需的，也意味着即使 Direct Connect server 与本机共享 workspace，remote session 也不会暴露本机 IDE MCP tools。

### 测试覆盖

- 当前六文件 SSH focused suite 共 86 项测试通过，覆盖 permission mode、capability token、direct shell、transcript、argv parsing、部署与 managed control lifecycle；Direct Connect control protocol 的 malformed request、server cancellation、socket close cleanup 和 late response 有专用回归测试。
- TypeScript、ESLint、missing import/asset audit 和 `git diff --check` 通过；实现阶段使用 `pojun-master` root 与 `test` 用户验收远端 shell、模型读取 shell transcript、`/plan`、`/yolo`、Shift+Tab 和 CLI bypass，ControlMaster cleanup 成功。
- debug log 证明 remote child 从 `bypass=false` 启动，收到并确认 `bypassPermissions` control request；最新 boundary run 未再观察到本机 Memory、Git repository 或 installed plugins 的加载日志。

## 2026-08-17 - v2.1.211 - Remote SSH 部署与生命周期加固

### 版本状态

- 准备发布版本：`v2.1.211`。
- 本次发布覆盖 `v2.1.210` 之后至 2026-08-17 的 SSH 超时、Remote binary 部署与 ControlMaster 生命周期修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.211`。

### 关联提交

- `37c0ba0` — 延长 SSH command timeout，并允许较慢的远端认证和连接重试完成。
- `c8d1585` — 强化 Remote SSH 分块部署、生命周期日志、ControlMaster cleanup 与短 ControlPath。
- `b20724c` — 首次补充 Remote SSH 加固说明；本条目将误放在 `v2.1.210` 下的内容移至正确版本。
- 当前维护本条目的 release metadata commit 因提交时 hash 尚未生成，不在关联提交中自引用；完整范围以 `v2.1.210..HEAD` 为准。

### 变更内容

#### SSH 连接与生命周期

- SSH command timeout 延长至 2 分钟，并使用 30 秒连接超时与 3 次连接尝试，允许较慢的远端认证和连接重试完成。
- ControlMaster 使用系统原生临时目录中的 96-bit 短随机 socket path，避免 macOS OpenSSH 的 Unix socket 路径长度限制并保持 Windows 兼容。
- SSH Remote 为 probe、部署、proxy、remote child 和 ControlMaster lifecycle 增加 debug log，并在启动失败、断线或正常退出时幂等清理远端 socket、认证 proxy 与本地 ControlMaster。

#### Remote binary 部署

- Remote binary 改为按 2 MiB 分块上传，每块校验 SHA-256 并对瞬时传输失败重试；全部完成后再次校验完整文件，再通过临时文件和原子 `mv` 安装，避免 partial binary 被执行。

### 测试覆盖

- SSH focused tests 覆盖慢速认证参数、分块上传与 checksum、瞬时失败重试、短 ControlPath，以及启动失败、断线、正常退出和 cleanup 失败时的幂等资源清理。
- 发布门禁要求 SSH focused tests、`make release-check VERSION=2.1.211`、发布版本 binary 构建与版本输出验证通过；真实 `pojun-master` 验收确认已安装 `v2.1.210` 无法完成 remote binary 部署，而 `./built-claude` `v2.1.211` 命中已校验 remote cache、启动 remote child 并进入远端 TUI。

## 2026-08-16 - v2.1.210 - SSH Remote、安全认证隧道与任务详情增强

### 版本状态

- 准备发布版本：`v2.1.210`。
- 本次发布覆盖 `v2.1.209` 之后至 2026-08-16 的 SSH Remote、SetGoal 输出、Terminal task 参数展示与发布门禁修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.210`。

### 关联提交

- `c0d0f78` — 在 Terminal 后台任务详情中保留并显示原始参数数组。
- `90d5325` — 在 SetGoal tool output 中显示当前目标内容。
- `eb8dbc3` — 默认启用安全的 SSH Remote 会话、认证隧道和 Linux remote binary 部署。
- `d054818` — 将本地解析后的 model 显式传给 SSH remote child。
- `a036cbf` — 修复 `/terminal` command source 合并冲突，并补齐 SSH lifecycle、managed env、root argv 与 Terminal detail 发布门禁覆盖。
- `444a7d3` — 修正 deep-research binary gate 对合法 source shortfall 的误判，并严格验证缺失 rank 的零工具调用契约。
- `7b2e0d2` — 将本地解析后的 model 显式传给 `ssh --local` child。
- `a563c88` — 将 release code-review gate 限定到显式解析的 release commit range，避免自动扩大审查范围。
- `91fa57f` — 准备 `v2.1.210` 的版本号、README 与 CHANGELOG 发布元数据。
- `92728c5` — 补充 local SSH model forwarding 与 bounded code-review gate 的发布说明。
- 当前维护本条目的 release metadata commit 因提交时 hash 尚未生成，不在关联提交中自引用；完整范围以 `v2.1.209..v2.1.210` 为准。

### 变更内容

#### SSH Remote 与认证边界

- 默认构建启用 `SSH_REMOTE`，新增 `claude ssh <host-or-config> [dir]`：本地 TUI 通过 stream-json 驱动远端 Linux child，支持 SDK 消息、tool permission allow/deny/cancel、interrupt 与断线清理。
- SSH host 可以直接使用 `user@host`、`~/.ssh/config` alias，或 settings 中的 `sshConfigs` ID；managed config 可声明 port、identity file 和默认远端目录，命令行 `[dir]` 可覆盖该目录。
- API/OAuth 凭据仅由本地 provider-aware Unix socket proxy 注入；远端 child 只收到 placeholder 与 reverse-forwarded socket path，不继承本机 OpenAI/Anthropic credential、base URL 或 auth token。
- 本地 proxy 分别限制 OpenAI `POST /responses` 与 Anthropic `POST /v1/messages`、`POST /v1/messages/count_tokens`，过滤请求和响应中的 credential/cookie headers，限制 request body，并拒绝非 loopback 明文 HTTP upstream。
- SSH Remote 将本地已解析 model 作为 `--model` 转发给 remote child；`ssh --local` 同样显式传递该 model，使自定义 gateway/model settings 在两种 child 启动路径中保持一致。

#### Remote binary 构建与部署

- SSH Remote 探测远端 Linux architecture，x64 主机使用 `linux-x64-baseline`，ARM64 使用 `linux-arm64`；远端 binary 按版本和 target 缓存在 `~/.cache/claude-ssh/` 并在部署前验证可执行版本。
- 发布 workflow 新增 `linux-x64-baseline` asset，并在生成 `SHA256SUMS.txt` 前校验完整平台 artifact 集；下载路径先核对 release checksum，再原子写入本地 cache 和远端目标。
- 开发态仅直接使用当前可执行文件相邻的 `dist/release` artifact，不从工作目录加载同名 binary；只有从 GitHub Release 下载的 asset 才要求 `SHA256SUMS.txt`，checksum 缺失或不匹配时 fail closed。

#### Goal 与 Terminal task 展示

- `SetGoal` tool output 显示当前目标内容，普通模式按显示宽度截断，verbose 模式保留完整多行目标。
- Terminal 后台任务保存原始 `args` 数组，并在任务详情中以 JSON 形式展示 command、args 与 cwd，避免只看到 executable 而无法还原启动参数。
- 用户输入 `/terminal` 时保留 `getCommands()` 中同名的内置 slash command 与 bundled Terminal skill；plugin/MCP command source 合并不再误删用户命令，用户侧优先打开 Terminal task 详情，模型侧 Skill lookup 仍保留原有 skill。

### 测试覆盖

- SSH focused tests 覆盖连接配置与输入校验、shell quoting、stream-json init/readiness、消息与 permission control、interrupt、早退/断线、OpenAI/Anthropic auth tunnel、settings env 隔离、header/route/body 安全边界、local/remote model forwarding、baseline target、checksum 与 cache 约束。
- build/release tests 覆盖默认 `SSH_REMOTE` feature、Linux x64 baseline target、release artifact 清单、checksum 生成顺序与 npm platform package 排除规则。
- SetGoal output、Terminal task details 和 `/terminal` command/skill name collision tests 覆盖短/多行/宽字符目标、后台参数持久化、UI 展示、真实 command source merge 与 user/model invocation 分流；deep-research driver regression 额外覆盖少于 15 个 unique URL 时实际来源 exact-once WebFetch、缺失 rank 的 `url: null`/`missingReason`/zero-tool 契约及非法 shortfall；code-review driver regression 验证使用解析后的 `<release-base>..HEAD` 且禁止扩大 diff range；发布门禁继续要求 focused tests、`make release-check`、当前 `built-claude` scripted tmux 交互和 release/docs audit 同轮通过。

## 2026-08-10 - v2.1.209 - Workflow 终态、失败诊断与会话一致性修复

### 版本状态

- 准备发布版本：`v2.1.209`。
- 本次发布覆盖 `v2.1.208` 之后至 2026-08-10 的 effort、自动压缩、主线程目标与 Workflow runtime 修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.209`。

### 关联提交

- `5c31e45` — 保持用户显式配置的 effort，不再根据模型 capability 静默降级。
- `66f9543` — 保留自动压缩与 Workflow failure 的原始错误、usage 和 retry 详情。
- `92220db` — 串行化同一 Workflow run 的进程内及跨进程 session mutation。
- `50684e4` — 允许主线程通过 `SetGoal` 设置自主完成目标，并隔离 Agent context。
- `b027a8b` — 收敛未等待的 runtime call，保护 Workflow task、run 与 terminal 状态一致性。
- `af64f72` — 移除 declarative Workflow 的默认 stall timeout，仅在显式配置正数阈值时启用 stalled 中止与重试。
- `fb84d33` — 补充本版本 Workflow stall 修复的发布说明；该提交仅维护 release metadata。

### 变更内容

#### Effort 与自动压缩错误保真

- 用户显式配置的 `xhigh`、`max`、`ultra` 和 `ultracode` 按 provider 映射后传入 API，模型 capability 仅限制可选档位，不再静默覆盖已有配置。
- 自动压缩遇到 `429`、rate limit 或 usage limit 时保留原始错误文本并恢复为 rate-limit/429 分类，不再统一伪装成 prompt-too-long；其他 blocking-limit 场景继续返回明确的上下文过长错误。

#### 主线程目标与 Workflow 诊断

- 主线程新增 `SetGoal` 工具并复用 `/goal` Stop hook，在目标尚未完成时阻止会话提前结束；Agent context 的工具过滤和运行时校验继续拒绝修改主会话目标。
- Workflow retry 与失败路径保留 logical worker、attempt、error kind、token、tool use、duration 和原始错误详情；跳过、暂停与终止路径固化相应 task/attempt 状态及当前 usage。
- 同一 Workflow run 的 session 更新通过进程内 mutation queue 与 canonical path 上的跨进程文件锁串行提交，并保留第一个 terminal 结果。

#### Runtime 终态完整性

- Workflow script 返回后等待已启动的 `agent()` 与 child `workflow()` runtime call 收敛，未等待或传递性启动的失败不会被误报为 completed。
- 重复 Workflow run ID 不再注册第二个 task；task 注册失败会留下可诊断的 failed session，terminal 后的迟到进度不能覆盖 task/run 终态。
- official-style script runtime 与 declarative Workflow Agent 未显式配置 `stallMs` 时均不附加隐式 stall timeout，可保持 running 直到真实终态；只有调用方显式配置正数 `stallMs` 时才启用 stalled 中止与重试。

### 测试覆盖

- effort、blocking-limit/compact error、SetGoal 隔离、Workflow usage/retry/session concurrency/runtime terminal integrity 均有对应 focused regression tests。
- 发布门禁要求完整执行 changelog 校验、TypeScript、ESLint、missing asset audit、`git diff --check`、ripgrep packaging tests 与当前源码 binary build/smoke；Python 验证脚本生成的 bytecode/cache 不进入 release payload。
- binary-side 验收使用 scripted tmux 覆盖直接/嵌套 Agent、Workflow、受控 retry/failure、`/deep-research` 和 `/code-review`；任一缺少稳定 ID、terminal marker、debug evidence 或副作用检查的目标均不得判为通过。

## 2026-08-04 - v2.1.208 - Agent、Workflow 生命周期验证与重试可靠性修复

### 版本状态

- 准备发布版本：`v2.1.208`。
- 本次发布覆盖 `v2.1.207` 之后的 Agent、Workflow、coordinator 和 release validation 生命周期修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.208`。

### 关联提交

- `c70318b` — 修复并发 teammate 注册时的 Team 配置覆盖与同名冲突。
- `564d0e3` — 修复 transient Workflow worker 重试，并保留 logical worker 与 attempt 诊断。
- `604e54f` — 支持发现并合并 persisted Workflow runs。
- `3c420ae` — 使用稳定 target identity 修复 coordinator Agent 视图导航。
- `a4bab5c` — 增加 Workflow runtime release gate 覆盖。
- `9db95a5` — 强制 Agent 与 Workflow 生命周期完成证明。
- `95f3743` — `docs: record unreleased workflow validation changes`，记录本次 Agent、Workflow 生命周期验证与重试可靠性修复。

### 变更内容

#### Team 与 Workflow 可靠性

- 并发 teammate 注册、删除和模式更新在最新 Team 配置上串行提交，避免 stale snapshot 覆盖成员状态，并为同名 teammate 分配稳定名称。
- transient Workflow worker 只重试失败的 logical worker，成功 worker 不重复执行；deterministic、schema 和 permission failure 不自动重试。
- Workflow 记录 task、run、phase、logical worker、attempt、error kind 和 terminal 状态，详情保留失败根因与重试链路。
- 进程重启后可以发现 persisted Workflow runs，并以 live run 优先、按 `workflowRunId` 去重提供只读 fallback。

#### Coordinator 与 Agent transcript

- coordinator 使用稳定 target identity 管理 main、background、Agent 和 Workflow 导航，目标消失时确定性回退到可见祖先或主线程。
- `local_agent` 与 `in_process_teammate` 统一 viewed-Agent 选择语义；正在查看的 terminal teammate transcript 在退出视图前保持完整。

#### Release validation 生命周期门禁

- binary gate 必须观察真实 Agent terminal marker、assistant transcript、Workflow worker/phase terminal、task notification 和主 prompt 恢复后才允许 cleanup 或判定通过。
- release driver 对缺少 terminal evidence、notification 或稳定 Task/Run/Agent ID 的场景 fail closed，避免仅凭 pane 文本或状态文件产生假阳性。

### 测试覆盖

- Team、Workflow retry/diagnostics、persisted Workflow、coordinator selector、viewed Agent transcript 和显式 permission mode focused tests 通过。
- `test-release-driver.py`、`bunx tsc --noEmit --pretty false`、`bun run lint`、`make release-check` 和 `make build` 通过。
- built binary 生命周期验收通过 Agent 前后台、nested Agent、inline Workflow、`/deep-research`、`/code-review`、deterministic failure detail 和 partial transient retry targets。

## 2026-08-02 - v2.1.207 - MCP Skill 生命周期与 Agent transcript 上下文修复

### 版本状态

- 准备发布版本：`v2.1.207`。
- 本次发布覆盖 `v2.1.206` 之后至 2026-08-02 的 Agent transcript 上下文修复与 MCP Skill over MCP 生命周期实现。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.207`。

### 关联提交

- `5ac290f` — 2026-08-01 — `fix: preserve agent transcript context`
- `1ade751` — 2026-08-02 — `feat: implement MCP skill extension lifecycle`

### 变更内容

#### Agent transcript 上下文与会话切换

- 选中 local Agent 或 in-process teammate 时，REPL transcript 使用该任务自己的 messages、运行状态和 in-progress tool use，不再错误回退或混入 leader 会话内容。
- 进入 transcript 模式时同时冻结当前 task identity、message length 和 streaming tool-use length；即使随后任务状态变化，当前 transcript 仍绑定进入时选中的 Agent，上下文不会在会话之间漂移。
- 统一 viewed Agent selector，使 local Agent 与 in-process teammate 共享明确的选择语义；无选择、无效 task ID 或非 Agent task 均不静默回退到其他任务。

#### Skill discovery、identity 与完整性

- 普通 MCP server 支持 `io.modelcontextprotocol/skills` 扩展的 `skills/list`、`skills/get`、empty/partial listing 和 direct/unlisted URI activation；Skill identity 绑定 host-assigned server 与完整 URI，不再依赖名称或 `skill:` scheme，并为同名不同路径 Skill 生成可区分的调用名称。
- `resources[]` 作为完整 manifest 绑定 `SKILL.md` 与 supporting resources，逐文件验证 canonical `sha256:` digest，并要求 listing frontmatter 与实际 `SKILL.md` frontmatter 逐字段一致；content-addressed cache 同时绑定 server identity、URI 和完整 manifest snapshot。
- 保留无 `resources[]` dynamic Skill 和 legacy single-file Skill 的加载路径，但不为 dynamic content 建立持久 cache，且 supporting-resource 访问默认 fail closed。

#### Resource scope 与目录读取

- `ReadMcpResourceTool` 将 supporting-resource 访问绑定 active Skill 的 originating server、Skill URI 和 manifest grant，在模型看到内容前验证 text/blob 原始内容 digest，并拒绝未列出、跨 server、响应缺项、额外资源和 malformed base64。
- 新增 `ReadMcpResourceDirTool` 和 `resources/directory/read` pagination；目录访问限制在显式 Skill root 内，结果由 manifest 推导 direct children 和 metadata，拒绝 ancestor traversal、跨 origin、unlisted child 与 incomplete listing。
- 普通 MCP Skill 顺序激活时替换上一 Skill 的远程资源 scope，避免权限累积；可信 Agent definition 显式 preload 的多 Skill union 保持原有设计。

#### Codex Apps 隔离

- Codex Apps 继续使用独立的 `resources/list + mimeType: "mcp/skill"` lazy materialization，不受普通 MCP Skill extension discovery、resource grants、cache 和 attachment guard 影响。
- 声明 Skill extension 的普通 MCP server 不能通过 generic attachment preload 绕过 `skills/get`、digest、frontmatter identity 或 SkillTool permission gate；普通 generic MCP resources 与 host-owned Codex Apps 保持原行为。

### 测试覆盖

- `src/state/selectors.test.ts` 覆盖 leader 无选择、无效 task ID、local Agent、in-process teammate 和 teammate-only selector 边界。
- MCP focused suite 共 `82 pass`、`0 fail`，覆盖 canonical manifest、`skills/get`、direct URI、domain-native URI、same-name disambiguation、frontmatter identity、per-resource digest、directory pagination、cache identity、dynamic fail-closed、root containment 和 sequential scope replacement。
- `bunx tsc --noEmit --pretty false`、`bun run lint`、`git diff --check`、`git diff --cached --check` 和 `make build` 均通过；发布前重新构建并校验 `2.1.207 (Claude Code)` 产物。
- scripted tmux runtime validation 通过 canonical list/load/invoke、direct URI、same-name activation、supporting-resource allowlist、directory pagination、same-identity cold/warm cache、dynamic no-manifest denial、ancestor directory denial，以及 OAI/non-OAI settings 下 ordinary MCP 与 Codex Apps materialization 隔离。
- non-OAI ordinary MCP invocation 已 qualified passed；真实 settings proxy 下的 authenticated OAI ordinary invocation和实际 authorized Codex Apps 调用仍为 `not covered`，未将临时 MITM harness 的失败归因于产品路径。

## 2026-08-01 - v2.1.206 - Coordinator、MCP Skill 与 Agent 生命周期增强

### 版本状态

- 准备发布版本：`v2.1.206`。
- 本次发布覆盖 `v2.1.205` tag 之后至 2026-08-01 的全部提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.206`。

### 关联提交

- `9a9d4b5` — 2026-07-31 — `fix: collapse nested agents in coordinator status`
- `710d4f2` — 2026-07-31 — `fix: align recursive coordinator navigation and rows`
- `26f95b3` — 2026-08-01 — `feat: expose MCP skill provenance`
- `7da0067` — 2026-08-01 — `feat: route nested agents through coordinator worker`
- `51721b7` — 2026-08-01 — `docs: document coordinator worker changes`

### 变更内容

#### Coordinator 与 Agent 生命周期

- Coordinator 主视图聚合递归子 Agent，支持 root、child、grandchild transcript 导航，并隔离 Workflow Agent 子树；Agent 行显示真实类型、description、焦点状态和运行中后代数量。
- Coordinator 模式（受 `COORDINATOR_MODE` 构建特性控制，不在默认构建中）恢复内置 `worker` Agent，提供自主执行任务所需的工具、权限和运行轮次，并约束 Worker 的任务范围、子 Agent 派生、错误处理和结果汇报。
- nested Agent 在父 Agent 仍运行时将终态 notification 路由到父 Agent；父 Agent 已结束、不存在或不可消费时回退主线程，避免结果在 Coordinator 上下文中重复展示。
- Agent 结束时检查未匹配的 `tool_use`；工具调用尚未完成时进入 failed 状态，不再使用旧文本结果错误生成 completed 状态。

#### MCP Skill 与 Codex Apps 来源

- 非 Codex MCP server 支持通过 `io.modelcontextprotocol/skills` 扩展和 `skills/list` 发现社区 Skill over MCP，并通过 `resources/read` 延迟加载 `skill://<name>/SKILL.md` 内容。
- Skill 来源拆分为 `MCP skills` 与 `Codex skills`，slash autocomplete 增加 Codex 来源标记；远端 Skill 内容不会获得工具、hook、model、agent 或 shell 执行权限。

### 测试覆盖

- Coordinator 行模型、Worker 定义、nested notification 路由、通知去重、未完成 tool use 失败、前后台续接、MCP Skill discovery 和来源展示均有 focused test 覆盖。
- `make release-check` 通过：CHANGELOG、TypeScript、ESLint、缺失导入审计和 `git diff --check` 全部通过；本轮 `built-claude` scripted tmux 验证通过 direct Agent 前后台生命周期、nested Agent、Workflow/WorkflowTool、task/notification、`/deep-research` 和 `/code-review`。
- `/deep-research` 验证 5 次 WebSearch 与 15 次 WebFetch exact-once；`AgentTool.nesting.test.ts` 的额外 worktree 断言受当前 Agent Teams 计划门控影响，未将未覆盖部分伪造为通过。

## 2026-07-27 - v2.1.205 - Agent 权限继承、Workflow 稳定性、release notes 校验与用量成本修复

### 版本状态

- 准备发布版本：`v2.1.205`。
- 本次发布覆盖 `v2.1.204` tag 之后至 2026-07-27 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.205`。

### 关联提交

- `2f0331a` — 2026-07-25 — `update: expose ChatGPT usage and reset controls`
- `ccbbd3e` — 2026-07-26 — `update: bundle and validate release notes`
- `b89577c` — 2026-07-26 — `fix: inherit agent permissions across launches`
- `cca50c2` — 2026-07-27 — `fix: harden agent and workflow launches`
- `7164ec2` — 2026-07-27 — `fix: undefined of usage.input_token bug`

### 变更内容

#### Agent 与 Workflow 权限继承

- Agent tool 的 `mode` 改为可选；未显式指定时继承调用方权限。父会话为 `bypassPermissions` 时，模型直接派发的 direct、resume、named、process/pane 和 in-process Agent，以及省略 `permissionMode` 的 Workflow Agent 均保持 bypass。
- 普通 Agent mode 按官方权限等级限制提权，同时保留可信 Agent definition 的 `permissionMode` 提权能力；父会话为 bypass 时忽略模型自动生成的较低 mode，避免被意外降为 `default` 或 `acceptEdits`。Workflow 配置中显式声明的 `permissionMode` 仍作为可信 launch context 生效；plan approval 后同步 task 与 team member mode。
- Agent definition 的 `tools`、`disallowedTools` 及 `Read(example.txt)`、`Bash(npm test)` 等参数化 permission rules 传播到 schema、session allow rules 和子进程 CLI flags。

#### Workflow runtime 与发布门禁

- bundled deep-research 新增单一 passive `select-sources` phase：统一按 Search worker/result 顺序去重并选择 15 个 URL，15 个 Fetch worker只消费各自的 `oneBasedRank`；缺少 rank 时不编造或替换来源，binary gate 校验 Search/WebFetch exact-once、共享 rank 一致性、retry 与意外工具调用。
- Script Workflow 的 Agent stall 现在同时中止子 controller 并终止 runtime await；即使底层 Agent call 忽略 abort，parallel workflow 仍会将该 Agent 记为 failed 并进入 task/run/notification 终态，不再永久停在 running。
- built-claude 验证 launcher 在 `env -i` 隔离下仅透传大小写 proxy 变量，不传播 auth 或无关宿主变量；binary driver 等待持久化 task notification，并将 Workflow 未完成时未执行的 UI 检查明确标记为 skipped。

#### ChatGPT usage 与 release notes

- `/usage` 和 Settings Usage 支持 ChatGPT 用量窗口及 rate-limit reset credits，reset 操作经过确认并在成功后刷新显示。
- release notes 改为从内置 `CHANGELOG.md` 读取并按当前 binary version 截断；新增 changelog 格式、版本和发布脚本校验。

#### 用量成本计算修复

- 非流式 fallback 路径在 API 响应缺失 `usage` 时不再崩溃：调用侧改用归一化后的 `usage`，`calculateUSDCost` 增加缺失 `usage` 的边界守卫并按零成本处理，修复 `undefined is not an object (evaluating '$.input_tokens')`。

### 测试覆盖

- Agent permission、resume、foreground/background continuation、teammate propagation、Workflow stall terminalization、bundled deep-research source-selection 和 release driver focused tests 均通过；TypeScript、ESLint、missing imports/assets audit 与 `git diff --check` 通过。
- `src/utils/modelCost.test.ts` 覆盖 `calculateUSDCost` 在缺失 `usage` 时返回 0 且不抛异常、正常 `usage` 仍计算正成本。
- 同一 Round 9 fresh `2.1.204` binary（SHA-256 `7b61f508bebf4c2d71e6d00fa07494194a9723bd0fbd79ebd66afc4714875951`）完成 readiness、direct foreground→background、nested Agent、inline Workflow UI/task/notification、deep-research 和 code-review 交互矩阵；5 个 Search 与 15 个 Fetch worker 均 exact-once，15 个 Fetch URL 全部匹配共享 source rank，且未留下本轮 task/process/tmux 或 Git 副作用。

## 2026-07-24 - v2.1.204 - Workflow/Agent 失败记账、重试恢复与 OpenAI Web Search

### 版本状态

- 准备发布版本：`v2.1.204`。
- 本次发布覆盖 `v2.1.203` tag 之后至 2026-07-24 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.204`。

### 关联提交

- `f9f637a` — 2026-07-21 — `update: README`
- `a9af0b1` — 2026-07-21 — `remove: name incorrect`
- `cc70099` — 2026-07-22 — `test: cover workflow agent failure validation`
- `e4e8130` — 2026-07-22 — `fix workflow agent failure accounting`
- `500103b` — 2026-07-22 — `fix workflow retry identity edge cases`
- `fc1f1cc` — 2026-07-22 — `fix workflow retry and resume consistency`
- `aac126c` — 2026-07-23 — `require runtime interaction in validation skills`
- `44dceca` — 2026-07-23 — `fix workflow agent scheduling consistency`
- `efa2fff` — 2026-07-23 — `update: Chaneglogs`
- `ea2b350` — 2026-07-23 — `update: validate release check example scripts`
- `31a07f1` — 2026-07-24 — `enable OpenAI web search workflows`

### 变更内容

#### Workflow Agent 失败、重试与终态记账

- Agent terminal/API/structured-output 失败不再被当作成功；Local Workflow task 分离 logical Agent 与 physical attempt，并记录连续 retry lineage。
- automatic/manual retry 共用连续 attempt identity；旧 attempt 的迟到结果不能覆盖当前 active attempt。
- Workflow 状态页、详情页和 Coordinator 行按 terminal outcome 计算 completed、failed、skipped 与进度。

#### Resume、identity 与权限边界

- Workflow journal 和 declarative resume 仅复用 `completed` result；非完成 entry 不会污染或遮蔽后续完成 entry。
- resume identity 使用实际生效的 permission mode；Agent label 在整个 Workflow run 内唯一，重复 suffix 分配保持线性。
- Agent 显式 `mode` 进入 worker permission context；子 Agent 只能保持或收紧父会话权限。父会话为 `bypassPermissions` 且子 Agent未显式收紧时默认继承 bypass。
- foreground → background continuation 继续消费原 Agent stream，不重复启动 Agent。

#### Script Workflow 与 deep-research

- 删除 script Workflow 固定的 run-level Agent lifetime hard cap；声明式 spec 的 `defaults.maxAgents` 规划校验保留。`parallel()`/`pipeline()` 继续以最多 16 个活跃槽位执行大规模 fan-out。
- OpenAI/ChatGPT provider 启用 server-side `WebSearch`，将 Anthropic web-search schema、forced `tool_choice`、OpenAI Responses `web_search_call`、URL citations 和 usage 转换为现有 Anthropic-compatible stream 事件。
- bundled deep-research 为 5 个 Search worker 和 15 个 Fetch worker分配确定的一对一职责，避免每个 worker重复整个 phase fan-out；3 个 Verify worker各自产生一票，Verify/Synthesize 仅消费上游证据，不再自行调用本地工具或二次委派。

#### 发布门禁

- release validation 使用 repo 外动态 baseline 绑定当前 HEAD、Git 状态和本轮 `built-claude` metadata，不硬编码旧 commit/hash。
- binary gate 使用隔离副作用目录和正常现有账户认证，清除会覆盖私有 gate auth fixture 的 inherited API/OAuth 环境变量；credential 值不进入 evidence。
- readiness、Search/Fetch transcript tool-use/result 关联、process cleanup 和 forced-termination 判定均 fail-closed；历史 false-pass fixture 必须被拒绝。

### 测试覆盖

- Round 7 Feature tests 通过：AgentTool、WorkflowTool、LocalWorkflowTask、OpenAI compatibility、bundled workflow 和 release driver 相关测试均成功，TypeScript 通过；1001-Agent probe 完成 1001 个 logical/physical executions，最大 physical concurrency 为 8（`<=16`）。
- v2.1.204 发布准备时重跑 `make release-check` 通过：version guard、TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均成功。
- 发布准备时 `make build` 生成 `2.1.204` binary（SHA-256 `0ec7399407c672eb315130110d4d792955739fef2ee8dfeaddfa075beceeeacf`），`./built-claude --version` 输出 `2.1.204 (Claude Code)`；本次相对上一轮仅为 `Makefile` 版本号变更，无运行时逻辑改动。
- 下列 binary-side 交互证据来自同一份源码在上一轮 `2.1.203` 构建下的验收（`31a07f1` 当时为待提交改动，现已提交，源码内容一致）：persisted binary driver 的 readiness、direct/nested Agent、foreground/background continuation、Workflow 内 Agent、`/workflows`、`/deep-research` 和 `/code-review high` 全部通过。
- `/deep-research` 实际完成固定 25 workers：WebSearch `5/5`、WebFetch `15/15`（11 成功、4 个符合契约的外部来源失败）、Verify `3/3`、Synthesize `1/1`；无 retry、替代工具、重复通知或遗留 tmux session。
- Release/docs audit 确认版本、README、CHANGELOG 范围和实现一致，diff/file-list 扫描未发现高置信度敏感信息；其唯一 placeholder finding 已由最终报告刷新关闭。
- 完整结论见 `docs/gate-check/2026-07-23-workflow-agent-release-gate.md`；原始 pane、debug log、Task/Run/Agent ID 和 cleanup evidence 保存在 `/tmp/cc-release-final-20260723/final-round-7/`。

## 2026-07-21 - v2.1.203 - Explore/Plan Agent、Codex Apps 与 Terminal 生命周期修复

### 版本状态

- 准备发布版本：`v2.1.203`。
- 本次发布覆盖 `v2.1.202` tag 之后至 2026-07-21 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本为 `2.1.203`。

### 关联提交

- `eef7e23` — 2026-07-19 — `feat: add hosted Codex Apps MCP skills`
- `c2f2ed1` — 2026-07-19 — `fix: expose supported hidden OpenAI models`
- `8246689` — 2026-07-20 — `fix: harden Codex app and terminal lifecycles`
- `3143e6f` — 2026-07-20 — `fix: deliver terminal completion notifications`
- `0ce3afc` — 2026-07-20 — `release: prepare v2.1.203`
- `49cfc32` — 2026-07-20 — `remove: handoff`（仅删除临时交接文档，无运行时变更）
- `231eead` — 2026-07-20 — `fix: gate ChatGPT status by provider`
- `50988a1` — 2026-07-21 — `docs: complete v2.1.203 commit inventory`
- `2341b70` — 2026-07-21 — `test: isolate OpenAI bootstrap cache`
- `5aaa0e3` — 2026-07-21 — `fix: harden terminal and hosted app lifecycles`
- `cad9f94` — 2026-07-21 — `docs: plan instruction footprint reduction`（仅新增执行计划，无运行时变更）
- `199f088` — 2026-07-21 — `fix: embed platform ripgrep in packaged binaries`
- `e3b64c5` — 2026-07-21 — `merge: integrate origin/master`
- `ce05dff` — 2026-07-21 — `fix: simplify embedded ripgrep validation`
- `b79b677` — 2026-07-21 — `refactor: reduce model instruction overhead`
- `0fa556f` — 2026-07-21 — `update: add feature Explore Agent`
- `3da5846` — 2026-07-21 — `docs: consolidate v2.1.203 changelog`

发布证据整理和本条目维护提交（包括 `5e475c6`、`94d8d58` 及后续同类提交）不改变发布功能范围，因此不重复列入关联提交清单。

### 变更内容

#### Explore 与 Plan 内置 Agent

- 对齐 Claude Code `2.1.201` 的内置 Agent 注册逻辑，默认启用只读代码搜索 `Explore` Agent 和只读方案设计 `Plan` Agent。
- 移除恢复构建专用的 `BUILTIN_EXPLORE_PLAN_AGENTS` 编译期 gate，改用 `tengu_slate_ibis` GrowthBook gate；未取得远端配置时默认启用。
- 支持通过 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 显式关闭 `Explore` 和 `Plan`。
- 新增内置 Agent 注册回归测试，覆盖默认启用和环境变量关闭路径。

#### Codex Apps hosted MCP skills

- 新增 host-owned `codex_apps_plugins` MCP runtime，通过 `mcp/skill` resources 发现并按需读取 hosted skills，同时保持 Apps tools 与 skills 投影相互独立，避免重复暴露工具。
- 对 hosted skill 的来源、名称、URI、分页、内容大小和缓存进行限制；仅允许可信的 `codex_apps` 与 `codex_apps_plugins` server 进入该加载路径。
- Codex Apps transport 仅向固定 ChatGPT Apps MCP endpoint 注入 OAuth 与 account 信息，并在 `401` 后强制刷新 token 重试一次。
- Host-owned plugin resources 仅用于 hosted skill 发现，不再作为 generic MCP resources 暴露；缓存绑定 client identity 并增加 TTL。
- 修复同名 connector 的 mention 冲突，并改善包含空格或特殊形式的 Codex Apps mention 补全。

#### OpenAI 模型与 ChatGPT 状态

- OpenAI 与 ChatGPT Codex 模型列表不再无条件过滤 `visibility: "hide"` 的模型；名称符合支持范围且 `supported_in_api !== false` 时，可在 Model Picker 中以 `(Hidden)` 标识显示。
- CLI 启动前等待 ChatGPT utilization 预取完成，避免初始 plan/usage 状态竞态；API key 和非 OpenAI provider 不会请求 ChatGPT subscription usage。
- 隔离 OpenAI bootstrap 测试使用的 model options cache，避免组合测试结果依赖执行顺序。

#### Terminal 终态与 PTY 生命周期

- Terminal task 由统一后台 poller 同步状态和 preview；进程自然退出后自动停止轮询、清理 runtime registry、持久化最终输出，并仅发送一次完成通知。
- 根据真实 PTY 状态区分 `completed`、`failed` 与 `killed`，保留 `exitCode`、`signal`、termination reason 和 driver error。
- signal、close 和状态刷新在进程结束后继续 drain 尾部输出；Bun PTY driver 等待真实进程退出后再确认 signal。
- exited、closed 和 failed session 在 TTL 到期后主动 dispose；Background Tasks detail dialog 不再维护重复 polling。

#### 打包与模型指令

- 打包时校验并嵌入当前平台的 ripgrep，运行时提取到本地缓存，避免依赖系统安装。
- 精简模型指令中的重复内容，降低提示开销，同时保持 Agent、工具和交互约束不变。

### 测试覆盖

- Codex Apps、OpenAI model options、provider-gated ChatGPT plan/usage、Terminal lifecycle 与 AgentTool focused tests 通过。
- `make build` 通过；最新 `built-claude` scripted tmux 验收已确认 `v2.1.203` 启动及 Terminal PTY 生命周期。
- 本地 `built-claude` 真实交互成功调用 `subagent_type: "Explore"`；debug log 确认请求精确解析为 `Explore` 并完成前台 Agent 生命周期。
- 使用 dummy OpenAI credential 与受控 Responses SSE 完成相关发布验收，未使用真实 OpenAI/ChatGPT 凭据或外部 endpoint。

## 2026-07-19 - v2.1.202 - Terminal Tool、功能验收 Skill 与 Codex Apps 集成

### 版本状态

- 准备发布版本：`v2.1.202`。
- 本次发布的功能与修复范围从 `master`（`3df519a`）之后开始；下方列出影响运行时、测试、构建与发布工具的关联提交，纯 CHANGELOG 维护提交不重复自引用。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.202`。

### 关联提交

- `375159f` — 2026-07-19 — `feat: add Claude Code feature validation skill`
- `c6e07d4` — 2026-07-19 — `refactor: rename interactive terminal to Terminal`
- `4bb7a73` — 2026-07-19 — `feat: integrate Codex Apps with ChatGPT subscriptions`
- `5f91915` — 2026-07-19 — `release: prepare v1.2.202`（后续修正为 `v2.1.202`）
- `e93a6cd` — 2026-07-19 — `fix: restore OpenAI credential precedence`
- `10fe3f9` — 2026-07-19 — `fix: fix up bug of openai apikey order and usage data`
- `92fdb6c` — 2026-07-19 — `update: bundle test`
- `19f6ae0` — 2026-07-19 — `docs: clarify OpenAI usage authentication states`
- `03af8cc` — 2026-07-19 — `update: release validation tools`
- `16b341b` — 2026-07-19 — `fix: align Codex Apps with active credentials`

### 变更内容

#### InteractiveTerminal 重命名为 Terminal Tool

- 将 `InteractiveTerminal` 工具、task、command、bundled skill 和 UI preview 统一重命名为 `Terminal`，同步更新工具 schema、模型提示、结果格式和后台任务展示。
- 保留并强化持久 PTY session 的 `open`、`write`、`read`、`resize`、`signal`、`status`、`list` 和 `close` 生命周期；补充 shell 解析和 Bun PTY driver 行为。
- 扩展 Terminal Tool、task state、dialog preview、PTY session manager、shell resolution 和 binary integration 测试，移除旧 `InteractiveTerminalTool` 实现与测试路径。

#### Claude Code 功能验收 Skill

- 新增 `claude-code-feature-validation` skill，根据功能类型路由 source tests、构建检查、tmux TUI 验收、official parity 和外部状态验证。
- 补充 validation routing 参考文档与 eval cases，明确何时需要真实 binary、tmux、官方 CLI 对照及证据留存。

#### Codex Apps mention 与补全

- 新增 `@codex-app:{app-name}` mention 语法，仅从当前已发现且已过滤的 `codex_apps` 工具池解析对应 App，不恢复禁用 connector、不授予未发现能力，也不绕过工具权限。
- 将已选择 App 的名称、connector ID 和工具名称作为不可信 metadata 注入模型上下文，并引导 deferred tool 通过 `ToolSearch` 按需加载。
- PromptInput 在裸 `@` 和 `@codex-app:` 前缀下展示真实 Codex Apps 补全；补全项沿用统一 suggestion UI，并与文件、MCP resource 和 agent mention 区分。
- 防止 Codex App mention 被文件或 MCP resource mention 解析器重复处理，并避免 slash command / skill 展开内容误触发。

#### ChatGPT subscription 检测与 Usage UI

- 对齐 Codex 的 OpenAI plan 解析规则，从 ID token 的 `chatgpt_plan_type` claim 识别并规范化 `Plus`、`Pro`、`Team`、`Business`、`Enterprise` 等订阅名称。
- 保持 `OPENAI_AUTH_TOKEN`、`OPENAI_API_KEY`、auth file API key、ChatGPT OAuth 的原始模型 API 凭据优先级，并以当前实际选中的模型凭据统一驱动计费、Usage 与 Codex Apps 状态。
- 当前模型使用 ChatGPT OAuth 时，Usage 请求前主动刷新 token，启动 pane 使用 `/backend-api/wham/usage` 的权威 `plan_type` 显示 ChatGPT plan；使用 API key 或 bearer token 时显示 `API Usage Billing`，不展示 ChatGPT subscription usage。
- OpenAI 模式不再错误回退 Anthropic Usage；`/status` 的 Usage tab 在 ChatGPT OAuth 模式下展示 Codex limits、account、reset time 和 reset credits，在 API credential 模式下显示 OpenAI-specific unavailable 状态。

### 测试覆盖

- Terminal Tool、PTY session manager、shell resolution、Codex App mention、attachment 隔离、PromptInput completion、OpenAI auth 和 ChatGPT Usage focused tests 通过。
- `make release-check` 通过：`package.json` version guard、TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均通过。
- `make build` 通过。
- tmux binary-side 验收确认：启动 pane 显示权威 `ChatGPT Pro`，`/status` Usage 成功加载 limits，`/mcp` 显示 `codex_apps` connected，输入 `@codex-app:` 可列出真实 Apps。

## 2026-07-16 - v2.1.201 - `/cd` 目录补全与 Effort 配置修正

### 版本状态

- 准备发布版本：`v2.1.201`。
- 本次发布覆盖 `v2.1.200` tag（`3fb49ec`）之后至 2026-07-16 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.201`。

### 关联提交

- `39124c5` — 2026-07-16 — `feat: add directory completion for /cd`
- `10ae12c` — 2026-07-16 — `update: effort fix`

### 变更内容

#### `/cd` 目录补全

- 为 `/cd` 命令接入仅包含目录的路径补全，并允许在命令后的路径参数为空时开始提示。
- 保持 `/add-dir` 原有行为：只有用户开始输入路径后才显示目录建议，路径以空白结尾时清除建议。

#### Effort 配置与显示

- 允许 `xhigh`、`max`、`ultra` 和 `ultracode` 写入 settings 并跨会话保留；`none` 与数字 effort 仍不持久化。
- `ultracode` 统一按 `xhigh` 作为 provider 映射输入：支持原生 `xhigh` 的 Anthropic 模型保留 `xhigh`，其他模型按既有能力回退；OpenAI 仍发送 `xhigh`。
- Effort 状态提示和请求后缀显示实际应用值，不再把 `ultra`、`ultracode` 等统一折叠为基础等级；同步修正 `/effort` 帮助、有效选项和 session-only 文案。
- 扩展 settings schema、Model Picker 初始化及 Anthropic/OpenAI effort 回归测试，覆盖新增持久化和映射行为。

### 测试覆盖

- 与 `v2.1.200` 相比共修改 10 个文件，新增 65 行、删除 51 行。
- `git diff --check v2.1.200..HEAD` 通过。

## 2026-07-16 - v2.1.200 - Workflow facade 官方契约与发布验收收束

### 版本状态

- 准备发布版本：`v2.1.200`。
- 本次发布覆盖 `v2.1.178` 后至 2026-07-16 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.200`。

### 关联提交

- `ac53549` — 2026-07-15 — `feat: enable Codex Apps by default`
- `3272f0b` — 2026-07-15 — `update: add restriction of tmux cli validation and type checks`
- `f48a1d8` — 2026-07-16 — `fix: align inline workflows with official contract`
- `60a8942` — 2026-07-16 — `fix: ignore empty workflow script paths`
- `ac8dbcc` — 2026-07-16 — `docs: update release readiness changelog`
- `a71396f` — 2026-07-16 — `release: prepare v2.1.200`

### 变更内容

#### Workflow facade 官方契约

- 对齐 official Workflow resolver：允许仅通过 `{ script }` 运行 inline workflow；顶层 `name` 保持 saved workflow selector 语义；输入优先级为 `scriptPath > name > script > plan`。
- official-style inline script 的运行名称和持久化文件名来自脚本内 `meta.name`；`{ name, script }` 先解析 saved workflow，再使用传入脚本覆盖执行内容。
- 修复空字符串 `scriptPath` 错误抢占有效 `name` 或 `script` 的问题，并增加输入归一化和权限预览回归测试。
- 更新模型可见工具说明，明确 `{ script }`、`meta.name`、首条未注释 `export const meta` 和参数优先级。

#### Codex Apps 与发布检查

- 默认启用 OAuth-only Codex Apps 集成，并保留 Apps 状态、偏好设置、MCP transport 和工具投影能力。
- 强化 tmux CLI 验收和类型检查约束；`make release-check` 统一执行 package version guard、TypeScript、ESLint、missing imports/assets audit 和 diff whitespace 检查。

### 测试覆盖

- `make release-check` 通过：`package.json` 保持 `0.0.0-dev`，TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均通过。
- Workflow facade、DSL、script parser 和 script runtime focused tests 均通过。
- 最新 `built-claude` binary-side 验收确认：inline `{ script }` Workflow `2/2 agents · 28.8k tok done`；单 Agent `3 tool uses · 27.6k tokens` 完成；`/deep-research` `25/25 agents · 790.2k tok done`；`/code-review` `10/45 agents · 415.6k tok done`，且父 CLI 均恢复交互。
- Workflow stop 的自动化 lifecycle tests 已覆盖 killed notification、SDK `stopped` event 和 abort-aware fan-out；binary-side 验收确认同一 Workflow 从 `running` 转为 `killed`、两个子 Agent 同步停止、主 prompt 恢复交互且 Git 工作区无变化。

## 2026-07-15 - Effort 能力、Workflow 生命周期与 Codex Apps 集成

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.178`。
- 本条目覆盖上次 CHANGELOG 更新提交 `a8961db`（2026-07-13）之后至 2026-07-15 的提交。

### 关联提交

- `388cded` — 2026-07-14 — `fix: harden agent workflows and effort handling`
- `7f2f1b6` — 2026-07-15 — `fix: align effort capabilities and workflow lifecycle`
- `1328492` — 2026-07-15 — `feat: add OAuth-only Codex Apps integration`
- `6c14f86` — 2026-07-15 — `fix: clarify inline workflow script contract`

### 变更内容

#### Provider effort 能力与 wire mapping

- 统一 CLI、SDK schema/runtime/generated types 和请求构造中的 effort 能力表达，保留内部 `ultracode` 编排模式，并按 provider/model 暴露实际支持等级。
- OpenAI compatibility 将 `max` 映射为 `ultra`、将 `ultracode` 映射为 `xhigh`；Anthropic 将 `ultra` 和 `ultracode` 映射为 `max`，并仅为支持的模型保留原生 `xhigh`。
- 修复 `CLAUDE_CODE_EFFORT_LEVEL=unset|auto` 仍可能补发默认 effort 的问题，并补齐 `--effort`、`/effort`、SDK capability 与 provider request 测试。

#### Agent 与 Workflow 生命周期可靠性

- 修复 Agent foreground/background continuation、progress/usage 聚合、summarizer ownership 和 terminal notification 顺序，避免重复消费 stream、重复摘要或 post-processing 失败反转已完成状态。
- failed/killed Agent 的 worktree cleanup 失败改为可见 warning，不再吞掉 terminal notification；completed、failed、killed 路径保留最终 usage。
- Workflow failed 路径补发 XML notification，killed 路径补发 SDK `stopped` event，并使并发 semaphore 感知 abort，停止后不再继续启动排队 Agent。
- 补充 inline Workflow facade 的模型可见脚本契约，明确首条语句必须是未注释的 `export const meta`、phase metadata 格式、`parallel()` thunk 用法以及 official-style 与 legacy DSL 的边界。

#### OAuth-only Codex Apps 集成

- 新增 Codex Apps 管理界面、OAuth 登录与偏好设置，支持 Apps 状态查询、信任确认、tool metadata/normalization、tool-set 管理及 MCP transport 配置。
- 将 Codex Apps 投影到现有 plugin/MCP 管理与 merged tools 数据流，补齐连接状态、启停、重连、工具展示和配置持久化。
- 新增 Apps auth、projection、preferences、status、tool normalization 和 tool-set 测试，覆盖 OAuth-only 边界及 MCP 工具转换行为。

### 测试覆盖

- 已运行 effort、OpenAI compatibility、Agent lifecycle、Workflow facade/DSL/parser/runtime focused tests，均通过；已运行 `bun run lint`、`git diff --check` 和 `make build`。
- 最新 `built-claude` binary-side 验收确认：并发 Agent `2/2` 完成；inline Workflow `2/2 agents · 40.4k tok done`；`/code-review` `8/45 agents · 192.2k tok done`；`/deep-research` `25/25 agents · 960.8k tok done`，且父 CLI 均恢复交互。
- Workflow facade 契约修复后的首次 inline 生成及 binary-side stop 验收因 API connectivity error 未进入调度阶段，不计入通过项；自动化 lifecycle tests 已覆盖 failed/killed notification、`stopped` event 与 abort-aware fan-out。

## 2026-07-13 - Agent 状态可靠性、provider effort 路由与文档整理

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.178`。
- 本条目汇总 `v2.1.178` 后截至 2026-07-13 的提交，包括 Agent async lifecycle 收束与 tmux CLI 验收规范。

### 关联提交

- `e9f92dd` — 2026-07-09 16:38:19 +08:00 — `version update: v2.1.178`
- `13f7cec` — 2026-07-09 16:43:47 +08:00 — `fix: type error`
- `7a2b301` — 2026-07-10 21:43:56 +08:00 — `docs: plan agent progress count fixes`
- `6c2f287` — 2026-07-11 15:08:37 +08:00 — `update: agent token counts`
- `cebda16` — 2026-07-11 23:47:18 +08:00 — `update: fix bug of plugin uninstalled`
- `566b666` — 2026-07-12 01:55:54 +08:00 — `feat: route effort levels by API provider`
- `a4dcff6` — 2026-07-12 15:14:50 +08:00 — `fix: keep agent and UI state aligned with execution`
- `2ddc97f` — 2026-07-12 15:57:10 +08:00 — `update: fix claude openai effort converts`
- `56b91a6` — 2026-07-12 18:14:49 +08:00 — `update: refactor of documents folder`
- `4419da4` — 2026-07-12 20:35:00 +08:00 — `fix: make phase one state updates reliable`
- `27090b9` — 2026-07-13 — `fix: preserve async agent terminal state`
- `8932622` — 2026-07-13 — `docs: add tmux CLI validation skill`
- `de56c0d` — 2026-07-13 — `test: add tmux validation skill evals`

### 变更内容

#### Agent 进度、usage 与异步生命周期

- 重构 Agent progress tracker 和 token/tool-use 聚合，使 foreground、background、resume、nested agent 与 SDK task progress 使用一致的累计口径，并补齐主会话、Coordinator 和 task detail 的展示数据。
- 修复 foreground 转 background 时的执行与 UI 状态衔接，避免 continuation 重复消费 stream、重复启动 summarizer 或提前停止进度摘要；同一 agent stream 现在只启动一次 summarizer，并由最终 terminal path 负责停止。
- 完善 async agent terminal notification：completed、killed 和 failed 路径携带最终 token、tool-use 与 duration usage，notification 仅在成功入队后标记 `notified`，避免瞬时入队失败永久丢失通知。
- 将 agent 已完成后的 handoff classification、worktree cleanup 等 post-processing 失败降级为可见 warning，不再把已经完成的任务反转为 failed，也不向用户泄露内部 worktree 错误路径。

#### Agent、Workflow 与 UI 状态一致性

- 修复 AgentTool foreground/background continuation、nested depth 与 task state 更新顺序，确保实际执行状态、`LocalAgentTask`、任务列表和 Coordinator 展示保持一致。
- 改进 `TaskUpdateTool` phase-one 状态更新的原子性与失败处理，避免局部更新、retry/skip 残留状态或并发更新覆盖。
- 调整 Workflow detail model、snapshot 和 dialog 状态派生，统一 running、completed、failed、skipped 等状态和最近活动展示。
- 修复插件启停失败时的 UI 回滚与 plugin operation 状态更新，避免卸载或 toggle 失败后界面与实际插件状态分裂。

#### Provider effort 路由

- 将 effort 解析按 API provider 分流：Claude 与 OpenAI compatibility 分别执行各自支持的 effort 转换，补齐 `ultra` 等级在 provider 边界的降级与映射。
- 修复 Claude/OpenAI 请求构造中的 effort conversion，避免 OpenAI 专属值进入 Claude 请求，或在兼容转换中丢失用户选择。
- 同步 SDK schema、runtime types、settings types 与测试，使 provider-specific effort 行为在 CLI、SDK 和持久化配置中保持一致。

#### 文档结构与 CLI 验收规范

- 重组 `docs/` 为 `architecture`、`design`、`guides`、`research`、`archive` 等目录，归档历史 implementation records、plans、specs 和 test plans。
- 更新根 `README.md`、`docs/README.md` 及文档内部链接，补充 Agent progress、UI state 和 provider effort 可靠性设计记录。
- 新增 `tmux-cli-workflow-validation` project skill，明确 Agent、Workflow、slash command 与 TUI 必须通过最新 `built-claude`、脚本驱动 tmux、pane/debug log 和独立证据目录完成 binary-side 验收，禁止用 parent-side 同名工具替代证据。

### 测试覆盖

- 新增或更新 `LocalAgentTask.progress.test.ts`、`AgentTool.nesting.test.ts`、`foregroundProgressUpdate.test.ts`、`foregroundBackgroundContinuation.test.ts` 和 `asyncLifecycleOrdering.test.ts`，覆盖进度累计、nested agent、foreground/background handoff、summarizer 生命周期、terminal usage 与 post-processing warning。
- 新增或更新 `TaskUpdateTool.test.ts`、`LocalWorkflowTask.test.ts`、workflow detail snapshot 测试和 Coordinator status 测试，覆盖任务状态原子更新及 UI 派生一致性。
- 新增 `ManagePlugins.toggleFailure.test.tsx`、`pluginOperations.test.ts`，覆盖插件操作失败与 UI 回滚。
- 更新 `claude-effort.test.ts`、`openai-compat.test.ts` 及 effort 相关 schema/type 测试，覆盖 provider-specific effort 转换。
- 新增 `tmux-cli-workflow-validation/evals/evals.json`，覆盖 binary-side 证据边界、并行 slash command 验收和 Workflow→Agent→notification 链路。
- 已运行 `bun test src/tools/AgentTool/asyncLifecycleOrdering.test.ts src/tools/AgentTool/foregroundBackgroundContinuation.test.ts`，两个测试脚本均通过。
- 已运行 `bun run lint`、`git diff --cached --check` 和 `make build`，均通过；构建产物为 `./built-claude`。

## 2026-07-09 - v2.1.178 - Workflow official parity、OpenAI 兼容与发布准备

### 版本状态

- 准备发布版本：`v2.1.178`。
- 当前分支：`workflow-enhancement`。
- 本次发布覆盖 `v2.1.177` 后的提交：`6bee16b`、`0bca872`、`c4b9f7a`、`899769a`、`b5894b0`、`8f8cd56`、`359c7ec`、`0d0866a`、`9d60555`、`d44e93e`、`67640a2`、`c4daef4`、`69358a1`、`fbea91d`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.178`。

### 关联提交

- `6bee16b` — 2026-07-06 01:40:05 +08:00 — `update: add agent no isolation and openai fix`
- `0bca872` — 2026-07-06 20:56:59 +08:00 — `update: improve workflow ultracode UX`
- `c4b9f7a` — 2026-07-07 00:41:43 +08:00 — `update: no pr Claude Code co Author`
- `899769a` — 2026-07-07 09:59:25 +08:00 — `update: align workflow runtime parity`
- `b5894b0` — 2026-07-07 14:38:23 +08:00 — `update workflow runtime resume parity`
- `8f8cd56` — 2026-07-07 16:06:13 +08:00 — `fix: align bundled workflow resume prompts`
- `359c7ec` — 2026-07-07 19:22:25 +08:00 — `fix: resume named workflow plans`
- `0d0866a` — 2026-07-07 20:54:12 +08:00 — `fix: print workflow completion output`
- `9d60555` — 2026-07-08 23:04:30 +08:00 — `update: official workflow impl`
- `d44e93e` — 2026-07-09 01:14:38 +08:00 — `fix: align workflow runtime parity`
- `67640a2` — 2026-07-09 01:17:36 +08:00 — `docs: update changelog since v2.1.177`
- `c4daef4` — 2026-07-09 12:27:02 +08:00 — `fix: keep workflow skip state consistent`
- `69358a1` — 2026-07-09 13:12:21 +08:00 — `docs: design workflow script meta parser parity`
- `fbea91d` — 2026-07-09 13:20:35 +08:00 — `fix: align workflow script meta parser`

### 变更内容

#### OpenAI compatibility 与 Agent/attribution 行为

- 修复 OpenAI compatibility 路径，补充 OpenAI compat 测试覆盖，确保相关请求/兼容处理在 OpenAI provider 下保持正确行为。
- 调整 AgentTool prompt/schema 中 isolation 相关提示，明确不需要隔离时不要传 `isolation`，避免 named agent / teammate routing 被错误导向 worktree subagent。
- 调整 attribution 设置字段与测试，移除 PR 场景中的 Claude Code co-author 相关默认表述。

#### Workflow ultracode UX 与任务状态展示

- 新增 workflow ultracode UX 改进计划文档，并更新既有 ultracode orchestration UX design。
- 改进 prompt input / ultracode orchestration 提示与消息处理，使 workflow/orchestration 模式的执行边界和用户提示更明确。
- 扩展 `LocalWorkflowTask` 与 workflow status formatting，展示 live agent、running/skipped/failed/completed 统计、recent activities 与 concurrency blocked 信息。
- 更新 WorkflowTool / WorkflowFacadeTool 相关测试和行为，配合 ultracode workflow UX 与 task detail 展示。
- 调整 OpenAI compatibility 测试与 ultracode orchestration 测试，覆盖 workflow/ultracode 的 prompt 和 routing 行为。

#### Workflow runtime resume parity

- 新增 workflow runtime parity 设计、规格与测试计划文档，明确 workflow resume cache、journal、session state、task list UI 与 binary-side 行为目标。
- 扩展 `LocalWorkflowTask` 状态模型，记录 workflow run id、script path、run args、events、results、agent controllers、live agent progress、pause/kill/resume 相关状态。
- 引入 workflow journal、resume cache、run sessions 与 feature flags，支持 completed agent 结果恢复、session 进度持久化、paused/killed/imported run 状态读取。
- 扩展 `WorkflowTool` / `WorkflowFacadeTool` 的 run/status/pause/resume 路径，支持 resumeFromRunId、named workflow resume prompt 与 bundled workflow resume prompt。
- 改进 declarative 和 script workflow runtime：记录 agent progress、completion output file、SDK task progress/terminated event、workflow notification，并在 foreground/background 执行路径保持一致。
- 修复 named/bundled workflow pause 后 resume prompt 格式，使 `/workflows` 和 task detail 中展示的恢复调用可直接复用。
- 修复 workflow completion output 打印与 notification，确保完成后输出文件和 inline notification 中包含 workflow result 摘要。
- 调整 WorkflowDetailDialog snapshot、formatWorkflowStatus、task list summary 等 UI 展示，使 running/paused/completed/failed/skipped 状态和 recent activities 更清晰。

#### Workflow official parity 收束

- 新增 official workflow parity 修复计划，整理 workflow script VM、agent resume cache、journal recovery、skip/retry、session persistence、task notification 与 official run import 的兼容修复路径。
- 对齐 workflow script VM 注入方式，使用 null-prototype sandbox 与 `codeGeneration` 限制，并通过显式 global 注入提供 `agent`、`parallel`、`pipeline`、`workflow`、`phase`、`log`、`budget` 和 `args`。
- 引入 script agent chain identity 与 ordered journal cursor，避免重复相同 prompt 或插入新 agent 后错误复用旧缓存。
- 增强 workflow journal JSONL 容错读取，跳过 malformed line，同时保留可恢复的 completed result。
- 对齐 workflow agent skip/retry abort reason，新增 `user-retry` / `user-skip` 常量与脚本 runtime retry/skip 行为。
- 完善 workflow run session persistence、`resumeFromRunId` 传递、official paused/killed 状态导入和 task notification XML escaping/truncation。
- 对齐 declarative workflow plan runtime 的 `user-skip` 行为：用户 skip agent 时不再将 phase/workflow 误判为失败，而是记录 `skipped` result 并允许 workflow 正常完成。
- 修复 `LocalWorkflowTask` skipped/retry 状态记录：`skipWorkflowAgent()` 现在按 logical index 清理旧 failed/result 状态并同步写入 task-level `results`，避免 UI/session 只在 phase 内看到 skipped 状态或 retry 后残留 failed 状态。
- 强化 workflow script VM：main/child official-script runtime 均禁用 string 和 WebAssembly code generation，并在 child runtime 中显式阻断 `eval` / `Function`。
- 强化 workflow script dry-run loader：official-script loader 同步禁用 string/wasm codegen 和 `eval` / `Function`，避免 child workflow 在加载阶段绕过运行时 VM 限制。
- 修复 script result 完成顺序：先序列化/校验 workflow script 返回值，再标记 task/session completed，避免 `BigInt` 等不可序列化结果导致 task completed 但 session failed 的状态分裂。
- 新增 workflow script meta parser 官方兼容性设计与实现计划，明确以 Claude Code `2.1.201` recovered parser 行为为对齐目标。
- 重写 workflow script `meta` 提取逻辑：改为 full-script Acorn module parse，要求首个 AST statement 为 `export const meta = { ... }`，并从完整 export declaration 之后截取 `scriptBody`。
- 对齐官方 `meta` literal 提取与 normalization 规则：仅允许纯 literal AST，拒绝 computed key、spread、sparse array、method/accessor、template interpolation、unary plus 与 reserved keys；`phases` 改为官方 loose filtering，非数组或无效条目会被忽略。

### 测试覆盖

- 新增/更新 `src/services/api/openai-compat.test.ts`，覆盖 OpenAI compatibility 修复。
- 新增/更新 `formatWorkflowStatus.test.ts`、`WorkflowFacadeTool.test.ts`、`WorkflowTool.test.ts`、`workflowScriptRuntime.test.ts`、`ultracodeOrchestration.test.ts`、`attribution.test.ts`、`workflowJournal.test.ts`、`workflowRunSessions.test.ts`、`workflowFeatureFlags.test.ts`、`runWorkflow.test.ts`、`LocalWorkflowTask.test.ts`、`src/tools/WorkflowTool/workflowScriptParser.test.ts` 等 workflow / OpenAI / AgentTool 相关测试。
- `workflowScriptParser.test.ts` 覆盖 official-style first statement 限制、pure literal 规则、scriptBody 截取、top-level await/return 与 loose `phases` normalization。
- `runWorkflow.test.ts` 覆盖 plan runtime `user-skip` 应完成 workflow 并记录 skipped result，以及 failed retry 后 user-skip 不残留 failed 状态。
- `workflowScriptRuntime.test.ts` 覆盖 child workflow VM codegen 限制与不可序列化 script result 的 failed 状态一致性。
- 已运行 focused AgentTool suite、`bun run lint`、`git diff --check`、`make build`，并完成 `built-claude` binary-side TeamCreate / Agent / SendMessage coordination smoke。
- 已运行 `bun test src/tools/WorkflowTool/runWorkflow.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowScriptRuntime.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowScriptParser.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowDsl.test.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts src/tools/WorkflowTool/WorkflowTool.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool`，结果 `0 fail`。
- 已运行 `bun test src/tools/WorkflowTool src/tasks/LocalWorkflowTask`，结果 `35 pass, 0 fail`。
- 已运行 `bun test src --isolate --path-ignore-patterns 'dist/**'`，结果 `140 pass, 0 fail`。
- 已运行 `make build` 生成 `./built-claude`，并完成 binary-side 交互验证：`deep-research` 完整完成 `25/25 agents`，`code-review` 在 clean diff 下正常完成并返回 `No changes found to review`。

## 2026-07-05 - v2.1.177 - AgentTool recover parity、goal 恢复与调试能力补齐

### 版本状态

- 准备发布版本：`v2.1.177`。
- 本次发布覆盖 `v2.1.176` 后的提交：`9103c69`、`004684c`、`25a2a25`、`8db03fa`、`d0fd6cf`、`fe737f3`、`0870f3d`、`f278a93`、`14424d7`、`909a5aa`、`af2bd7b`、`e2e22e0`、`4582129`、`1dfa5e3`、`f2b524e`、`ffd28d9`、`e37edc7`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `9103c69` — 2026-07-04 17:03:24 +08:00 — `update: CN claude debug skill`
- `004684c` — 2026-07-04 17:22:55 +08:00 — `update: add feature testing reference`
- `25a2a25` — 2026-07-04 17:23:13 +08:00 — `update: add goal auto-clear support`
- `8db03fa` — 2026-07-04 17:52:56 +08:00 — `update: goal clear problem with prompt  as stop hook type`
- `d0fd6cf` — 2026-07-04 21:13:41 +08:00 — `docs: add agent upgrade design spec`
- `fe737f3` — 2026-07-04 21:31:41 +08:00 — `docs: add agent upgrade integrity gates`
- `0870f3d` — 2026-07-05 01:58:21 +08:00 — `update: cc recovered in 2.1.201`
- `f278a93` — 2026-07-05 13:12:43 +08:00 — `update: Agent tool plans`
- `14424d7` — 2026-07-05 13:45:28 +08:00 — `update: run Agents tools`
- `909a5aa` — 2026-07-05 14:17:18 +08:00 — `update: wrong run teammate mode`
- `af2bd7b` — 2026-07-05 16:38:39 +08:00 — `update: download official`
- `e2e22e0` — 2026-07-05 18:08:16 +08:00 — `update: appState with team`
- `4582129` — 2026-07-05 20:23:15 +08:00 — `update: add spec ultra code`
- `1dfa5e3` — 2026-07-05 22:02:05 +08:00 — `update: more clear spwan`
- `f2b524e` — 2026-07-05 22:20:21 +08:00 — `update: agent tool prompt`
- `ffd28d9` — 2026-07-05 22:40:33 +08:00 — `update: broderTitle uiName change to customed`
- `e37edc7` — 2026-07-05 23:15:56 +08:00 — `update: add uiname test`

### 变更内容

- 补充 Claude 调试技能中文流程与 feature testing 参考，明确 assistant-side / binary-side 分层、交互式验证、非交互式验证和代理流量调试证据要求。
- 新增 `/goal` 自动清理和 compact/session restore 相关恢复逻辑，确保 goal 状态、StopHook 和 slash command 结果在会话压缩、恢复与清理路径中保持一致。
- 引入 Claude Code `2.1.201` recover 产物作为 AgentTool 对齐参考，并补充 Agent upgrade design spec、integrity gates、recover parity 和 runAgent 参数生命周期计划文档。
- 重构 AgentTool agent type 解析、MCP 可用性检查、async lifecycle ordering 和 launch params 处理，补齐相关单元测试，降低 prompt/schema/工具状态变化对 Agent 启动路径的影响。
- 对齐 recover 201 的 AgentTool -> runAgent 参数消费：保留 `name`、`toolUseId`、`spawnDepth` 等 metadata，整理 `mode`/permission 语义、async progress payload 和 debug launch 参数。
- 整理 TeamCreate / Agent / SendMessage 协作路径：区分当前 caller 是否为 teammate 与当前 Agent 调用是否应 spawn teammate，补齐 in-process teammate background 限制和 missing team file 预检。
- 调整 AgentTool prompt/schema 中 `name`、`team_name`、`isolation` 描述，贴近 recover 201 行为，并明确 `isolation: "worktree"` 与 teammate spawn routing 的分支关系。
- 更新 AppState team context、process slash command/session restore 相关链路，为 team context 与 goal restore 协同提供状态承载。
- 调整 LogoV2 `uiName` / border title 展示，并新增 `uiName` 测试覆盖。
- 更新 `Makefile` 默认构建版本到 `2.1.177`。

### 测试覆盖

- 新增或更新 `src/commands/goal.test.ts`，覆盖 goal 自动清理、StopHook 和恢复路径。
- 新增或更新 `src/tools/AgentTool/agentTypeResolver.test.ts`、`agentLaunchParams.test.ts`、`agentProgressPayload.test.ts`、`asyncLifecycleOrdering.test.ts`、`mcpAvailability.test.ts` 和 `AgentTool.nesting.test.ts`，覆盖 AgentTool recover parity、metadata、MCP 可用性、async 生命周期和 teammate 限制。
- 新增 `src/tools/shared/spawnMultiAgent.test.ts`，覆盖 missing team file 在副作用前失败的路径。
- 新增 `src/components/LogoV2/uiName.test.ts`，覆盖自定义 UI 名称展示。
- 已运行 focused AgentTool suite、`bun run lint`、`git diff --check`、`make build`，并完成 `built-claude` binary-side TeamCreate / Agent / SendMessage coordination smoke；binary-side 验证确认当前 named Agent 若带 `isolation:\"worktree\"` 会按 recover 201 语义走普通 worktree subagent 分支而非 teammate spawn。

## 2026-07-02 - v2.1.176 - OpenAI auth 环境变量、发布构建与 npm 包装

### 版本状态

- 准备发布版本：`v2.1.176`。
- 本次发布覆盖 `v2.1.175` 后的提交：`b1203ec`、`f2950bd`、`3731b11`、`7ef23b5`、`bc613db`、`430ff83`、`ce0ac0b`、`33ab36c`、`05ee2e9`、`74525a6`、`93de121`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `b1203ec` — 2026-06-30 12:44:13 +08:00 — `fix: serialize release workflow runs`
- `f2950bd` — 2026-06-30 12:48:12 +08:00 — `Revert "fix: serialize release workflow runs"`
- `3731b11` — 2026-06-30 18:09:19 +08:00 — `update: add create team agent restriction in prompt`
- `7ef23b5` — 2026-06-30 19:46:47 +08:00 — `Revert "update: add create team agent restriction in prompt"`
- `bc613db` — 2026-06-30 23:48:07 +08:00 — `update: remove bun build cache`
- `430ff83` — 2026-07-01 02:02:40 +08:00 — `update: production build`
- `ce0ac0b` — 2026-07-01 16:34:45 +08:00 — `update: test with 666 version`
- `33ab36c` — 2026-07-01 17:20:51 +08:00 — `update: update upstream as @esonhugh/claude-code`
- `05ee2e9` — 2026-07-01 18:11:51 +08:00 — `update: native to npm download`
- `74525a6` — 2026-07-02 00:45:12 +08:00 — `update: add reset button and status line with Openai account`
- `93de121` — 2026-07-02 01:13:34 +08:00 — `update: multi alias about openai api keys`

### 变更内容

- 调整 release workflow：在 tag 发布时执行 source checks、创建 GitHub Release、跨平台构建 binary、上传 release artifact、生成校验和，并准备/发布 binary-only npm package。
- 移除发布流程中的 Bun build cache 依赖，避免缓存状态影响 release 构建可复现性。
- 保持源码 `package.json` 版本为 `0.0.0-dev`，发布版本由 `v2.1.176` tag 注入到 `CLAUDE_CODE_VERSION`。
- 更新包名与 npm 下载链路为 `@esonhugh/claude-code`，并沿用 release workflow 生成平台包与主 launcher 包。
- 增加 OpenAI account status line 信息与 reset 按钮相关 UI 支持，便于查看和重置 OpenAI 登录状态。
- 调整 OpenAI auth 环境变量读取：`OPENAI_AUTH_TOKEN` 作为 auth token 入口，`OPENAI_API_KEY` 可覆盖 `~/.codex/auth.json` 中的 API key，随后再回退到本地 Codex 风格 auth 文件或 ChatGPT OAuth tokens。

### 测试覆盖

- 已运行 `bun src/utils/openai-auth-env.test.ts`，覆盖 `OPENAI_AUTH_TOKEN` 与 `OPENAI_API_KEY` 环境变量优先级。
- 已运行 `bun src/interactiveHelpers.openai-auth.test.ts`、`bun src/services/openai-oauth/refresh.test.ts`、`bun src/services/api/openai-refresh-client.test.ts`、`bun src/services/openai-oauth/storage.test.ts`、`bun src/services/api/openai-missing-auth.test.ts`，覆盖 OpenAI 自动登录、refresh、存储和缺失凭证提示路径。
- 发布前按 `.github/workflows/release.yml` 本地执行 source checks 与当前平台 build/package 验证。

## 2026-06-29 - v2.1.175 - bundled skills、WorkflowTool、goal/compact 与交互验证

### 版本状态

- 准备发布版本：`v2.1.175`。
- 本次发布覆盖 `v2.1.174` 后的提交：`32629b6`、`f5b9d42`、`8669631`、`4516ace`、`3c0a085`、`b770b78`、`4c6764e`、`0fdfe5f`，以及本次重新打 tag 前补充的 WorkflowTool AST parser 改动。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `32629b6` — 2026-06-29 00:36:52 +08:00 — `update: add bundle skill with workflows and interactive terminals`
- `f5b9d42` — 2026-06-29 01:55:36 +08:00 — `update: git ignores folder to correct`
- `8669631` — 2026-06-29 10:22:43 +08:00 — `stash: goal keeper after compact and interactive terminal + workflow prompt commit`
- `4516ace` — 2026-06-29 13:37:13 +08:00 — `update: fix hook failure in goal`
- `3c0a085` — 2026-06-29 15:16:45 +08:00 — `update: fix bug of compact with skill goal restored.`
- `b770b78` — 2026-06-29 19:37:08 +08:00 — `stash: update workflow tool fix`
- `4c6764e` — 2026-06-29 21:17:20 +08:00 — `update: optional run agent tool`
- `0fdfe5f` — 2026-06-29 23:10:31 +08:00 — `update: add tests and complete with lint / type fix`

### 变更内容

- 新增 bundled model-internal skills 注册链路，将 `interactive-terminal` 作为非用户直接调用的隐藏 skill 注入模型上下文，指导模型在多轮持久终端场景使用 `InteractiveTerminal`，在一次性 shell 或文件读取场景避免误用。
- 扩展 WorkflowTool 与系统提示，明确 `list`、`show`、`dry-run`、`run`、`status`、`pause`、`resume` 的使用边界；`run` 保持显式 opt-in，不由 `/workflows` 展示 UI 静默触发。
- 调整 `/workflows` 相关文档与 UI 行为定位，保持其作为动态 workflow 展示/管理入口，实际执行由独立 WorkflowTool/skill 路径承接。
- 新增 `/goal` 会话目标保持能力，并在 StatusLine 中展示 active goal；`/goal clear` 会清理 active goal 并注销对应 StopHook，避免清理后继续触发 stale verifier。
- 修复 compact 后 goal 与已触发 skill 上下文恢复问题，compact 流程会恢复 active goal 和必要 skill attachment，同时避免重复或陈旧 attachment 干扰可见消息。
- 调整 StopHook、attachment/null-rendering message、process user input/slash command、AppStateStore 等链路，配合 goal、compact、workflow 和 bundled skill 的会话态传递。
- 为 Agent tool prompt 增加可选 background agent 指引，区分需要即时结果的 foreground agent 与可异步执行的 background agent。
- 调整 `.gitignore` 与 `.claude/.gitignore`，避免本地 Claude 配置、缓存或验证产物误入版本控制。
- 新增 post-`v2.1.174` 交互式验证计划，按 `/claude-debug` 风格区分 assistant-side 与 binary-side，并覆盖 hidden skill、WorkflowTool、`/workflows`、`/goal`、`/compact`、background agent 与 `/loop` disable path。
- 修复 `src/commands/goal.test.ts` 中测试 mock context 使用 `never` 导致 `tsc --noEmit` 失败的问题，改为最小 `ToolUseContext` 结构。
- 将 workflow script meta 解析从正则前缀、手写对象边界扫描和 `Function` literal eval 改为基于 `acorn` 的轻量 parser；只解析 `export const meta` 的 literal object，不解析后续 workflow DSL body，并显式拒绝 spread、computed key、function、accessor、shorthand property、template interpolation 与 TypeScript 注解，避免 release ESM bundle 静态引入 `typescript`。

### 测试覆盖

- 新增或更新 `src/skills/bundled/modelInternalSkills.test.ts`、`src/tools/WorkflowTool/WorkflowTool.test.ts`、`src/services/compact/goalAttachment.test.ts`、`src/commands/goal.test.ts`、`src/commands/workflows/workflowsPage.behavior.test.ts`，覆盖 bundled hidden skills、WorkflowTool 行为、goal/compact attachment 恢复和 `/goal clear` StopHook 清理。
- 更新 `src/utils/processUserInput.processUserInput.test.ts`、`src/utils/ultracodeOrchestration.test.ts` 等相关测试，覆盖 prompt/slash command 与 workflow/orchestration 输入处理边界。
- 已运行 `bun test src/skills/bundled/modelInternalSkills.test.ts`、`bun test src/tools/WorkflowTool/WorkflowTool.test.ts`、`bun test src/services/compact/goalAttachment.test.ts`、`bun test src/commands/goal.test.ts`、`bun test src/tools/InteractiveTerminalTool/handlers/read.test.ts`、`bun test src/services/api/claude-effort.test.ts`、`bun test scripts/build.test.mjs`。
- 已运行 `bunx tsc --noEmit`、`bun run lint` 和 `make build`，均通过。
- 已运行 `bun test src/tools/WorkflowTool/workflowScriptParser.test.ts` 和 `bun test src/tools/WorkflowTool/WorkflowTool.test.ts`，覆盖轻量 meta parser 与 WorkflowTool official-script 路由。
- 已完成 `docs/test-plan/2026-06-29-post-v2.1.174-interactive-validation.md` 中的 binary-side 交互验证：`interactive-terminal` hidden skill 正反 prompt、WorkflowTool no-run/dry-run、`/workflows` display UI、`/goal clear`、`/compact` goal restore、background Agent prompt、默认 `/loop` 与 `CLAUDE_CODE_DISABLE_CRON=1` disable path。
- 已用 `built-claude --dangerously-skip-permissions --debug` 真实执行 `WorkflowTool(action=run)` smoke：`code-review` 完成，`deep-research` 已进入多阶段 agent 执行并推进到 fetch 阶段。
- 已运行 `bun run start --help` 复现 release CI 的 `Verify CLI help` 入口，确认轻量 parser 不再触发 `typescript` 包在 ESM dist 中访问 `__filename` 的启动失败。

## 2026-06-28 - v2.1.174 - CCH attestation、Claude 调试技能与终端读取压缩

### 版本状态

- 准备发布版本：`v2.1.174`。
- 本次发布覆盖 `v2.1.173` 后的提交：`f09eb15`、`7441b88`、`a89049c`、`abcb1fe`、`18b7fd0`、`771659e`、`c075e9c`、`352e71c`、`0e227b9`、`e812c5e`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `f09eb15` — 2026-06-27 23:03:11 +08:00 — `update: log autocompact mode`
- `7441b88` — 2026-06-27 23:28:05 +08:00 — `update: auto remove cache in 1 days after release`
- `a89049c` — 2026-06-28 00:04:08 +08:00 — `update: remove debugging skill to a new skill`
- `abcb1fe` — 2026-06-28 00:22:24 +08:00 — `update: skills for debugging with AI API with http PROXY`
- `18b7fd0` — 2026-06-28 09:37:56 +08:00 — `update: proxy debugging traffic`
- `771659e` — 2026-06-28 12:27:52 +08:00 — `update: proxy to debug the cch problem`
- `c075e9c` — 2026-06-28 13:09:35 +08:00 — `update: correct activiate the CCH checksums in new claude code cli`
- `352e71c` — 2026-06-28 15:30:08 +08:00 — `update: debug scripts`
- `0e227b9` — 2026-06-28 15:35:39 +08:00 — `update: default send high effortlevel in query`
- `e812c5e` — 2026-06-28 18:35:42 +08:00 — `update: read terminal with tool compressed`

### 变更内容

- 新增本地 CCH attestation 计算与请求体 patch 逻辑，在 first-party provider 请求中将 `x-anthropic-billing-header` 的 `cch=00000` 占位替换为按请求体规范化后计算出的 5 位 hex checksum。
- 扩展 attribution header / first-party base URL 判定：支持 `CLAUDE_CODE_ATTRIBUTION_HEADER` 强制开启，支持 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` 将自定义 base URL 视为 first-party 调试目标。
- 调整默认 effort 行为：first-party provider 且未显式指定 effort 时默认发送 `output_config.effort = high` 并附带 effort beta header；OpenAI 与 Bedrock 路径不套用该默认值。
- 新增 `claude-debug` skill，将 tmux/InteractiveTerminal、`--print`、`--debug-file`、HTTP_PROXY/HTTPS_PROXY、SSE/WebSocket、透明代理与 MITM/CCH 请求调试流程从 `claude-analysis` 中拆出，明确源码/二进制分析与运行时调试的边界。
- 调整 `buildFetch` 请求处理，使 CCH patch 与 `x-client-request-id` 注入都仅在 first-party provider 路径启用；OpenAI、Bedrock、Vertex、Foundry 等 provider 不发送或修改相关 first-party 请求信息。

- 新增 Claude 调试脚本与参考文档，包括透明 HTTP/HTTPS proxy、MITM CCH runner、CCH summary 生成与测试脚本，用于对比 `official-claude` 与 `built-claude` 的请求形态、代理链路和 checksum 行为。
- 新增 CCH 请求形态 parity 报告、CCH checksum attestation 设计/实施计划，以及 InteractiveTerminal 输出压缩设计/实施计划文档。
- 调整 GitHub release artifact 保留策略，将 release 上传 artifact 的 `retention-days` 设置为 1 天。
- 在 auto compact 执行前记录当前 compact mode，便于区分 codex/native compact 路径的调试日志。
- 扩展 InteractiveTerminal `read` action：默认使用 `compact` 模式，支持 `full` 和 `save_file` 模式，并新增 `maxLines`、`maxLineChars`、`previewBytes` 控制项。
- 新增 InteractiveTerminal 读取输出压缩：折叠重复行与空行块、截断超长行、保留首尾上下文、按 UTF-8 字节安全截断，并返回压缩状态、原始/返回字节数、省略行数和省略字符数。
- 新增 `save_file` 读取模式，将完整终端快照写入工具结果目录并返回 compact preview，避免大段终端输出直接塞入工具结果。
- 将 recovered build 的 `AGENT_TRIGGERS` 设为默认 feature，使 `CronCreate`、`CronDelete`、`CronList` 及本地 scheduled tasks/`/loop` 相关链路默认进入构建产物；运行时仍可通过 `CLAUDE_CODE_DISABLE_CRON` 或 `tengu_kairos_cron` kill switch 关闭。

### 测试覆盖

- 新增或更新 `src/constants/system.test.ts`、`src/services/api/cchAttestation.test.ts`、`src/services/api/cchFetch.test.ts`、`src/services/api/claude-effort.test.ts`，覆盖 attribution header、CCH checksum/filter/patch、first-party fetch patch 边界和默认 effort 行为。
- 新增或更新 `src/tools/InteractiveTerminalTool/handlers/read.test.ts`、`src/tools/InteractiveTerminalTool/InteractiveTerminalTool.test.ts`、`src/tools/InteractiveTerminalTool/UI.test.ts`，覆盖 compact/full/save_file 读取模式、UTF-8 安全截断、重复输出压缩和 schema 默认值。
- 新增 `claude-debug` MITM CCH summary 脚本测试，覆盖调试摘要生成逻辑。

## 2026-06-26 - v2.1.173 - OpenAI device code 登录、compact 支持与提示/技能整理

### 版本状态

- 准备发布版本：`v2.1.173`。
- 本次发布覆盖 `v2.1.172` 后的提交：`54879b1`、`9eec95f`、`5b0f2cf`、`a3b6eb5`、`d349f92`、`8231132`、`2e6d153`、`ccaec8d`、`819e6b6`、`72f78dc`、`5af9c3e`、`2a88473`、`fbaf22c`、`6ab3024`、`f8c0839`、`3163c47`、`7109855`、`ab0b49a`、`cd3fd94`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `54879b1` — 2026-06-22 00:19:40 +08:00 — `update: fix bug of effort level changes`
- `9eec95f` — 2026-06-23 02:39:44 +08:00 — `update: init auto compact`
- `5b0f2cf` — 2026-06-23 12:24:04 +08:00 — `update: ignore preflight check`
- `a3b6eb5` — 2026-06-23 12:29:31 +08:00 — `rollback: no block preflight check`
- `d349f92` — 2026-06-24 16:57:17 +08:00 — `update: retry OpenAI responses on server errors`
- `8231132` — 2026-06-24 17:03:45 +08:00 — `update: expand thinking beta model support`
- `2e6d153` — 2026-06-24 17:06:11 +08:00 — `update: add extractor in native and compact compare mem`
- `ccaec8d` — 2026-06-24 17:49:37 +08:00 — `update: claude code beta header CCH checksum`
- `819e6b6` — 2026-06-24 17:58:31 +08:00 — `update: auto download official claude`
- `72f78dc` — 2026-06-25 12:47:33 +08:00 — `update: no cyber risk`
- `5af9c3e` — 2026-06-25 12:50:45 +08:00 — `update: reuse the browser open`
- `2a88473` — 2026-06-25 14:29:34 +08:00 — `update: fix bug of code-review`
- `fbaf22c` — 2026-06-25 16:58:56 +08:00 — `update: skill design`
- `6ab3024` — 2026-06-25 17:00:45 +08:00 — `update: file location`
- `f8c0839` — 2026-06-25 17:15:42 +08:00 — `update: remove the shit skills`
- `3163c47` — 2026-06-25 20:28:53 +08:00 — `update: remove evals`
- `7109855` — 2026-06-25 23:35:58 +08:00 — `update: create skills for analysis claude`
- `ab0b49a` — 2026-06-25 23:53:08 +08:00 — `update: other prompt file content`
- `cd3fd94` — 2026-06-26 00:18:13 +08:00 — `update: correctly device code login mode in openai`

### 变更内容

- 新增 OpenAI/Codex device code 登录模式，在 `CLAUDE_CODE_USE_OPENAI=1` 且缺少凭证时可自动进入 OpenAI 登录选择，并支持通过 `https://auth.openai.com/codex/device` 输入一次性 code 完成登录。
- OpenAI device code 登录复用既有 OAuth token exchange、代理配置和 `~/.codex/auth.json` 存储路径；device code 请求与 token 轮询支持取消、超时和错误状态提示。
- 修复 OpenAI effort level 切换相关问题，并扩展 thinking beta model 支持范围。
- 增加 OpenAI Responses API 服务端错误重试，提升 OpenAI backend 临时错误下的请求稳定性。
- 新增/调整 auto compact、native compact 对比与 memory extractor 相关逻辑，支持 compact 行为分析与对照。
- 调整 WebFetch preflight 相关行为：尝试忽略 preflight 后回滚阻塞式 preflight 检查，避免不必要阻断。
- 增加官方 Claude 下载入口，便于本地 parity 验证使用固定来源的 `official-claude`。
- 调整 Claude Code beta header / CCH checksum 相关逻辑。
- 整理提示词、技能设计和技能文件位置，新增用于 Claude 分析的技能，移除不再需要的 evals 与无关技能内容。
- 复用已有 browser open 能力，避免重复实现浏览器打开路径。
- 修复 code-review 相关 bug，并补充 cyber risk 相关约束说明。

### 测试覆盖

- 新增或更新 OpenAI device code 登录服务和 UI 测试，覆盖 user code 请求、polling、完整登录、取消、错误路径和 `/login` device code 选项展示。
- 已运行 OpenAI OAuth service/UI 目标测试、登录可用性/退出/取消副作用测试，并执行 `make build` 验证本地产物。
- 已进行本地交互式 device code 登录验证：备份并删除原 `~/.codex/auth.json` 后，使用 `CLAUDE_CODE_USE_OPENAI=1 HTTPS_PROXY=http://127.0.0.1:7890 ./built-claude --dangerously-skip-permissions` 自动进入 OpenAI 登录，完成 device code 授权并确认 `~/.codex/auth.json` 以 `0600` 权限写入 `auth_mode: chatgpt` 与 token 字段。

## 2026-06-21 - v2.1.172 - OpenAI OAuth 登录、refresh 与 effort 兼容适配

### 版本状态

- 发布版本：`v2.1.172`。
- `package.json` 保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `9550411` — 2026-06-21 01:20:51 +08:00 — `update: basic impl for openai OAUTH workflow`
- `1fb2d5e` — 2026-06-21 02:11:07 +08:00 — `update: better login and copy`
- `d9cf837` — 2026-06-21 03:10:12 +08:00 — `update: OAuth better output and auth storage`
- `38d4e81` — 2026-06-21 13:23:39 +08:00 — `update: onExit or Cancel side effects`
- `89318e8` — 2026-06-21 14:56:34 +08:00 — `update: add APIKEY feature to use openai API`
- `3e1fe1b` — 2026-06-21 17:19:28 +08:00 — `update: CLAUDE.md to guide claude code`
- `b9216e7` — 2026-06-21 17:23:15 +08:00 — `update: skipWebFetchPreflight only work when it is false`
- `2b977f4` — 2026-06-21 17:44:34 +08:00 — `update: Uppercase first in favorite scope`
- `4547322` — 2026-06-21 20:24:50 +08:00 — `update: add access token refresher`
- `5429067` — 2026-06-21 20:47:47 +08:00 — `update: add effort level`

### 变更内容

- 新增 OpenAI OAuth 登录主流程，在 `CLAUDE_CODE_USE_OPENAI=1` 时将 `/login` 和启动引导切换到 OpenAI 登录体验。
- 新增 OpenAI OAuth PKCE 授权链路：本地 callback listener、授权 URL 构造、code exchange、浏览器打开、剪贴板复制和登录结果提示。
- 新增 `OpenAIOAuthFlow` 登录 UI，支持选择 ChatGPT OAuth、OpenAI API key 或退出；取消/退出时不会执行登录成功副作用。
- 新增 OpenAI auth 存储，兼容 Codex 风格 `~/.codex/auth.json`，支持 `auth_mode: "chatgpt"` tokens 与 `OPENAI_API_KEY` 两种模式。
- 新增 OpenAI auth 自动检测：启动时在 OpenAI provider 且缺少凭证时展示 OpenAI 登录流程，并补齐缺失凭证时的提示测试。
- 新增 OpenAI-compatible API client，将 Anthropic SDK 消息流适配到 OpenAI Responses API / ChatGPT Codex backend SSE。
- 新增 OpenAI auth 读取能力，支持从 `OPENAI_AUTH_TOKEN`、`~/.codex/auth.json` 的 `OPENAI_API_KEY` 或 ChatGPT OAuth tokens 解析 OpenAI 凭证。
- 新增 OpenAI OAuth token refresh 支持，仅在 `CLAUDE_CODE_USE_OPENAI=1` 且本地 `~/.codex/auth.json` 为 `auth_mode: "chatgpt"`、包含 `refresh_token` 时启用。
- 在 OpenAI-compatible API client 创建前执行 OpenAI OAuth refresh 检查；API key 模式不触发 refresh。
- OpenAI OAuth refresh 触发条件：access token JWT 距过期 5 分钟内、`last_refresh` 超过 8 天，或测试显式 `force`。
- OpenAI OAuth 登录与 refresh 请求复用 `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY` 代理配置。
- 增加 OpenAI Responses API effort 兼容：将 `output_config.effort` 映射为 `reasoning.effort`。
- OpenAI effort 支持 `none`、`low`、`medium`、`high`、`xhigh`；在 OpenAI 模式下 `max` 和 `ultracode` 归并为 `xhigh`。
- `/effort` 支持 `none` 和 `xhigh`，并更新参数提示为 `[none|low|medium|high|xhigh|max|ultracode|auto]`。
- `xhigh`、`none` 保持 session-only / OpenAI-only，不写入持久 settings；非 OpenAI provider 下不作为 Anthropic `output_config.effort` 发送。
- 调整 `/login` 可用性与命令注册逻辑，确保 OpenAI provider 下使用 OpenAI 登录，不执行 Claude 专属登录后刷新逻辑。
- 调整 WebFetch preflight 开关语义，仅当 `skipWebFetchPreflight === false` 时执行域名预检。
- 调整插件 favorite scope 展示文案，将 scope 首字母大写展示。
- 更新 `CLAUDE.md` 项目协作规范，并保留 workflow parity 相关说明到 `CLAUDE-workflow.md`。
- OpenAI auth 文件读写优先使用 `process.env.HOME`，再回退到 `homedir()`，保证测试隔离与运行时行为一致。
- 增加 OpenAI OAuth 登录设计文档、实现计划和登录 UX 计划文档，记录方案与后续改进路径。

### 测试覆盖

- 新增或更新 OpenAI OAuth 登录链路测试：`client.test.ts`、`storage.test.ts`、`clipboard.test.ts`、`OpenAIOAuthFlow.cancel.test.ts`、`openai-login-availability.test.ts`、`openai-login-cancel-side-effects.test.ts`、`openai-login-exit.test.ts`。
- 新增或更新 OpenAI auth 启动与凭证测试：`interactiveHelpers.openai-auth.test.ts`、`openai-missing-auth.test.ts`、`openai-auth-env.test.ts`、`bootstrap-openai.test.ts`。
- 新增或更新 OpenAI-compatible API 与 refresh 测试：`openai-compat.test.ts`、`openai-refresh-client.test.ts`、`refresh.test.ts`。
- 新增或更新 effort 测试：`effort.test.ts`、`utils/effort.test.ts`，覆盖 `none`、`xhigh`、`max` / `ultracode` 到 OpenAI `xhigh` 的映射。
- 已运行相关 `bun` 测试、`bun run lint` 和 `make build`；并使用本地 `~/.codex/auth.json` 做脱敏读取与强制 refresh 验证。


## 2026-06-20 - v2.1.171 - 子 agent 稳定性、会话命令热重载与目标状态展示

### 版本状态

- 准备发布版本：`v2.1.171`。
- 本次发布覆盖 `v2.1.170` 后的提交：`1f25623`、`42675ff`、`c8e5c36`、`99697ec`、`01426fe`、`5ad2d59`、`a2e0d35`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `1f25623` — 2026-06-19 22:16:09 +08:00 — `add: plan and spec`
- `42675ff` — 2026-06-19 23:56:37 +08:00 — `fix: stabilize nested agents and reloadable session command`
- `c8e5c36` — 2026-06-20 02:05:37 +08:00 — `update: goal logical`
- `99697ec` — 2026-06-20 02:35:48 +08:00 — `update: fix goal clear without StopHooks`
- `01426fe` — 2026-06-20 02:37:04 +08:00 — `update: change goal set color`
- `5ad2d59` — 2026-06-20 02:56:03 +08:00 — `fix: set working directory clearly`
- `a2e0d35` — 2026-06-20 03:18:25 +08:00 — `update: reload skills`

### 变更内容

- 新增 `/cd` 会话命令和 cwd 变更工具链，支持在会话内清晰切换与展示工作目录，并让 slash command 处理流程能消费会话命令执行结果。
- 新增 `/reload-skills` 会话命令，支持运行时重载可用技能列表，并补齐 reload 后的消息提示和命令结果行为。
- 稳定嵌套 subagent 执行：增加 subagent 深度追踪、forked agent/session storage 传递和 nested agent 相关测试，避免嵌套 agent 行为失控。
- 调整 reloadable session command 与 `Tool` / `commands` 注册路径，补齐 `/cd`、`/reload-skills`、`InteractiveTerminal`、workflow runtime globals 等相关边界处理。
- 新增 `/goal` 状态栏与输入 footer 展示逻辑，重构 PromptInput footer 右侧区域，支持目标设置、清除、通知展示和 StatusLine 同步。
- 修复 `/goal clear` 不依赖 StopHooks 的路径，并调整 goal set/clear 的颜色状态展示。
- 修正 StructuredDiff 颜色处理中的边界问题，补齐对应测试。
- 新增 superpowers plan/spec 文档，记录 subagent `/cd`/`reload-skills` 与 goal statusline 设计。

### 测试覆盖

- 新增或更新 `/cd`、`/reload-skills`、`/goal`、slash command 处理、cwd change、StopHooks、StatusLine、PromptInput notifications、StructuredDiff colorDiff 相关测试。
- 新增或更新 `AgentTool` nested agent、subagent depth、forked agent/session storage、InteractiveTerminal、Workflow DSL/runtime globals 相关测试。

## 2026-06-18 - v2.1.170 - 官方插件 schema 名称兼容

### 版本状态

- 发布版本：`v2.1.170`。
- 本次发布覆盖 `v2.1.169` 后的提交：`7301267`、`2909b7c`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `7301267` — 2026-06-18 15:25:16 +08:00 — `update: bypass validate official names`
- `2909b7c` — 2026-06-18 15:32:03 +08:00 — `update: i'm official`

### 变更内容

- 调整 plugin schema 校验中的官方插件命名规则，放宽/绕过官方名称相关校验，使本地恢复项目可以识别并接受官方插件命名形态。
- 更新官方插件 schema 相关判定逻辑，避免官方插件名称在本地校验阶段被误判为无效。

### 测试覆盖

- 本条目仅涉及 plugin schema 校验逻辑调整；本次 changelog 更新未额外运行测试或构建命令。

## 2026-06-17 - v2.1.169 - OpenAI/Codex 兼容、模型列表缓存与用量展示

### 版本状态

- 发布版本：`v2.1.169`。
- 本次发布覆盖 `v2.1.168` 后的提交：`4570878`、`9c94526`、`a9c6e4f`、`ee2e991`、`797938e`、`771318e`、`d652e8c`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `4570878` — 2026-06-10 21:30:15 +08:00 — `update: add codex providers`
- `9c94526` — 2026-06-17 02:09:57 +08:00 — `update: changelogs for workflow life time`
- `a9c6e4f` — 2026-06-17 02:23:51 +08:00 — `update: fix lint and type bugs`
- `ee2e991` — 2026-06-17 20:17:00 +08:00 — `update: rebase to master and usage panel`
- `797938e` — 2026-06-17 20:46:11 +08:00 — `update: model list and cache problem`
- `771318e` — 2026-06-17 20:59:03 +08:00 — `update: learnt openai usage limit calc`
- `d652e8c` — 2026-06-17 21:01:43 +08:00 — `update: spilt usages`

### 变更内容

- 新增 OpenAI/Codex 兼容 provider 路径，补齐 OpenAI-compatible client、鉴权状态、模型字符串/provider 映射和相关状态显示。
- 增加 OpenAI-compatible 模型列表获取与缓存逻辑，修复模型列表缓存读取和 bootstrap 流程中的边界问题。
- 扩展 Settings Usage 面板，支持 Claude 与 ChatGPT/OpenAI 用量分流展示，并根据已学习的 OpenAI 用量限制规则估算状态。
- 将用量统计逻辑拆分为通用类型、Claude 用量和 ChatGPT/OpenAI 用量模块，降低 `usage.ts` 的职责集中度。
- 修复 workflow detail model、workflow command 测试、task/swarm model 相关 lint/type 问题。

### 测试覆盖

- 新增或更新 `bootstrap-openai`、`openaiModelOptions`、`usage`、`WorkflowTool` 与 workflow detail model 相关回归测试。

## 2026-06-17 - v2.1.168 - Workflow 状态生命周期与详情展示修复

### 版本状态

- 发布版本：`v2.1.168`。
- 本次发布覆盖 `378740d` 本身及其后的提交：`378740d`、`9985705`、`58c1592`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 GitHub Actions/tag 流程注入。

### 关联提交

- `378740d` — 2026-06-16 21:16:13 +08:00 — `update: fix workflow status changes and lifetime cycle`
- `9985705` — 2026-06-17 00:47:24 +08:00 — `fix: correct workflow detail terminal state display`
- `58c1592` — 2026-06-17 01:54:41 +08:00 — `update: model status changes`

### 变更内容

- 修复 workflow status 与生命周期状态传播，补齐 paused、killed、completed 等终态在 `LocalWorkflowTask`、`WorkflowTool` 和 `/workflows` 页面中的一致性处理。
- 调整 workflow 运行流程的异步持久化与 session 生命周期处理，确保 agent 完成、workflow 终止和 terminal 状态能被详情视图稳定读取。
- 移除 workflow 列表与任务弹窗中的重复状态展示，避免同一 workflow 状态在不同 UI 层级中出现冲突或冗余。
- 修正 workflow detail terminal state 渲染，确保 killed workflow 在详情对话框和 snapshot 中以一致状态显示。
- 更新 workflow detail model/snapshot 的状态派生逻辑，补齐 completed agent、outcome 可见性和 model status 展示边界场景。

### 测试覆盖

- 新增或更新 `LocalWorkflowTask`、`WorkflowTool`、`/workflows` 页面、`WorkflowDetailDialog`、`workflowDetailModel` 和 `workflowDetailSnapshot` 相关回归测试。
- 本次 changelog/tag 准备未额外运行测试或构建；相关提交已包含对应测试变更。

## 2026-06-16 - Dynamic Workflows 运行时、恢复缓存与 UI 状态对齐

### 版本状态

- `package.json` 仍为 `0.0.0-dev`，本分支未引入正式发布版本号。
- 新增 `Makefile` 本地测试入口，当前 `VERSION := 2.1.666-test`，用于通过 `bun package:binary` 生成 `built-claude` 测试二进制。
- 本分支主要围绕 Claude Code `2.1.165` Dynamic Workflows 行为做兼容性和可观测性补齐；InteractiveTerminal 仍按独立功能验收，不并入官方 workflow parity 范围。

### 关联提交

- `2f15490` — 2026-06-14 21:32:42 +08:00 — `update: Workflow JS runtime detection, error process, resume cache persistence and runArgs injections`
- `4cc7c79` — 2026-06-15 17:27:24 +08:00 — `fix: align workflow runtime phase handling and child script resolution`
- `45949fa` — 2026-06-15 19:26:03 +08:00 — `update: fix outcome oversize`
- `81cf564` — 2026-06-15 20:27:40 +08:00 — `fix: Outcomes fix`
- `06a478a` — 2026-06-16 11:10:50 +08:00 — `update: build tool for test`
- `65f3bb3` — 2026-06-16 14:49:45 +08:00 — `fix: deep research with inputs`

### 变更内容

- 增强 `Workflow` facade 和 `WorkflowTool` 输入处理，补齐 inline script、`scriptPath`、saved workflow、`runArgs` 注入、child script 解析、workflow name 解析和 deep-research 输入传递路径。
- 扩展 JavaScript workflow runtime：增加脚本识别、错误处理、resume cache 持久化、phase 调度、DSL/spec 校验、runtime globals 和 structured workflow 相关测试覆盖。
- 对齐 workflow phase 与 agent orchestration 行为，新增 `workflowPhaseScheduler`，完善 fanout/concurrency、phase dependencies、root prompt、built-in workflow metadata 和 bundled workflow 定义。
- 重构 `/workflows` 详情展示：抽出 `workflowDetailModel`，调整 snapshot 渲染、agent/outcome 状态、oversize outcome 展示、空结果处理和 coordinator agent rows。
- 新增 task 状态与保留策略工具，补齐 `taskStatus`、`retention` 及对应测试，减少 UI 和持久化状态判断分散实现。
- 新增 `Makefile` 和 `.gitignore` 调整，提供本地 `built-claude` 构建/运行快捷入口，并更新 official parity agent 说明。

### 测试覆盖

- 新增或更新 `WorkflowFacadeTool`、`WorkflowTool`、`workflowDsl`、`workflowPhaseScheduler`、`workflowRuntimeGlobals`、`workflowSpec`、`workflowCommand`、`workflowDiscovery` 相关测试。
- 新增或更新 `/workflows` 页面模型、详情 snapshot、coordinator agent status、task retention 相关测试。
- 本次 changelog 更新未额外运行测试或构建命令。

### 代码审查后续关注

- workflow code-review 已确认若干后续 correctness 风险，主要集中在并行 agent 生命周期清理、pause/kill 状态传播、run session 异步持久化顺序、schema structured output 解析、saved workflow resume cache、zero-agent workflow 持久化和 `phase()` 依赖标签一致性。
- 这些风险尚未在本条目中修复，后续应优先补最小失败测试后再做 targeted fix。

## 2026-06-14 - Bun 迁移、InteractiveTerminal PTY 替换与 binary-only npm 发布准备

### 关联提交

- 待提交 — Bun 包管理迁移、Bun PTY driver、release workflow 与 npm launcher 发布准备。

### 变更内容

- 将工作区包管理和构建入口迁移到 Bun：新增 `bun.lock`，移除 `pnpm-lock.yaml` / `pnpm-workspace.yaml`，并将构建、打包、验证文档同步为 `bun run ...` / `bunx ...` 命令。
- 用 Bun 自带 `Bun.spawn(..., { terminal })` PTY/terminal API 替换 InteractiveTerminal 的 `node-pty` 后端，删除 `node-pty` 依赖、旧 driver、旧集成测试和 node-pty native prebuild 复制逻辑，解决 standalone binary 启动时找不到 `pty.node` 的问题。
- 清理 `scripts/` 目录，保留构建/打包/缺失导入审计/本地 CLI runner 和 build shims，删除 workflow probe、compatibility、deobfuscator 和临时测试用途脚本。
- 更新 GitHub Actions release workflow：使用 Bun 1.3.14 安装、类型检查、lint、audit、build、package，并在上传 release artifacts 前验证 packaged binary 的 `--version` / `--help`。
- 准备 npm binary-only 发布流程：主包 `@esonhugh/claude-code` 是非官方 Claude Code launcher；平台/架构 binary 拆分到 optional dependency 子包（如 `@esonhugh/claude-code-darwin-arm64`），npm 包不发布本仓库源码。
- 优化 README，明确本项目不是 Anthropic 官方 Claude Code 程序或官方源码分发，而是非官方启动器/恢复开发工作区。

### 验证

- `bunx tsc --noEmit --pretty false`
- `bun run audit:missing`
- `bun run build`
- `bun run start --version` / `bun run start --help`
- `CLAUDE_CODE_VERSION=2.1.165-dev bun run package:binary`
- `./dist/release/claude-code-v2.1.165-dev-darwin-arm64 --version` / `--help`
- `bun test src/utils/pty/bunPtyDriver.integration.test.ts`
- `bun test src/utils/pty/PtySessionManager.test.ts`
- `bun pm pack --dry-run` for the current platform binary subpackage and main npm launcher package.

## 2026-06-04 - 恢复源码整理、功能扩展与文档索引

### 关联提交

- `12c8153` — `update: add sourcemap and Ink debug workflow`
- `46da60f` — 2026-06-04 12:21:46 +08:00 — `update: add autonomous goal and marketplace controls`
- `40b54bc` — 2026-06-04 12:44:34 +08:00 — `upgrade: add extra dependency`
- `01ae965` — 2026-06-04 15:51:29 +08:00 — `chore: update, eslint updating and type guards`
- `d2b5348` — 2026-06-04 15:56:02 +08:00 — `update: fix linters`

### 变更内容

- 从 Claude Code `2.1.88` 分发产物的 source map 中恢复大量 `ts` / `tsx` 可读源码，并清理残留的内联 source map payload。
- 新增本地功能扩展：`/goal` 自主目标命令、Esonhugh Marketplace 默认高优先级源、插件 favorite scope、marketplace `autoUpdate` 控制，以及 Anthropic-bound telemetry 默认关闭策略。
- 新增 ESLint flat config、`lint` / `lint:fix` 脚本，并补齐 TypeScript ESLint、React ESLint、React Hooks ESLint、React/Bun/Node 类型依赖。
- 拆分恢复声明到 `types/` 下的聚焦声明文件，减少全局 stub，并使用真实包导出的类型替代可恢复的本地伪声明。
- 修复恢复源码中的 TypeScript 类型问题，重点收紧消息、工具、任务、插件、MCP、远程日志和 SDK/recovered 边界类型。
- 将早期 CLI fast-path 分发逻辑拆出到 `src/entrypoints/fastPathDispatch.ts`，并保持 `src/entrypoints/cli.tsx` 聚焦启动初始化与主入口加载。
- 修复 Commander debug-to-stderr 选项的无效短参数注册问题，确保 CLI `--help` 正常启动。
- 重整项目文档结构：将根 `README.md` 定位为项目目的与使用指南，新增 `docs/README.md` 作为阅读索引，重写构建与二次开发手册，并将 `docs/upgrade-plan.md` 调整为历史工作说明。
- 新增 `docs/claude-code-internals-index.md`，作为 Claude Code 启动流程、REPL 查询循环、工具体系、Agent / Subagent 生命周期和 Team / Swarm 协作模型的中文索引文档。
- 新增 source map 运行与调试脚本、VS Code Node 调试配置，以及 `CLAUDE_CODE_ALLOW_INSPECTOR` 显式本地调试开关，方便定位到恢复后的 TypeScript/TSX 源码。
- 在构建手册中补充 Ink/React 调试工作流，说明 integrated terminal、`patchConsole` 行为和现有 debug 日志通道的推荐用法。

## 2026-03-31 - 恢复工程初始化与安全策略限制处理

### 关联提交

- `4178dd7` — 2026-03-31 22:39:10 +08:00 — `Delete CYBER_RISK_INSTRUCTION`
- `554fb1f` — 2026-03-31 22:42:01 +08:00 — `更新说明`

### 变更内容

- 初始化 recovered Claude Code 工程结构，加入构建脚本、缺失依赖审计脚本、运行脚本、shim 模块和恢复后的源码文件。
- 删除或调整恢复源码中的 `CYBER_RISK_INSTRUCTION` 相关限制说明，并同步处理安全审查、策略限制、托管设置安全检查、Bash / PowerShell 安全处理、插件策略和 MCP instruction delta 等相关模块。
- 新增早期恢复工程说明文档，并整理 README 入口说明。

## 2.1.88 base

### 基线说明

- 基础版本：Claude Code `2.1.88`。
- 本仓库所有本地变更均以该版本的恢复源码为起点。
- 本条目固定保留在变更日志底部，不作为新增功能或日期记录。

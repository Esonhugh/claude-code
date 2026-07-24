# 变更日志

本文档记录基于 Claude Code `2.1.88` 恢复源码之后的本地变更。

记录规则：

- 最新变更写在最上方。
- 如果没有实际发布版本号，不虚构版本号，只使用变更提交日期。
- 发布版本条目可以覆盖上一版本 tag 之后的全部提交；非发布条目按对应变更 commit 的提交日期记录。
- 每个条目写明关联 commit 和变更内容。
- `2.1.88 base` 固定放在最底部，作为所有本地变更的起点。

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

### 验证状态

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

### 发布验收

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

### 测试与交互验收

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

### 检查结果

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

### 测试与 binary-side 验收

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

### 测试与 binary-side 验收

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
- 新增 `claude-debug` skill，将 tmux/InteractiveTerminal、`--print`、`--debug-file`、HTTP_PROXY/HTTPS_PROXY、SSE/WebSocket、透明代理与 MITM/CCH 请求调试流程从 `claude-analysis` 中拆出，明确源码/二进制分析与运行时调试的边界。- 调整 `buildFetch` 请求处理，使 CCH patch 与 `x-client-request-id` 注入都仅在 first-party provider 路径启用；OpenAI、Bedrock、Vertex、Foundry 等 provider 不发送或修改相关 first-party 请求信息。

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

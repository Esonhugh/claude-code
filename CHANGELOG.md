# 变更日志

本文档记录基于 Claude Code `2.1.88` 恢复源码之后的本地变更。

记录规则：

- 最新变更写在最上方。
- 如果没有实际发布版本号，不虚构版本号，只使用变更提交日期。
- 日期以对应变更 commit 的提交时间为准；同一天多个相关提交合并为一个条目。
- 每个日期条目写明关联 commit 和变更内容。
- `2.1.88 base` 固定放在最底部，作为所有本地变更的起点。

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

# UI 状态与输出一致性优化计划 1

## 1. 背景与范围

审计基线为 `a8a678c`，该提交从 `@anthropic-ai/claude-code@2.1.88` sourcemap 恢复源码；审计范围为 `a8a678c..HEAD`。

本计划聚焦：

- UI 操作与真实执行结果是否一致；
- 成功、失败、部分成功消息是否准确；
- AppState、持久化状态和界面状态是否同步；
- Agent、Workflow、Plugin、Task、InteractiveTerminal 的终态输出；
- 会直接误导用户的终端显示问题。

不在本计划中处理纯视觉风格调整。所有修复遵循：最小失败测试 → 最小实现 → 聚焦测试 → 构建 → `built-claude` 真实交互验收。

## 2. 已完成修复

### P0-0 Plugin uninstall 成功后错误显示 Enabled

- 文件：`src/commands/plugin/ManagePlugins.tsx:1347-1354`
- 根因：卸载会删除 `enabledPlugins[pluginId]`；原判断 `undefined !== false` 得到 `true`，错误进入 `PluginOptionsFlow`，随后输出 `Enabled`。
- 已修改：仅在 `operation === 'enable' && enabledAfter` 时进入配置流程。
- 已验证：
  - `bun test src/commands/plugin`：23 pass；
  - `make build` 成功；
  - 新 `built-claude` 中真实 uninstall 输出 `✓ Uninstalled hello-plugin...`；
  - `plugin list --json` 返回空数组。
- 当前状态：工作区已修改，尚未 commit。

## 3. 第一批：虚假成功和状态破坏

### P0-1 前台 Agent 转后台后从原始 prompt 重新执行

- 文件：
  - `src/tools/AgentTool/AgentTool.tsx:1023`
  - `src/tools/AgentTool/AgentTool.tsx:1399`
  - `src/tools/AgentTool/AgentTool.tsx:1428`
- 根因：前台 iterator 被关闭后，后台再次调用 `runAgent({...runAgentParams, isAsync: true})`；`runAgentParams.promptMessages` 仍是原始输入，不包含前台已产生的 `agentMessages`。
- 风险：重复工具调用、重复修改文件、progress 与实际执行上下文不一致。
- 修改建议：不要以原 prompt 重启。优先延续同一 iterator；若架构限制必须重启，则使用已完成消息构造明确的 resume context，并保证已执行 tool use 不会再次执行。
- 最小测试：前台 Agent 先执行一次有副作用的 mock tool，再 background；断言后台不会再次收到原始首轮上下文或重复调用该 tool。
- 交互验收：启动前台 Agent，等待一次 Read/tool use 后按 `ctrl+b`，核对 transcript、tool count 和实际调用次数。

### P0-2 Workflow 非 running Agent 仍可 stop/retry

- 文件：
  - `src/components/tasks/WorkflowDetailDialog.tsx:236-240`
  - `src/components/tasks/WorkflowDetailDialog.tsx:397-400`
  - `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:819-943`
- 根因：按键处理和 hints 只检查 workflow 整体为 running，没有检查当前 Agent 的状态。
- 风险：completed Agent 可被改成 skipped；failed/completed Agent 可被伪装成 retry/running。
- 修改建议：根据 `workflowDetailAgentStatus()` 或等价状态判断门控 action。`stop` 只允许 running；在真实 failed retry 调度实现前，`retry` 也只允许有活动 controller 的 running Agent。
- 最小测试：running workflow 中包含 completed、failed、running 三个 Agent；断言前两者不显示/不响应 `x`、`r`，running Agent 才响应。

### P0-3 Failed Agent retry 只修改 UI，不会真实调度

- 文件：
  - `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:900-943`
  - `src/tools/WorkflowTool/runWorkflow.ts:640-645`
- 根因：`retryWorkflowAgent()` 只替换 `agentIds/results` 并写入 running 状态，没有调用 Agent 或重新进入 scheduler。真实 retry 只存在于仍运行的 `runPhaseAgent()` 被特定 reason abort 的路径。
- 修改建议：计划 1 先禁止 failed/completed retry；如果后续要求支持，应单独设计 scheduler re-entry 和持久化语义。
- 最小测试：选择 failed Agent 按 `r`，断言不会产生假的 running result；或者实现后断言真实 Agent runner 被调用一次。

### P0-4 Retry running result 被显示为 Completed

- 文件：
  - `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:930-932`
  - `src/components/tasks/workflowDetailModel.ts:130-145`
- 根因：模型只特殊处理 failed/skipped，其他存在的 result 全部映射为 `done`，包括 `{status:'running'}`。
- 修改建议：显式处理 running；并让 workflow 终态优先于 stale live result。
- 最小测试：构造 status 为 running 的 phase result，断言详情显示 Running 而不是 Completed。

### P0-5 Workflow failed 后残留 Agent 显示 Running

- 文件：
  - `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:731-747`
  - `src/components/tasks/workflowDetailModel.ts:138-145`
- 根因：`failWorkflowTask()` 没有清理 `agentControllers/liveAgents`；详情模型在 workflow failed 判断前先检查 live Agent。
- 修改建议：失败终态清理 controller/live map；详情状态计算中 terminal workflow 状态优先。
- 最小测试：failed workflow 带 stale `liveAgents`，断言 Agent 显示 failed/interrupted，绝不显示 Running。

### P0-6 Plugin 列表 Space toggle 失败仍显示 pending/reload

- 文件：
  - `src/commands/plugin/ManagePlugins.tsx:1408-1452`
  - `src/commands/plugin/ManagePlugins.tsx:640-641`
  - `src/commands/plugin/ManagePlugins.tsx:2857-2860`
- 根因：先写 `pendingToggles`，异步 op 不检查 `result.success`；catch 只记日志，不回滚、不显示错误。
- 修改建议：等待或可靠追踪 operation result；失败时删除对应 pending、恢复原状态、设置 `processError`；仅成功时显示 reload 提示。
- 最小测试：mock `enablePluginOp`/`disablePluginOp` 返回 `success:false`，断言无 pending、无 reload、显示具体错误。
- 真实验收：使用 policy-blocked plugin 或可控写入失败环境按 Space。

### P0-7 TaskUpdate 不存在依赖目标时返回成功

- 文件：
  - `src/tools/TaskUpdateTool/TaskUpdateTool.ts:300-351`
  - `src/utils/tasks.ts:460`
- 根因：`blockTask()` 返回 `false`，调用方忽略并仍把 `blocks/blockedBy` 加入 updated fields。
- 修改建议：检查每次 `blockTask()` 返回值；目标不存在时返回明确 tool error，不得输出 Updated。
- 最小测试：任务 A 存在、目标 ID 不存在；断言工具失败且 A 的依赖不变。

## 4. 第二批：Workflow 和任务生命周期同步

### P1-1 `/workflows pause` 未持久化 run session

- 文件：
  - `src/commands/workflows/workflows.ts:331-336`
  - 对照 `src/tools/WorkflowTool/WorkflowTool.ts:341-345`
- 根因：文本命令只调用 `pauseWorkflowTask()`，没有调用持久化 control status 的逻辑。
- 修改建议：复用 WorkflowTool 的统一 pause/persist helper，避免两条入口行为分叉。
- 最小测试：命令 pause 后读取 session.json，断言为 paused 且包含 resume 信息。

### P1-2 Paused workflow 在 Coordinator 显示 `paused · 0s`

- 文件：
  - `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts:791-808`
  - `src/components/CoordinatorAgentStatusRows.ts:85-105`
- 根因：pause 设置 `pausedAt` 但无 `endTime`；非 running elapsed 回退到 startTime，结果为 0。
- 修改建议：统一 elapsed 终点为 `endTime ?? pausedAt ?? now`，根据状态选择。
- 最小测试：startTime 与 pausedAt 相差 5 秒，断言显示 `paused · 5s`。

### P1-3 `/workflows` 把 paused/failed/killed 统计为 completed

- 文件：`src/commands/workflows/workflowsPageModel.ts:42-47,96`
- 根因：默认图标把 pending 显示为 running spinner；`completedCount` 使用 `status !== 'running'`。
- 修改建议：显式映射 pending/paused；completed count 只统计 completed，failed/killed 分开或不计入 completed。
- 最小测试：覆盖 pending、completed、failed、killed 的 icon、label、count。

### P1-4 Pause/kill 时 child Agent 缺少终止 result

- 文件：
  - `src/tools/WorkflowTool/runWorkflow.ts:419-424`
  - `src/tools/WorkflowTool/runWorkflow.ts:635`
  - `src/tools/WorkflowTool/runWorkflow.ts:797-821`
- 根因：Agent 已登记后，父 abort 导致 child 直接 throw；`allSettled` 只收集 fulfilled，未记录 interrupted/killed。
- 修改建议：在 abort 分支写入明确终止 result，并保证 session progress/resume cache 包含所有已启动 Agent。
- 最小测试：并发两个 Agent 后 pause/kill，断言两个都有终止状态，UI、task state、session cache 一致。

### P1-5 Background main session 外部 abort 后仍可能 Running

- 文件：`src/tasks/LocalMainSessionTask.ts:387-400`
- 根因：abort 分支只通知并 return，没有状态迁移、endTime 和 controller 清理。
- 修改建议：复用统一 kill/stop transition，保证只通知一次。
- 最小测试：外部 abort 后断言 terminal status、endTime、controller 和 notification。

### P1-6 Workflow detail 缺少可发现的 pause/resume UI

- 文件：
  - `src/components/tasks/WorkflowDetailDialog.tsx:236-240,388-400`
  - `src/components/tasks/workflowDetailSnapshot.ts:243-244`
  - `src/components/tasks/BackgroundTasksDialog.tsx:658-662`
- 根因：运行时支持 `p` 但 hints 不显示；paused 时无 resume handler，而 snapshot 声称有 `p resume`。
- 修改建议：先统一真实能力和文案。若本期不做 resume，删除错误提示并显示 pause；若支持 resume，接入真实 resume callback。
- 最小测试：running/paused 两种状态的 hints 与按键行为一致。

## 5. 第三批：Plugin/Marketplace 消息和删除确认

### P1-7 Marketplace Remove 确认范围小于真实删除范围

- 文件：
  - `src/commands/plugin/ManageMarketplaces.tsx:101-113`
  - `src/commands/plugin/ManageMarketplaces.tsx:662-683`
  - `src/utils/plugins/marketplaceManager.ts:2047-2055`
- 根因：确认 UI 从成功 load 的 plugins 统计；删除逻辑从安装记录删除全部插件，并删除 options/data。
- 修改建议：确认模型直接使用与删除逻辑相同的安装记录来源；明确显示 failed/delisted 插件和数据目录删除影响。
- 最小测试：安装记录存在但 plugin load 失败，确认页仍列出该插件并说明数据删除。

### P1-8 Marketplace update/remove 缺少 reload 提示

- 文件：`src/commands/plugin/ManageMarketplaces.tsx:287-293,339-364`
- 根因：操作会调用 `onManageComplete()` 标记需要刷新，但成功消息未反映。
- 修改建议：成功消息补 `Run /reload-plugins to apply.`；如果 remove 后不需要 reload，应先用真实 session 验证再决定，不凭推测修改。
- 最小测试：断言成功 result 与 `needsRefresh` 语义一致。

### P1-9 Install 成功但配置保存失败的消息不完整

- 文件：
  - `src/commands/plugin/DiscoverPlugins.tsx:560-587`
  - `src/commands/plugin/BrowseMarketplace.tsx:681-708`
- 根因：插件已安装，配置失败消息只说 config failure，未提示 reload。
- 建议消息：`Installed <name>, but failed to save configuration: <detail>. Run /reload-plugins to apply the installation.`
- 最小测试：install 成功、save 抛错；断言安装记录存在且消息表达部分成功。

### P1-10 Enable 成功但配置保存失败被显示为整体失败

- 文件：`src/commands/plugin/ManagePlugins.tsx:2019-2048`
- 根因：enable 已完成，PluginOptionsFlow error 分支只输出 `Failed to save configuration`。
- 建议消息：`Enabled <name>, but failed to save configuration: <detail>. Run /reload-plugins to apply.`
- 最小测试：enable 成功、config save 失败；断言 enabled state 为 true，消息不声称 enable 失败。

### P1-11 BrowseMarketplace 忽略指定 marketplace

- 文件：`src/commands/plugin/BrowseMarketplace.tsx:239-267`
- 根因：传入 targetMarketplace 后仍跨所有 marketplace 查找第一个同名 plugin。
- 修改建议：有 targetMarketplace 时只查指定来源；无指定时才全局搜索。
- 最小测试：两个 marketplace 都有同名 plugin，断言打开指定来源。

### P2-1 BrowseMarketplace 安装中不显示 `Installing…`

- 文件：
  - `src/commands/plugin/BrowseMarketplace.tsx:931-933`
  - 对照 `src/commands/plugin/DiscoverPlugins.tsx:654-656`
- 根因：判断 `option.action === 'install'`，实际 action 为 `install-user/project/local`。
- 修改建议：使用 `startsWith('install-')`。
- 最小测试：任一 scope 安装中显示 `Installing…`。

## 6. 第四批：Config 与通知输出

### P1-12 `/config` 连续修改模型后丢失保存消息

- 文件：
  - `src/components/Settings/Config.tsx:325-331`
  - `src/components/Settings/Config.tsx:1296`
  - `src/components/Settings/Config.tsx:1454`
- 根因：第二次修改发现 changes 已含 model 时直接删除记录，而不是与初始值比较并更新最新值。
- 修改建议：始终以初始 model 为基准计算 dirty state；最新值不同则保存最新 change，相同才删除。
- 最小测试：初始 A，依次选择 B、C，保存提示必须为 C；A→B→A 则无变更。

### P1-13 启用 auto-updates 后可能显示 dismissed

- 文件：
  - `src/components/Settings/Config.tsx:1645`
  - `src/components/Settings/Config.tsx:2054-2065`
  - `src/components/Settings/Config.tsx:1446-1454`
- 根因：保存结果只比较 channel，不比较 global `autoUpdates` 从 false 到 true。
- 修改建议：将 enabled 状态纳入 change summary。
- 最小测试：初始 disabled + latest，选择 Enable with latest，断言消息明确已启用。

### P1-14 Agent notification XML-like 内容未转义

- 文件：`src/tasks/LocalAgentTask/LocalAgentTask.tsx:379-398`
- 根因：description/error/finalMessage/path 直接拼入 XML-like 标签。
- 修改建议：统一 XML escaping 或使用不会被文本闭合的结构化序列化；所有动态字段都处理。
- 最小测试：result 含 `</result><status>failed</status>`，解析后仍保持单一 completed notification 和原始文本内容。

### P2-2 Main session notification 描述重复

- 文件：`src/tasks/LocalMainSessionTask.ts:200,245-249`
- 根因：固定传入 `Background session`，模板再次添加 `Background session "..."`。
- 修改建议：传真实 session description/query 的安全摘要；模板只加一次类型前缀。
- 最小测试：断言 summary 包含真实描述且无 `Background session "Background session"`。

### P2-3 Agent 终态仍显示 stale lastActivity

- 文件：`src/components/CoordinatorAgentStatusRows.ts:117-120`
- 根因：所有状态均优先显示 activity。
- 修改建议：仅 running 显示 activity；completed/failed/killed 显示 elapsed 或终态摘要。
- 最小测试：完成任务保留 `lastActivity=Read(...)`，断言显示 `completed · 2s`。

### P2-4 Token count 多处口径不一致

- 文件：
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:68-97`
  - `src/tools/AgentTool/agentToolUtils.ts:319,648`
  - `src/tools/AgentTool/AgentTool.tsx:2034`
- 根因：progress 使用 latest input + cumulative output；finalize 使用最后 assistant usage；同步结果和异步通知来源不同。
- 修改建议：定义单一 token accounting 函数，progress/final result/notification 全部复用。
- 最小测试：多轮 Agent 的 Coordinator、notification、tool_result token 数一致。

## 7. 第五批：InteractiveTerminal 和终端渲染

### P1-15 `send_key` 后不刷新 task preview

- 文件：
  - `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts:277-286`
  - `src/tools/InteractiveTerminalTool/handlers/sendKey.ts:8`
- 根因：send_key 分支未调用 `refreshTerminalTaskPreview()`。
- 修改建议：成功写键后复用 write/read 的刷新逻辑，并同步 closed 状态。
- 最小测试：发送 Enter/CTRL_C 后 task preview 和 closed 立即更新。

### P1-16 status 发现退出后 task 仍为 running

- 文件：
  - `src/tools/InteractiveTerminalTool/InteractiveTerminalTool.ts:317`
  - `src/tools/InteractiveTerminalTool/taskState.ts:9`
- 根因：只写 `closed`，未更新 task status/endTime。
- 修改建议：定义 terminal lifecycle → task lifecycle 的统一映射，避免各 action 分支各自更新部分字段。
- 最小测试：短命令退出后调用 status，断言 task terminal 状态和 endTime 正确。

### P1-17 Detail 定时刷新不处理自然退出

- 文件：`src/components/tasks/BackgroundTasksDialog.tsx:98-133`
- 根因：读取 status 只更新 cols/rows/preview，异常被吞掉，也不更新 closed/status。
- 修改建议：复用统一 terminal task refresh helper；session 不存在/退出时明确同步终态。
- 最小测试：preview 成功后 status 返回 exited 或抛 session closed，断言不保留 stale running UI。

### P2-5 Background task summary 未清理 ANSI

- 文件：
  - `src/components/tasks/interactiveTerminalPreview.ts:11-16`
  - `src/components/tasks/BackgroundTask.tsx:47-49`
- 修改建议：summary 显式 strip ANSI、CRLF 和控制字符后再截断。
- 最小测试：彩色输出和 carriage-return progress 生成稳定纯文本 summary。

### P2-6 InteractiveTerminal detail 高度未裁剪

- 文件：
  - `src/components/tasks/interactiveTerminalPreview.ts:19-20`
  - `src/components/tasks/BackgroundTasksDialog.tsx:160-168`
- 根因：直接使用 PTY `rows + 2`。
- 修改建议：结合当前 terminal height 和 dialog 可用空间计算上限。
- 最小测试：PTY 40 行、宿主 24 行时 dialog 不超过可用高度。

### P2-7 Coordinator 行使用 `string.length` 计算显示宽度

- 文件：`src/components/CoordinatorAgentStatus.tsx:148-160`
- 根因：`length/slice/padEnd` 不符合终端宽字符和 grapheme 显示宽度。
- 修改建议：复用项目 display-width/truncate 工具，不手写 ANSI 或固定宽度字符串。
- 最小测试：中文、emoji、组合字符在窄终端下不溢出、不截断半个 grapheme。

## 8. 实施分组与依赖

建议拆成以下独立修复组，每组完成测试和真实验收后再进入下一组：

1. Plugin UI 结果一致性：P0-6、P1-7 至 P1-10、P2-1。
2. Workflow action/state：P0-2 至 P0-5、P1-1 至 P1-4、P1-6。
3. Agent/main-session 生命周期：P0-1、P1-5、P1-14、P2-2 至 P2-4。
4. TaskUpdate 正确性：P0-7。
5. InteractiveTerminal 生命周期：P1-15 至 P1-17、P2-5、P2-6。
6. Config 和通用终端展示：P1-12、P1-13、P2-7。

不同组不要混入无关重构。Workflow retry 的真实重新调度若超出最小修复，应另建计划；计划 1 先隐藏/禁止无真实执行支持的操作。

## 9. 通用验证矩阵

每个修复组必须完成：

1. 聚焦单元/组件测试：`bun test <related-test-file-or-directory>`。
2. 涉及类型、CLI、runtime 或 UI 时运行 `make build`。
3. 使用新 `./built-claude --dangerously-skip-permissions` 在 InteractiveTerminal 中真实操作。
4. 核对四层证据：
   - 终端 UI 文案；
   - AppState/task state；
   - settings、installed plugins 或 workflow session 持久化；
   - 实际副作用执行次数。
5. 检查 diff，确认没有调试日志、临时代码、无关修改。

## 10. 完成标准

- 失败操作不显示成功、pending 或 reload 提示。
- 部分成功消息同时说明已成功部分、失败部分和下一步操作。
- terminal workflow/task 不显示 Running。
- UI 中可见的 stop/retry/resume 操作都有真实执行支持。
- UI、AppState 和持久化状态一致。
- Agent foreground→background 不重复执行已完成工具。
- 所有新增回归测试、相关测试、构建和真实 CLI 验收通过。

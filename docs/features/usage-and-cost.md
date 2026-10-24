# 用量、成本与状态

> 英文名：`usage-and-cost` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 作用与效果

`/usage` 对 API key 与网关用户也可打开，合并 `/cost`，`-p` 下输出文本。ChatGPT OAuth 时启动 pane 和 `/status` 显示 plan、Codex limits 与 rate-limit reset credits（reset 需二次确认）；API key / bearer token 显示 `API Usage Billing`。显示 Fable 周额度。会话成本以 JSONL `cost-state` 快照保存，resume 后继续累计，思考 token 单独记录。

## 配置

无需配置。相关命令：`/usage`、`/status`、`/stats`。

## 效果

```text
   Status   Config   Usage   Stats
  Session
  Total cost:            $0.0000
  Total duration (API):  0s
  Total duration (wall): 22s
  Total code changes:    0 lines added, 0 lines removed
  Usage:                 0 input, 0 output, 0 cache read, 0 cache write
  PageDown to scroll · Esc to close
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Mods 会话启动时间与恢复

官方 diff 使用 `$.session.usage({}).startedAt` 区分本会话的修改。新建会话、`/clear` 和新分支会取得新的启动时间；`--continue`、`--resume SESSION_ID` 和交互式 `/resume` 通过原有恢复路径保留已记录的时间。`--fork-session` 保留源会话的启动时间并取得新会话 ID；`/branch [name]` 使用新分支的启动时间，与官方 2.1.291 的不同入口语义一致。

启动时间随会话 JSONL 元数据持久化，并在压缩后的恢复中保留。还可读取官方 2.1.291 的完整有效 `cost-state` 记录；成本快照的恢复方式见下方“JSONL 成本快照与历史会话”。直接 JSONL 路径的恢复加载器也传递该字段，但交互式 CLI 的文件启动路径受内部模式限制，普通 `--resume FILE.jsonl` 不能视为直接文件恢复。历史会话没有相关记录时，`startedAt` 沿用既有成本时钟，无法据此还原原始启动时间。禁用会话持久化时不会为恢复文件追加该元数据。

使用 `--debug --debug-file /absolute/path/debug.log` 查看 `[ModsSession]` 恢复日志。日志提供元数据归属会话、当前会话和启动时间，便于核对 diff 的时间边界；不会包含会话正文。CLI 会话参数见 [Anthropic CLI reference](https://code.claude.com/docs/en/cli-reference)。

### 退出时的项目成本保存

交互式 CLI 使用 `/exit` 正常退出时，会在界面卸载期间保存当前会话的成本、运行时长、启动时间、模型用量及 FPS。这些项目汇总记录可供查看最近会话；会话恢复使用下方说明的 JSONL 快照。普通组件卸载不触发这次保存，直接进程退出仍保留原有保存回调。

运行 `bun test ./src/costHook.test.ts` 检查三个真实子进程生命周期和磁盘写入。项目配置只保留最近保存会话的成本；本修复不代表任意历史会话的完整 JSONL 成本账本恢复已经对齐，验收范围见 `mods-test.md`。

### JSONL 成本快照与历史会话

会话日志中的 `cost-state` 保存累计成本、API 和工具时长、修改行数、累计运行时长、启动时间、各模型用量及未知价格标志。恢复会话使用该会话最后一条完整有效的快照；最近项目配置中的 `lastCost` 不再作为历史账本的恢复来源。旧日志没有有效快照时，启动恢复采用新账本，无法还原原始成本。

`--continue`、`--resume SESSION_ID` 和交互式 `/resume` 恢复原有账本；`--fork-session` 使用新会话 ID 并继承源快照；`/branch` 和 `/clear` 开始新账本。非交互模式通过相同快照恢复，例如 `./built-claude --print --resume SESSION_ID "继续任务"`。启动时间的文件加载器边界仍按上一节说明。

快照在现有会话的切换、元数据重写和退出时写入。禁用持久化时不写入，未创建会话文件时也不会只为成本创建文件。用 `--debug --debug-file /absolute/path/debug.log` 的 `[ModsSession]` / `restore-cost-state` 记录核对源和当前 ID、匹配结果及成本时间；日志不含会话正文。

运行 `bun test ./src/utils/sessionCostState.test.ts ./src/utils/sessionStartedAt.restart.test.ts ./src/costHook.test.ts` 检查完整记录、跨进程恢复和退出保存。真实终端的 fork、分支后恢复、非交互恢复及相邻官方 diff 行为见 `mods-test.md`。


### 思考 token 用量

API 返回 `output_tokens_details.thinking_tokens` 时，CLI 在用量归一化、跨消息汇总和模型 `thinkingTokens` 中保留该分项，并通过既有项目汇总及 JSONL `cost-state` 保存。恢复会话后，新请求继续在历史分项上累计；旧日志没有该分项时按零开始累计。SDK `usage.output_tokens_details` 也提供该字段，模型汇总使用 `thinkingTokens`。

思考 token 已包含在 API 的 `output_tokens` 中，费用仍根据原输出总量计算，不额外重复扣费。只有 API 提供的实际 token 计数会被累计，不根据正文长度估算。运行 `bun test ./src/services/api/thinkingUsage.test.ts ./src/utils/sessionCostState.test.ts` 验证这条链路；具体终端及官方对照范围见 `mods-test.md`。

Anthropic 对该字段、最终流式事件与费用口径的说明见 [Steering thinking: pricing](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#pricing)。


### SDK 模型用量元数据

SDK result 的 `modelUsage` 按原始模型名索引；新请求会填充 `canonicalModel`（当前价格目录使用的模型名）、`provider`（现有 API 提供方）和 `costBasis`。当前目录计价为 `list`，未知模型使用默认价格估算时为 `unknown`，因此不能把它看作已核实的真实账单。三个字段都是可选字段，旧会话和旧 SDK 数据仍可读取；token 数量、contextWindow 和 maxOutputTokens 按官方 schema 要求整数。

JSONL cost-state 和项目汇总保持官方 wire 字段，运行时元数据不会写入历史快照。恢复会话时重建当前模型限制，新的请求再填充上述元数据。运行 `bun test ./src/services/api/modelUsageMetadata.test.ts` 检查传递与恢复行为。schema 接受官方的 `managed` 标签；组织定价及新增提供方的完整计价和路由仍需后续对齐，不能据此声称这些流程已通过。


### 子任务与根会话用量

普通子任务拥有各自的 agent ID 和执行上下文，成本与模型用量汇入所属根会话账本。`$.session.id()` 与 `(await $.session.usage({})).cost.usd` 读取当前根会话身份和累计成本，不能把根会话总额当作某一个 agent 的独立费用。保存及恢复根会话时应保留已累计的子任务用量。

运行 `bun test ./src/services/api/rootLedger.test.ts` 检查两个并发子任务的上下文隔离、共享累计及根会话快照。本用法针对普通子任务；其他独立根会话的账本归属与异常恢复须按各自入口验证。真实 CLI 的 Agent 调用、保存和恢复对照范围见 `mods-test.md`。

# OpenAI/Codex Ultra Effort 支持交接

## 下一会话目标

在当前项目的 OpenAI/Codex 请求链路中新增独立的 `ultra` effort level，并与 `dist/codex` 上游语义对齐，同时避免改变现有自定义 `ultracode` 的含义。

期望语义：

- `ultra`：OpenAI/Codex 专用等级，wire request 使用 `reasoning.effort: "max"`。
- `ultracode`：当前项目已有自定义模式，目前是 OpenAI `xhigh` + dynamic workflow orchestration；不要未经确认直接把它重定义成 `ultra`。
- 是否让新 `ultra` 同时触发 proactive orchestration，需要先向用户确认；上游 Codex 会这样做，但用户本轮只明确授权“OpenAI 格式额外支持 ultra effort level”。最小实现应先增加 effort/request 支持，不自行扩大 orchestration 行为。

## 上游证据

直接研究了仓库内 `dist/codex`，不是根据当前项目推测。

- 完整 enum：`dist/codex/codex-rs/protocol/src/openai_models.rs:37-68`
  - 包含 `XHigh`、`Max`、`Ultra`。
- Ultra request 映射：`dist/codex/codex-rs/core/src/client.rs:174-179`
  - `Ultra -> Max`。
- 直接测试：`dist/codex/codex-rs/core/src/client_tests.rs:293-301`
  - 测试名 `ultra_reasoning_uses_max_for_requests`。
- Responses request reasoning 结构：`dist/codex/codex-rs/codex-api/src/common.rs:146-154,215-260`
- 请求构造：`dist/codex/codex-rs/core/src/client.rs:803-812,864-906`
- 模型支持示例：
  - `dist/codex/codex-rs/models-manager/models.json:31-58`（GPT-5.6-Sol 支持 ultra）
  - `dist/codex/codex-rs/models-manager/models.json:144-171`（GPT-5.6-Terra 支持 ultra）
  - `dist/codex/codex-rs/models-manager/models.json:255-279`（GPT-5.6-Luna 无 ultra）
- proactive multi-agent：`dist/codex/codex-rs/core/src/session/multi_agents.rs:39-56`

## 当前项目关键位置

实施前逐个阅读，不要只改一个映射：

- effort 类型和 levels：`src/utils/effort.ts:15-27`
- parse/persist：`src/utils/effort.ts:75-113`
- applied effort：`src/utils/effort.ts:145-181`
- display/suffix：`src/utils/effort.ts:184-225`
- effort 描述：`src/utils/effort.ts:235-256`
- `/effort` command：`src/commands/effort/effort.tsx`
- settings schema：`src/utils/settings/types.ts:745-757`
- SDK schemas：
  - `src/entrypoints/sdk/coreSchemas.ts:1168-1173`
  - `src/entrypoints/sdk/controlSchemas.ts:510`
- API effort gate/config：`src/services/api/claude.ts:446-478,1485,1586-1596`
- OpenAI conversion：`src/services/api/openai-compat.ts:160-168,386-387`
- conversion tests：`src/services/api/openai-compat.test.ts:100-107`
- keyword/orchestration paths：
  - `src/utils/processUserInput/processUserInput.ts:551-602`
  - `src/utils/messages.ts:3997-4006`
  - `src/utils/attachments.ts:1496-1529`
- model capability gate：`src/utils/effort.ts:30-56`

当前行为：

```ts
if (resolved === 'ultracode') {
  return getAPIProvider() === 'openai' ? 'xhigh' : 'high'
}
```

OpenAI adapter 当前把 `max`、`ultracode`、number 转成 `xhigh`，见 `src/services/api/openai-compat.ts:160-168`。新增 `ultra` 后必须明确区分：

- `ultra -> max`
- `ultracode -> xhigh`（保留当前行为，除非用户另行要求）

## 建议实现范围

1. 在 runtime effort union/`EFFORT_LEVELS` 增加 `ultra`。
2. `parseEffortValue()` 和 `/effort` 接受 `ultra`。
3. 默认不要持久化 `ultra`，除非 settings schema 与产品需求明确允许；可先按 `xhigh/ultracode` 的 session-scoped 规则处理。
4. `resolveAppliedEffort()`：
   - OpenAI provider：`ultra -> max`。
   - 非 OpenAI provider：应返回 undefined 或明确 fallback；不要发送 Anthropic 不支持的 `ultra`。选择前检查现有 max fallback语义并写测试。
5. `anthropicEffortToOpenAIReasoning()`：显式 `ultra -> { effort: 'max' }`，不要落到 `xhigh` 分支。
6. 更新 UI display，使用户能区分 `ultra`、`xhigh`、`ultracode`，不要继续全部显示成 high。
7. 检查 `modelSupportsEffort()` gate。OpenAI/Codex 模型若无 3P override，可能根本不发送 effort。应为明确支持的模型接入 capability metadata/override，而不是无条件为所有 3P 模型开启。
8. 更新 SDK/control schema，使外部调用能表达 `ultra`；避免内部命令支持但 SDK 拒绝。
9. 不自动让 `ultra` 触发 ultracode workflow 提示，除非用户明确确认要对齐 proactive multi-agent。

## 最小测试矩阵

先写失败测试：

1. `parseEffortValue('ultra') === 'ultra'`。
2. OpenAI provider：`resolveAppliedEffort(model, 'ultra') === 'max'`。
3. OpenAI adapter：输入 `output_config.effort='ultra'`，输出 `reasoning.effort='max'`。
4. 保持现有：`ultracode -> xhigh`。
5. `xhigh -> xhigh`、`max -> max`（如果当前 adapter 应原样支持 max，需修正旧测试/实现）。
6. 非 OpenAI provider 不发送非法 `ultra`。
7. `/effort ultra` 能设置本轮/session 状态并显示准确等级。
8. SDK/control schemas 接受 `ultra`。
9. capability gate 对明确支持 ultra 的 Codex model 允许发送，对不支持模型有明确 fallback/拒绝行为。
10. 环境变量 `CLAUDE_CODE_EFFORT_LEVEL=ultra` 遵守优先级并转换成 max。

## 真实验证

- 运行聚焦 `bun test`，禁止 npm。
- 运行 `make build`。
- 用 InteractiveTerminal 启动新 `built-claude`，执行 `/effort ultra`，确认 UI 不显示成普通 high。
- 使用本地授权的 debug/代理抓取脱敏 request summary，最终确认 OpenAI Responses request 包含：

```json
{"reasoning":{"effort":"max"}}
```

- 同时验证 `/effort ultracode` 仍发送 `xhigh`，防止兼容性回归。
- 不打印 OAuth token、Authorization、cookie 或完整私有 request body。

## 当前工作区与约束

- 分支：`improvement`。
- 工作区有大量用户未提交修改，先运行 `git status --short` 和目标文件 diff；禁止覆盖、回退或格式化无关代码。
- 已有未提交修改：`src/commands/plugin/ManagePlugins.tsx`，修复 uninstall 消息；不要混入 effort patch 或回退。
- 详细 UI 优化计划：`docs/plan/ui-state-output-optimization-plan-1.md`。
- 不使用 worktree。
- 不在 production TS 增加 `ForTesting` 导出。
- 不自动 commit。

## Suggested skills

- `mattpocock-skills:tdd`：先固定 ultra/xhigh/max/ultracode 映射测试。
- `claude-debug`：构建后验证真实 OpenAI Responses request。
- `interactive-terminal`：验收 `/effort ultra` UI 与新 `built-claude`。
- `simplify`：完成后检查 effort 映射是否存在重复、不一致分支。

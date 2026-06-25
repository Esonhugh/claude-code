---
name: official-claude-analysis
description: 当用户要求在这个 TypeScript Claude Code 仓库中分析、对比或实现 official Claude CLI 行为时使用。触发词包括 “official Claude CLI”、“parity”、“跟官方一致”、“按官方实现”、“参考官方行为”，以及官方 auth、streaming、retry/backoff、model selection、task/tool、workflow、UI 行为，或 Claude CCH / claude_cch.py / package/claude / Attestation.zig / native / objdump / Frida 兼容性分析。要求先取得 official Claude 的源码证据或运行时证据，再做最小 TypeScript 实现和测试；CCH/native 工作必须保持防御性、本地、已授权、仅观察。
---

# Official Claude Analysis

## 目的

把官方行为转化为本仓库的 TypeScript 实现，避免凭记忆或猜测实现。

这个 skill 只服务于 official Claude CLI 分析：与本仓库对比，并在需要时用 parity-oriented tests 实现对应 TypeScript 行为。它不服务其它 provider 的源码研究或方案迁移。

## 核心原则

先证据，后实现。官方行为可能在 transport、retry、auth、UI、生命周期等细节上与本仓库不同，而这些细节正是 parity 工作的重点。先定位并阅读官方源码，或复现官方运行时行为，再映射到本仓库最接近的 TypeScript 架构。

## 工作流

### 1. 明确上游目标

写代码前先确认具体官方目标：

- official Claude CLI 行为；
- 具体 command、UI interaction、API flow、transport、model behavior 或 error path。

如果目标不明确，只问一个具体澄清问题。如果上下文已经足够，直接继续。

### 2. 收集官方证据

使用能回答问题的最窄证据来源。

针对 official Claude CLI parity：

- 涉及 UI、workflow、task list、streaming、tmux 或交互行为时，优先真实运行时复现。
- 按项目要求使用 tmux-driven verification 验证交互式 CLI 行为。
- 在提出实现前，记录关键 pane output 或 command output。
- 如果官方源码不可用，记录复现命令、版本、pane 输出和观察到的行为作为证据。


### 3. 对比本 TypeScript 仓库

编辑前找到本地 TypeScript 对应位置：

- API client selection: `src/services/api/client.ts`
- model/provider selection: `src/utils/model/*`
- retry behavior: `src/services/api/withRetry.ts`
- terminal/interactive parity: 相关 Ink components、transports、workflow 或 bridge files

实现前用一两句话写出关键差异。

### 4. 设计 TypeScript 映射

映射概念，而不是照搬文件：

- provider config → environment/settings/provider helpers
- stream reconnection → 现有 async iterable / SSE / WebSocket 抽象
- official fallback behavior → 适配当前架构的最小本地 fallback

保持实现最小。如果官方行为需要大规模架构变更，先停下来总结选项，不要直接大改。

### 5. 先写行为测试

对 bug fix 和行为变更，先添加或更新最小失败测试，再改 production code。

好的 parity tests 应断言可观察行为：

- official Claude 的 streaming、tool、UI 或 auth 行为能通过测试或 tmux 复现验证；
- model mapping、system prompt 或 beta 行为产出预期 official Claude 对齐结果。

除非没有可观察 seam，否则避免只断言内部 helper 调用。

### 6. 最小实现

确认失败测试后，只实现当前 parity 行为所需的最小代码。

保持本地风格：

- 使用现有 TypeScript module style；
- 不做 speculative abstractions；
- 未经用户确认不新增依赖；
- 不在相关子系统周围做大范围 refactor；
- 除非当前架构需要，不添加 compatibility shims。

如果官方行为需要大架构变化，停止并汇报选项。

### 7. 验证

先运行最小相关测试。使用 `bun`，不要使用 `npm`。

示例：

- `bun src/utils/thinking.test.ts`
- 修改 build/runtime packaging 行为时运行 `make build`
- 修改交互式 CLI 行为时用 tmux-driven `make test`

声称完成前，检查 diff，确认只包含预期文件。

## Claude CCH / native analysis references

分析 Claude CCH、`claude_cch.py`、official Claude bundle internals 或 native helper 行为时，只加载相关 reference：

- `references/claude-cch-analysis-overview.md` — 范围、安全边界、证据规则和本地兼容性整体流程。
- `references/js-bundle-extraction-deobfuscation.md` — 使用 `scripts/native-extra.mjs` 解出 Bun standalone JS，再安全使用 static search、`webcrack` 和 `restringer`。
- `references/native-binary-objdump-frida-workflow.md` — 使用 `otool` / `objdump` / `nm` 做 native binary triage，以及 observation-only Frida 纪律。
- `references/analysis-notes-and-evidence-template.md` — 用于区分事实、假设和已排除路径的可复用笔记模板。
- `references/claude-cch-case-study.md` — 历史 CCH placeholder 调查：JS 层 `cch=00000`、Docker deobfuscation 尝试、native strings 搜索，以及 `Attestation.zig` 线索边界。- `references/session-transcripts/INDEX.md` — 已复制并基础脱敏的相关 session transcript 索引；包含 CCH 主分析会话。

对于 CCH 工作，除非当前证据证明已经恢复算法，否则不要声称“恢复了 CCH 算法”。历史案例支持的是 JS placeholder + native-attestation 线索，不是已恢复的 CCH 计算方法。

## 输出格式

汇报时保持简洁，并包含：

1. **官方证据** — 已检查的文件、命令或运行时观察。
2. **本地差异** — 本仓库缺失或不同的行为。
3. **实现** — 修改的文件和新增行为。
4. **验证** — 精确命令输出或状态。
5. **限制** — 有意未移植的内容，例如某些 native 行为仍只有线索。

对于只分析 CCH/native 的工作，使用：

1. **范围** — artifacts、授权边界和 non-goals。
2. **证据** — transcript paths、artifact paths、commands 和 observations。
3. **发现** — 已确认事实、假设和已排除路径。
4. **方法迁移** — 过去案例是直接证据还是仅可复用方法。
5. **安全限制** — 脱敏、拒绝的 bypass/forgery 步骤和剩余不确定性。

## 决策规则

- 如果请求包含 “official Claude”、“Claude CLI”、“parity”、“跟官方一致”、“按官方实现” 或 “参考官方行为”，且目标是 Claude Code/Claude CLI，使用此 skill。
- 如果请求是纯本地清理且没有上游行为目标，不要强行触发此 skill。
- 如果用户询问 WebSocket、retry、model、workflow、task list 或 UI 行为，并且上下文提到 official behavior，使用此 skill。
- 如果用户只要求分析，不要改代码；提供证据、本地差异和选项。
- 如果官方证据与本地既有假设冲突，信任官方证据并更新本地计划。

## 常见陷阱

- 不要凭记忆实现官方行为。官方代码变化很快。
- 不要在没有 fallback 和测试的情况下默认启用 WebSocket 等有风险的新 transport。
- 不要把历史 CCH placeholder 案例当成绕过或伪造 CCH 的配方。
- 不要在 parity 工作中提交无关文件。

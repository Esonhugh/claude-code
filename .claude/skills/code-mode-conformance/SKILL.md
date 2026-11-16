---
name: code-mode-conformance
description: Use this skill when checking how closely the local Code Mode (CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, the REPL/Poll tools, REPL scripts, repl-mode transcripts) matches an official Claude Code release. It covers static extraction of official prompts, schemas and texts; built-claude runs against a mock API; official runs resuming local transcripts; and running official Code Mode through local MITM interception. It also triggers for Chinese requests mentioning Code Mode 一致性、官方对照、REPL/Poll 对比、conformance 或 L3b 拦截. Use claude-network-debug for general proxy/MITM work, claude-source-binary-analysis for bundle extraction techniques, and claude-code-feature-validation for ordinary change validation.
version: 0.1.0
---

# Code Mode 官方一致性验证

回答一个问题：本地 Code Mode 和官方某个版本，在模型、hook 作者、用户、transcript 四个视角下，哪些一致、哪些有意不同、哪些是缺陷。计划原文在 `docs/plan/code-mode-conformance.md`，本 skill 是可重复执行的版本。

## 职责边界

- 本 skill：Code Mode 专用的对照流程、场景清单、证据分级、L3b 拦截和报告格式。
- `claude-source-binary-analysis`：解包 Bun bundle、反混淆、定位函数。本 skill 只说要抽什么。
- `claude-network-debug`：通用 proxy/MITM。它的 runner 转发到真实上游，本 skill 的 L3b 需要在本地终结 TLS 并直接应答，脚本另写。
- `claude-code-feature-validation`：普通改动的测试和二进制验收。G 维度沿用它的做法。

## 安全规则

- 不读取、不打印 `~/.claude/settings.ducc.json` 和任何 token、cookie、API key 的值；只记录"有/无"和来源。
- 官方进程只拿假凭证（如 `sk-ant-fake`），用独立的 `HOME` 和 `CLAUDE_CONFIG_DIR`；真实 settings 和真实代理变量都不传进去。
- MITM 和 mock 只绑定 `127.0.0.1`。临时 CA 只经 `NODE_EXTRA_CA_CERTS` 注入目标子进程，不装进系统或浏览器信任库；跑完删除 CA 私钥。
- 不 patch 官方二进制。gate 拿不到就停下记录原因，不绕。
- 证据写盘前脱敏（`authorization`、`x-api-key`、`cookie`、`sk-ant-*`），并用 `rg` 扫一遍确认 0 命中。证据只留本地，不提交。
- F 维度只回答"脚本能否绕过内层调用的权限判定和 hook"。没有攻击路径的情况不加防护。

## 证据等级

| 等级 | 来源 | 能证明什么 |
|---|---|---|
| L1 | 官方 bundle 抽出的字符串、schema、常量，对比本地源码和 `built-claude` | 文案、schema、常量一致 |
| L2 | `built-claude` 连本地 mock API，场景文件驱动 | 本地行为符合 L1 推出的官方行为 |
| L3a | 官方普通模式连同一个 mock，resume 本地写的 Code Mode transcript | 官方如何读取、提醒、渲染 |
| L3b | 官方经本地拦截真正进入 Code Mode | 两边运行结果逐项 diff |

每条结论必须带等级和位置（官方 `chunk:line` 或 bundle 偏移，本地 `file:line`）。L1 推断写成"推断"，不写成"已确认"。

## 工作流

1. **定基准**：记录本地 commit、官方版本和二进制 sha256；检查 `git status` 干净；`make build` 后确认 `./built-claude --version`。官方包放 `/tmp/cmx/`，没有就 `make download-claude CLAUDE_VERSION=<版本>` 或用已有 tgz。
2. **准备 harness**：见下方 Scripts。缺哪个先补哪个，补完单独提交 `test(code-mode): conformance harness`。
3. **L1 抽取**：按 [`references/dimensions.md`](references/dimensions.md) A 节列出的锚点抽出官方 prompt、schema、文案、常量，输出 JSON 到 `/tmp/cmx/conformance/l1/`。
4. **按维度并行**：A+E、B+G、C+D、F 各一个 agent。每个 agent 只写自己的场景文件和报告片段，不改产品代码。prompt 里写清写入范围、证据目录和脱敏要求。
5. **L3b**：按 [`references/l3b-intercept.md`](references/l3b-intercept.md)。先验证 GrowthBook 能否伪造，不能就停在那一步。
6. **汇总**：写 `docs/research/code-mode-conformance-<YYYYMMDD>.md`，格式见下。
7. **修复与回归**：缺陷按影响排序，每个先写最小失败测试再修，修完重跑该维度和 G。有意不同的条目写回 `docs/plan/code-mode.md` 的决策或风险段。

上游限流会打断 agent：prompt 里要求小步写盘，恢复时先看 `git status` 和证据目录再继续。

## 已知有意不同（不要当缺陷报）

以 `docs/plan/code-mode.md` 的 D1–D5、"Phase 3 遗留"和"Phase 4 已知差异"为准，执行前重读。截至 2026-11-16：

- 开关只有 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` 环境变量；不移植官方的 GrowthBook gate `tengu_rustling_blossom`，也不加 settings 或 `/config` 开关。
- 支持 API billing（API key）：不移植官方的 provider、credentials、订阅类拒绝原因，自定义 `ANTHROPIC_BASE_URL` 下也能开启。
- D2：超时、Esc 后 vm context 丢失，下次结果提示 `contextReset`；官方保留。
- D3：开关拒绝原因只有少数几种；teammate 拿普通工具。ant 构建例外。
- D4：mods 的 tool.call hook 照常触发；官方装了这类 mod 拒绝开启。
- 开关关闭时 resume Code Mode 会话：本地注入提醒继续；官方交互界面拒绝。
- `$` 是官方 shell helper 的子集；prompt 里 MCP server 上限 10 是猜测。超时文案已是官方原文，只有 `CONTEXT_LOST` 提示和 Poll schema 的 `content` 说明是自拟的。
- Phase 4 未移植：`imagesRefused`、`imagePagesFailed`、`stripForStorage`、后台结果带图片、`startsTurn:false`、`ranBefore`、`rerunByHook`、`onStopWaitChange`；1 小时缓存判断读配置。后台进度视图和任务行属于 Phase 5。

## Scripts

harness 放在本 skill 的 `scripts/` 下，运行前复制到 `/tmp/cmx/conformance/run/`，产物不写回仓库：

| 脚本 | 作用 |
|---|---|
| `extract-official.ts` | 解包官方版本，按锚点抽 REPL/Poll prompt、input schema、文案、常量，输出 JSON |
| `mock-api.ts` | 按场景文件依次返回 assistant 消息，存每次请求体（已脱敏）为 JSONL |
| `drive.py` | tmux 启动二进制，隔离 HOME，跑场景，收集 transcript、debug log、请求体；`-p --output-format stream-json` 走 headless |
| `intercept.ts` | L3b 用：本地终结 `api.anthropic.com` 和 GrowthBook 的 TLS，Messages 转 mock，feature 请求返回伪造响应 |
| `report.py` | 把 L1 JSON、请求体、transcript 规整后 diff，生成报告表格 |
| `scenarios/*.json` | 每个场景：模型回复序列、期望值、官方锚点 |

初版尚未写入时，第 2 步由一个 agent 按上表实现，并为 `mock-api.ts` 和 `report.py` 的规整逻辑写测试。

## 报告格式

```markdown
## 基准
- 本地 commit / 官方版本 / 二进制 sha256：
- 已达到的证据等级：L1 L2 L3a L3b（未达到的写原因）

## 结果
| 维度 | 项 | 官方 | 本地 | 等级 | 结论 | 位置 |
|---|---|---|---|---|---|---|
（结论只用：一致 / 有意不同 / 缺陷 / 未验证）

## 缺陷
1. 现象、重现场景、官方行为与证据、本地位置、建议修法

## 未覆盖与限制
- ...

## 证据
- 目录、脱敏扫描结果、清理状态
```

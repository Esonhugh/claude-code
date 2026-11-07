# 缓存命中与用户体验基准

> 英文名：`cache-benchmark` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 这是什么

同一批任务分别用本 fork（Claude 账号、ChatGPT 账号）、官方 Claude Code、Codex CLI 和 pi 跑一遍，比较提示缓存命中率、token 用量、启动速度和卡顿。本页数据测于 2026-11-07，与其他功能文档不同，全部是真实模型请求，不是假 API。

## 测试后的修复

基准发现的两个 ChatGPT 侧问题已经修复，下文表格保留修复前的原始数据：

- **ChatGPT `-p` 启动慢**：首个请求要等 Codex Apps 列出 431 个工具（约 2.3 秒）。现在 App 在后台连接，修复验证时 `-p` 启动到首个请求从约 3.2 秒降到约 0.78 秒；第一轮就要用 App 时，`ToolSearch` 最多等 5 秒（[#1022](https://github.com/Esonhugh/claude-code/issues/1022)，PR [#1026](https://github.com/Esonhugh/claude-code/pull/1026)）。见 [Codex Apps](codex-apps.md)。
- **ToolSearch 让缓存整体失效**：ChatGPT 下每加载一个延迟工具都改动顶层 `tools`，下一个请求缓存命中为 0。现在加载的工具以 `tool_search_call` / `tool_search_output` 放进对话，`tools` 整个会话不变，同一场景 7 个请求命中由 0/7 变为 7/7（[#1023](https://github.com/Esonhugh/claude-code/issues/1023)，PR [#1027](https://github.com/Esonhugh/claude-code/pull/1027)）。见 [OpenAI provider](openai-provider.md)。
- **WebSocket 不启用**：下文结论里 WebSocket 掉线率 5.5% → 2.8% 的小样本没有复现。扩大到 10 组对照后 WebSocket 6.3%、SSE 4.1%，Bun 下继续只用 SSE。剩余约 3–4% 的随机缓存掉线来自 OpenAI 后端路由，客户端无法修正（结论记在 [#1023](https://github.com/Esonhugh/claude-code/issues/1023)）。

## 测试对象

本仓库 `dev` `17abdd1`（2.1.297）分别用 Claude OAuth 与 ChatGPT OAuth；官方 Claude Code 2.1.319；Codex CLI 0.167.0；pi 1.5.0（`@earendil-works/pi-coding-agent`，只测 ChatGPT）。共 301 次真实 run，每个模型请求经 MITM 记录代理取 usage、TTFT 与请求体大小，所有 CLI 直连官方端点。完整报告、harness 与逐 run 数据在项目共享目录 `regression/cache-bench-1107/`。

## 结论（修复前）

- Claude 侧与官方持平：CLI 命中率 87.9% 对 86.5%，平均总 token 76.2k 对 81.2k，首个 prompt 15.5k 对 17.3k，TTFT 相同；会话内缓存失效 0 次；`--continue` 续接首请求两边都是 98% 命中，`/compact` 前后一致。
- 官方 TUI 首个 prompt 是本仓库的 2 倍（33k 对 17k），6 轮交互总 token 427k 对 258k。官方请求体更小（服务器端 thread 续接只送增量），计费 token 不受影响，维持现状。
- ChatGPT 侧命中率 81.9%，Codex 93.0%，pi 84.4%。差距主要在每个新会话的第一个请求：本仓库约 11k 全部未缓存；Codex 不发送系统提示与工具（服务器端共享前缀），首请求约 12k 命中。
- ChatGPT 侧 token 总量已与 Codex 相当：CLI 平均 67.9k 对 83.0k；2.7 小时长闲置会话 367k 对 344k（11-06 时为 1.46M 对 0.60M）。
- ChatGPT 侧会话中途偶发整段缓存失效约 3–5%（pi 1.8%，Codex 0）。subagent 改用独立 `prompt_cache_key` 无改善；改走 WebSocket 时 5.5% → 2.8%，样本较小，待扩大验证（`src/services/api/openai-compat.ts` 目前在 Bun 下不启用 WebSocket）。
- ChatGPT 路径 `-p` 启动到首个请求 2.8s（Claude 路径 0.76s、Codex 2.0s、pi 0.87s），其中约 2.3s 在等内建 Codex Apps MCP 列出 431 个工具，而这些工具在首个请求里全部延迟加载。
- 长闲置（两次 65 分钟）：Claude 1h 缓存过期后，第二次闲置本仓库首请求 0% 命中、官方 38%（官方静态前缀全球共享、常驻热缓存）；ChatGPT 侧闲置 65 分钟后仍有 97–99% 命中。
- 成功率：CLI 矩阵 5 个 CLI 均 20/20，12 题隐藏测试均 24/24，题组区分度不足。

## CLI 模式（-p / exec，10 类任务 × 2 轮）

| CLI | 成功 | 命中率 | 平均总 token | 未缓存输入 | 输出 | 首个 prompt | 平均 prompt | 平均 TTFT | 平均用时 | 中途失效 |
|---|---|---|---|---|---|---|---|---|---|---|
| 本仓库（Claude OAuth） | 20/20 | 87.9% | 76.2k | 0.0k | 3.3k | 15.5k | 17.2k | 1.75s | 25s | 0 |
| 官方 2.1.319 | 20/20 | 86.5% | 81.2k | 0.0k | 4.0k | 17.3k | 19.4k | 1.74s | 29s | 0 |
| 本仓库（ChatGPT OAuth） | 20/20 | 81.9% | 67.9k | 11.8k | 2.4k | 10.8k | 13.1k | 2.41s | 64s | 1 |
| Codex 0.167.0 | 20/20 | 93.0% | 83.0k | 5.6k | 2.4k | 15.0k | 16.6k | 1.80s | 59s | 0 |
| pi 1.5.0（ChatGPT） | 20/20 | 84.4% | 36.4k | 5.2k | 2.8k | 1.4k | 3.8k | 2.62s | 69s | 3 |

任务：编写代码（短、修 bug + CLI + 测试、从零写表达式语言）、运营维护（磁盘告警、日志/配置/脚本/事故报告）、文档编辑（README、API 文档 + 可执行示例）、推理（逻辑 + Vigenère、多文件证据案件）、数学证明。Claude 侧固定 `claude-sonnet-5-5`，ChatGPT 侧固定 `gpt-6.1-sol`，effort 用各 CLI 默认。

## 交互与多轮

| CLI | 模式 | 命中率 | 平均总 token | 首个 prompt | 请求数 | 平均用时 |
|---|---|---|---|---|---|---|
| 本仓库（Claude OAuth） | TUI 6 轮 | 93.0% | 257.7k | 17.0k | 13.5 | 92s |
| 官方 2.1.319 | TUI 6 轮 | 96.5% | 427.2k | 33.1k | 12.5 | 91s |
| 本仓库（ChatGPT OAuth） | TUI 6 轮 | 91.9% | 310.5k | 11.6k | 23.0 | 163s |
| Codex 0.167.0 | TUI 6 轮 | 94.7% | 267.3k | 14.5k | 16.0 | 143s |
| pi 1.5.0（ChatGPT） | TUI 6 轮 | 89.7% | 80.8k | 1.3k | 26.0 | 140s |
| 本仓库（Claude OAuth） | Web 6 轮 | 93.4% | 250.3k | 16.7k | 12.5 | 77s |
| 本仓库（ChatGPT OAuth） | Web 6 轮 | 88.6% | 292.4k | 11.4k | 21.0 | 150s |
| 本仓库（Claude OAuth） | SDK 4 轮 | 92.3% | 132.9k | 15.5k | 7.0 | 28s |
| 官方 2.1.319 | SDK 4 轮 | 92.0% | 149.7k | 17.4k | 7.0 | 32s |
| 本仓库（ChatGPT OAuth） | SDK 4 轮 | 92.1% | 190.7k | 10.8k | 13.0 | 109s |
| Codex 0.167.0 | SDK 4 轮 | 95.4% | 203.5k | 15.1k | 11.0 | 97s |

## Subagent / Teams（3 个模块各一个 bug，相对单代理的总 token 倍数）

| CLI | 3 个 subagent | Agent Teams 3 人 |
|---|---|---|
| 本仓库（Claude OAuth） | 3.1× | 5.4× |
| 官方 2.1.319 | 4.4× | 5.3×（1/2 次在 `-p` 下约 20 分钟才退出） |
| 本仓库（ChatGPT OAuth） | 4.3× | 9.5× |

## 启动与卡顿（3 轮中位数）

| CLI | `-p` 启动到首请求 | TUI 可输入 | TUI 待机内存 | 串流 CPU |
|---|---|---|---|---|
| 本仓库（Claude OAuth） | 0.76s | 0.40s | 217 MB | 7.5% |
| 官方 2.1.319 | 0.83s | 0.62s | 250 MB | 10.3% |
| 本仓库（ChatGPT OAuth） | 2.82s | 0.46s | 234 MB | 6.2% |
| Codex 0.167.0 | 2.02s | 0.39s | 604 MB | 未测到 |
| pi 1.5.0（ChatGPT） | 0.87s | 0.34s | 99 MB | 3.7% |

TUI 启动后 5–25 秒本仓库有背景预取（约 1.7s CPU，官方 0.4s）；60 秒后两边待机 CPU 都低于 0.5%。

## 口径

- 总 token = 未缓存输入 + 缓存读 + 缓存写 + 输出；命中率 = 缓存读 ÷（未缓存输入 + 缓存读 + 缓存写），按 token 加权。
- 中途失效 = 会话内非首个请求、prompt ≥ 2k、缓存读不到上一请求的一半。
- ChatGPT 没有缓存写入计费项，记 0。Codex `exec` 与 pi `-p` 没有 `/compact`，续接压缩实验只对 Claude Code 系有效。

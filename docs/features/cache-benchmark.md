# 缓存命中与用户体验基准

> 英文名：`cache-benchmark` · 领域：上下文与记忆 · [返回功能索引](README.md)

本 fork（Claude 账号与 ChatGPT 账号两条路径）与官方 Claude Code、Codex CLI、opencode、pi、oh-my-pi、dsh 跑同一批真实任务，比较提示缓存命中率、token 用量、API 等价花费、多代理开销、长时间闲置后的缓存、启动速度和稳定性。全部是真实模型请求，不使用假 API。数据采集于 2026-11-07，共 789 次 run，每格至少 3 次；第 12 节另用 20 道公开基准题（1,800 次 run，2026-11-08 至 11-09）比较通过率。

## 摘要

| 指标 | 本仓库 · Claude 账号 | 官方 Claude Code | 本仓库 · ChatGPT 账号 | Codex CLI | opencode | pi |
| --- | --- | --- | --- | --- | --- | --- |
| CLI 模式命中率（33 次） | **87.1%** | 87.3% | **85.3%** | 88.8% | 89.2% | 84.0% |
| 平均总 token / 任务 | **72.7k** | 81.0k | **75.9k** | 80.3k | 81.5k | 36.5k |
| API 等价花费 / 任务² | **$0.078** | $0.088 | **$0.050** | $0.047 | $0.059 | $0.041 |
| TUI 6 轮总 token | **235k** | 640k | **310k** | 267k | 170k | 80k |
| 3 个 subagent / Teams 3 人（相对单代理） | **2.8× / 6.0×** | 3.7× / 4.0×¹ | **3.8× / 8.5×** | 5.4× / — | 2.0× / — | 无此功能 |
| 长闲置 2.7 小时总 token | **306k** | 349k | **331k** | 361k | 358k | 131k |
| `-p` 启动到首个请求 | **0.82s** | 0.89s | **0.71s** | 2.59s | 2.81s | 0.83s |
| 会话中途整段失效 | **0.0%** | 0.0% | **2.7%** | 0.5% | 3.2% | 4.2% |
| 任务成功 | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 | 33/33 |

¹ 官方 2.1.319 在 `-p` 下把具名 `Agent` 调用当作后台 subagent 运行，没有组成团队。
² 按公开 API 价换算（ChatGPT 列 `gpt-6.1-sol`，Claude 列 `claude-sonnet-5-5`，价格见「口径」）。订阅账号不按 token 计费，这里只用同一张价目表比较。

- **Claude 侧与官方持平**：命中率相差 0.2 个百分点，在噪声范围内；总 token 少 10%；TUI 多轮交互官方用量是本仓库的 2.7 倍；3 个 subagent 时本仓库 2.8 倍、官方 3.7 倍。
- **ChatGPT 侧比 Codex 低 3.5 个百分点**，差距只在短任务（82.9% 对 89.7%）；长任务 86.5% 对 88.3%，接近持平。原因是 Codex 的系统提示在服务器端，新会话第一个请求的未缓存部分只有 2.7k，本仓库 6.3k。
- **多代理**：3 个 subagent 本仓库是单代理的 2.8 倍，官方 3.7 倍；Agent Teams 3 人本仓库 Claude 账号 6.0 倍、ChatGPT 账号 8.5 倍。官方 2.1.319 在 `-p` 下没有真正组队（见第 5 节），它的 4.0 倍不能直接比较。
- **花费**：ChatGPT 侧缓存读只收 1/20 价，四个 CLI 每任务 $0.041–0.059，本仓库比 Codex 贵 6%；Claude 侧本仓库 $0.078、官方 $0.088。
- **长时间闲置**：Claude 侧 1 小时缓存在闲置 65 分钟后过期，下一轮第一个请求本仓库与官方都只剩约 50%；第二次 65 分钟后本仓库 28%、官方 39%。官方的静态前缀全球用户共享、一直是热的，所以新会话第一个请求官方 67%、本仓库 0%。pi 与 opencode 在 Claude 侧只写 5 分钟缓存，闲置 15 分钟以上第一个请求就只剩 0–27%。本仓库 ChatGPT 账号闲置 65 分钟后仍有 97–98%。2.7 小时总 token 本仓库 Claude 306k、官方 349k。
- **差异的量级**：同一 CLI 在不同任务类型之间相差 11–41 个百分点，大于 CLI 之间的差距；ChatGPT 侧同一格重跑平均相差 9 个百分点。单个任务格小于约 10 个百分点的差异不显著，结论以分组合计为准。

## 测试设计

### 对象

| CLI | 版本 | 账号 / 模型 | effort（请求实际携带） |
| --- | --- | --- | --- |
| 本仓库 · Claude 账号 | `dev` `453b1c6` | Claude OAuth · `claude-sonnet-5-5` | 默认 medium |
| 官方 Claude Code | 2.1.319 | Claude OAuth · `claude-sonnet-5-5` | 默认 medium |
| 本仓库 · ChatGPT 账号 | `dev` `453b1c6` | ChatGPT OAuth · `gpt-6.1-sol` | 账号默认 low |
| Codex CLI | 0.167.0 | ChatGPT OAuth · `gpt-6.1-sol` | 账号默认 low |
| opencode | 1.19.5 | ChatGPT OAuth · `gpt-6.1-sol` / Claude API key · `claude-sonnet-5-5` | 默认 low / adaptive |
| pi | 1.5.0（`@earendil-works/pi-coding-agent`） | ChatGPT OAuth · `gpt-6.1-sol` / Claude API key · `claude-sonnet-5-5` | 默认 medium / low |
| oh-my-pi（`omp`） | 18.18.0（`@oh-my-pi/pi-coding-agent`） | ChatGPT OAuth · `gpt-6.1-sol` / Claude API key · `claude-sonnet-5-5` | 默认 high |
| dsh（DeepSeek Harness） | 0.2.2-rc.1（`@deepseek-ai/dsh`，headless） | ChatGPT OAuth · `gpt-6.1-sol` / Claude API key · `claude-sonnet-5-5` | 默认（Claude 侧 low，ChatGPT 侧请求不带 effort） |

pi 与 opencode 另用 Claude API key 跑了一组 `claude-sonnet-5-5`（见第 1、4–6 节）；表中未注明时 pi、opencode 均指 ChatGPT 账号。oh-my-pi 只出现在第 9 节，ssh / k8s 运维排障题见第 10 节，dsh 只出现在第 11 节。

`453b1c6` 与 `990cc05` 的代码相同（之间只有文档提交）。办公 / 编码 / 运维的 CLI 矩阵用 `5c5ce9e`，它与 `990cc05` 的差别只在没有模型目录缓存的首次启动；本基准每个 HOME 都预置了目录缓存，两者结果可合并。

### 任务

四类工作加 Lean 证明，每类一短一长（编码长任务两题），共 11 题，每题每个 CLI 3 次：

| 类型 | 短任务 | 长任务 |
| --- | --- | --- |
| 办公 | 整理 README | 读源码写三份文档并附可执行示例 |
| 研究 | 比较 3 份报价，算 36 个月成本 | 分析 900 条工单与会议记录，写研究报告 |
| 编码 | 写 `slugify` | 修 4 个 bug + CLI + 测试；从零写表达式语言（≥ 30 个测试） |
| 运维 | 磁盘告警排查 | 日志 + 配置 + 脚本 + 事故报告 |
| Lean 4 证明 | 奇数和 + 骑士骗子题 | 等差和、列表反转引理、n² ≤ 2ⁿ、四人赛跑排名题 |

另有五组场景，各 3 次：

| 场景 | 内容 | 参与 CLI |
| --- | --- | --- |
| TUI 6 轮 | 同一组 6 轮对话，tmux 驱动真实终端 | 全部（pi、opencode 两种账号） |
| SDK 4 轮 | 长短结合：stream-json / `exec resume` / `--continue` | 全部（pi、opencode 两种账号） |
| Web 6 轮 | Playwright 驱动 `claude web` | 本仓库（只有本仓库有 Web） |
| 多代理 | 3 个模块各一个 bug：单代理、3 个 subagent、Agent Teams 3 人 | 单代理全部；subagent：Claude Code 系、Codex、opencode；Teams：Claude Code 系 |
| 长闲置 | 7 轮编码，间隔 0 / 4 / 15 / 65 / 4 / 65 / 4 分钟，约 2.7 小时 | 全部（pi、opencode 两种账号） |

判定全部自动：编码与多代理任务跑测试；Lean 用 `lean` 编译，无错误无警告，禁止 `sorry` / `admit` / `axiom` / `native_decide` / `set_option`，定理陈述逐行比对不得改动；研究题自动核对答案与中位数。

### 控制系统性误差

- 每一轮同一任务所有 CLI 同时开跑，时段、配额与后端路由对各方一致。
- 每次 run 使用全新 HOME、相同提示、相同模型；ChatGPT 侧预置账号模型目录缓存（模拟老用户）。
- 所有 CLI 关闭网页搜索与抓取；全部 run 检查过没有搜索调用。
- 每个模型请求经 MITM 记录代理，取 usage、TTFT、请求体大小、模型与 effort；所有 CLI 直连官方端点。
- 每个 run 都核对过：有请求记录，且请求都落在该 run 的起止时间内。

### 已知偏差

- 当天第一个 Claude run 要写入冷的静态前缀（本仓库 `coding-s` 第 1 次命中 49%，之后 87%），属暖机效应，保留在数据里。
- opencode 每个会话先发一个约 0.6k 的生成标题请求，它的「首个 prompt」是这个小请求。
- Codex 的系统提示与工具在服务器端，请求里看不到，首请求未缓存量天然较低。
- 有 subagent 时不同代理的请求交错，「中途失效」只按主代理序列计算。
- 长闲置的 3 次 run 同时开始，后两次的第一个请求可能用上第一次刚写入的前缀。
- 启动测量期间，长闲置 run 在后台待机（无请求），对 CPU 读数的影响小于 1 个百分点。
- opencode 的 TUI / SDK / 长闲置、pi 与 opencode 的 Claude 侧多轮场景、Codex / pi / opencode 的多代理在 17:19–20:00 UTC 补跑，没有与其他 CLI 交错；ChatGPT 侧不同时段同一格可相差约 9 个百分点，跨时段比较以总 token 与花费为主。

### 口径

- **总 token** = 未缓存输入 + 缓存读 + 缓存写 + 输出。
- **命中率** = 缓存读 ÷（未缓存输入 + 缓存读 + 缓存写），按 token 加权；ChatGPT 没有缓存写入计费项，记 0。
- **TTFT** = 请求发出到第一个 token；**启动到首 token** = 进程启动到第一个 token。
- **会话中途整段失效** = 会话内非首个请求、prompt ≥ 4k、缓存读低于 20% 的请求占比。
- 括号内是单次 run 的最低–最高。
- **API 等价花费**（每百万 token）：`gpt-6.1-sol` 输入 $2.00、缓存输入 $0.10、输出 $10.00；`claude-sonnet-5-5` 输入 $2、输出 $10、缓存读 $0.20、5 分钟缓存写 $2.50、1 小时缓存写 $4。

## 结果

### 0. token 与命中率总览

横轴是每任务平均总 token（对数轴，越左越省），纵轴是按 token 加权的缓存命中率（越高越好），左上角最好。只看命中率会奖励把大段前缀放进缓存的做法，只看 token 又看不出缓存帮了多少，两项放在一起才能看出谁在「少用」和「多复用」上都占优。第二张图把横轴换成 API 等价花费，把缓存读、缓存写和输出的不同价格算进去。[交互版](https://claude.ai/artifact/5c7HFWBN11ZAVcFHConfbm)可切换横轴，悬停查看每个点的明细。

颜色区分 CLI，形状区分账号类型：实心圆 = Claude 订阅（OAuth），菱形 = ChatGPT 订阅（OAuth），空心圆 = Claude API key。Claude 订阅与 API key 都用 `claude-sonnet-5-5`，ChatGPT 订阅用 `gpt-6.1-sol`。每个大点 = 11 题 × 3 次；dsh ChatGPT 账号 32 次（1 次 WebSocket 断线未计入）。

![每任务 token 与缓存命中率：7 个 CLI 共 12 个账号组合的散点，含 6 类任务的分项点、Pareto 前沿与更优区域](images/cache-benchmark/tokens-vs-hit-light.png#gh-light-mode-only)
![每任务 token 与缓存命中率：7 个 CLI 共 12 个账号组合的散点，含 6 类任务的分项点、Pareto 前沿与更优区域](images/cache-benchmark/tokens-vs-hit-dark.png#gh-dark-mode-only)

- 前沿上的 6 个点：pi（Claude API）21k / 73.4%、pi（ChatGPT）37k / 84.0%、dsh（Claude API）69k / 88.7%、Codex 80k / 88.8%、opencode（ChatGPT）82k / 89.2%、oh-my-pi（Claude API）101k / 92.0%。
- 更优区域（token 不高于中位数 80.7k 且命中率不低于中位数 87.6%）里是 dsh（Claude API）和 Codex。本仓库 Claude 账号 73k / 87.1% 与官方 81k / 87.3% 都在区域边缘，二者命中率相差 0.2 个百分点，在噪声范围内。
- pi 的提示只有约 2.7k，token 最少但新内容占比大，命中率最低；opencode 在 Claude API key 下 92k / 79.2%，两项都落后于同模型的其他 CLI。

![每任务 API 等价花费与缓存命中率：12 个 CLI × 账号组合的散点，含 6 类任务的分项点、Pareto 前沿与更优区域](images/cache-benchmark/cost-vs-hit-light.png#gh-light-mode-only)
![每任务 API 等价花费与缓存命中率：12 个 CLI × 账号组合的散点，含 6 类任务的分项点、Pareto 前沿与更优区域](images/cache-benchmark/cost-vs-hit-dark.png#gh-dark-mode-only)

花费的计法：所有账号都按同一张公开 API 价目表换算每次 run 的 usage（价格见「口径」），再取平均。ChatGPT 订阅（OAuth）用 `gpt-6.1-sol` 的 OpenAI 价；Claude API key 用 `claude-sonnet-5-5` 的 Anthropic 价，缓存写按各 CLI 实际写入的档位计（本仓库与官方 1 小时，其他 CLI 5 分钟）；本仓库与官方的 Claude 订阅（OAuth）也按同一张 Anthropic 价目表换算。两种订阅本身是包月，实际账单不按 token 计，这里的金额只用于横向比较。两种模型价格不同，跨模型（Claude 侧对 ChatGPT 侧）只看相对位置。

| CLI | 账号 | 模型 | effort | 平均总 token | 命中率 | API 等价花费 / 任务 |
| --- | --- | --- | --- | --- | --- | --- |
| 本仓库 | Claude 订阅 | `claude-sonnet-5-5` | medium（默认） | 72.7k | 87.1% | $0.078 |
| 官方 Claude Code 2.1.319 | Claude 订阅 | `claude-sonnet-5-5` | medium（默认） | 81.0k | 87.3% | $0.088 |
| dsh 0.2.2-rc.1 | Claude API key | `claude-sonnet-5-5` | low（默认） | 69.2k | 88.7% | $0.083 |
| oh-my-pi 18.18.0 | Claude API key | `claude-sonnet-5-5` | high（默认） | 100.8k | 92.0% | $0.091 |
| opencode 1.19.5 | Claude API key | `claude-sonnet-5-5` | adaptive（默认） | 92.0k | 79.2% | $0.119 |
| pi 1.5.0 | Claude API key | `claude-sonnet-5-5` | low（默认） | 21.4k | 73.4% | $0.045 |
| 本仓库 | ChatGPT 订阅 | `gpt-6.1-sol` | low（账号默认） | 75.9k | 85.3% | $0.050 |
| Codex CLI 0.167.0 | ChatGPT 订阅 | `gpt-6.1-sol` | low（账号默认） | 80.3k | 88.8% | $0.047 |
| opencode 1.19.5 | ChatGPT 订阅 | `gpt-6.1-sol` | low（默认） | 81.5k | 89.2% | $0.059 |
| pi 1.5.0 | ChatGPT 订阅 | `gpt-6.1-sol` | medium（默认） | 36.5k | 84.0% | $0.041 |
| dsh 0.2.2-rc.1 | ChatGPT 订阅 | `gpt-6.1-sol` | 未记录（pi-ai 默认） | 134.2k | 89.9% | $0.073 |
| oh-my-pi 18.18.0 | ChatGPT 订阅 | `gpt-6.1-sol` | high（默认） | 104.5k | 88.0% | $0.079 |

effort 取代理日志里请求实际携带的值；dsh 的 ChatGPT 请求没有带 effort 字段。dsh ChatGPT 账号只计成功的 32 次 run；第 11 节的平均把失败那次（约 5k token）也算进 33 次，所以那里是 130.2k / 89.8%。

- Claude 侧本仓库 $0.078，比官方 $0.088 低 12%，也低于 dsh $0.083、oh-my-pi $0.091、opencode $0.119；只有 pi $0.045 更低，因为它的提示只有约 2.7k、effort low。
- ChatGPT 侧缓存读只收输入价的 1/20，各 CLI 差距被压小：pi $0.041、Codex $0.047、本仓库 $0.050、opencode $0.059、dsh $0.073、oh-my-pi $0.079。本仓库比 Codex 贵 6%，差在新会话第一个请求的未缓存部分（6.3k 对 2.7k）。
- 前沿：pi（ChatGPT）$0.041 / 84.0%、Codex $0.047 / 88.8%、opencode（ChatGPT）$0.059 / 89.2%、dsh（ChatGPT）$0.073 / 89.9%、oh-my-pi（Claude API）$0.091 / 92.0%。更优区域（花费不高于中位数 $0.075 且命中率不低于中位数 87.6%）里是 Codex、opencode 与 dsh 的 ChatGPT 账号；Claude 侧的点都在中位数右边，是两种模型价目不同造成的。

![按任务类型：每类一个面板的 token 与命中率散点](images/cache-benchmark/tokens-vs-hit-by-type-light.png#gh-light-mode-only)
![按任务类型：每类一个面板的 token 与命中率散点](images/cache-benchmark/tokens-vs-hit-by-type-dark.png#gh-dark-mode-only)

- 同一 CLI 在不同任务类型之间的位置变化，大于同一类型里 CLI 之间的差距。
- Claude 订阅（本仓库、官方）在研究、运维、Lean 三类处于前沿或贴近前沿；编码类两者都是 81%，低于 ChatGPT 订阅的 83–91%。
- 排障（ssh / Kubernetes 4 题）：oh-my-pi（Claude API）91k / 92.2% 命中最高；本仓库 Claude 95k / 89.9% 与官方 99k / 90.0% 持平；本仓库 ChatGPT 76k / 79.5%，低于 Codex 127k / 90.0%。
- Claude API key 的 opencode 在研究、编码、运维、Lean 四类比同模型的 Claude 订阅低 9–18 个百分点；办公类命中率接近，但 token 是 205k。pi 在每一类都是 token 最少的点。

![交互、多代理与长闲置场景：每个场景一个面板的 token 与命中率散点](images/cache-benchmark/tokens-vs-hit-scenarios-light.png#gh-light-mode-only)
![交互、多代理与长闲置场景：每个场景一个面板的 token 与命中率散点](images/cache-benchmark/tokens-vs-hit-scenarios-dark.png#gh-dark-mode-only)

- 6 轮交互：前沿是 pi（Claude API）60k / 90.4%、opencode（Claude API）176k / 90.4%、本仓库 Claude TUI 235k / 94.8%、官方 640k / 97.3%。官方命中率最高，但 token 是本仓库的 2.7 倍。Web 只有本仓库有，其他 CLI 没有 Web 界面。
- SDK 4 轮：本仓库 Claude 133k / 92.1% 在前沿上，官方 155k / 92.5%。
- 多代理：同一任务从单代理到 3 个 subagent，Codex 356k / 95.1%、dsh（Claude API）178k / 93.6%、oh-my-pi（Claude API）230k / 90.1% 命中最高；本仓库两个账号 subagent 在 80–81%。Agent Teams 只有本仓库与官方有：本仓库 Claude 337k / 89.8%、ChatGPT 498k / 82.6%。pi 没有 subagent。
- 长时间闲置：ChatGPT 侧缓存没有过期，opencode 358k / 94.8%、Codex 361k / 92.7%、本仓库 331k / 91.6%；Claude 侧本仓库与官方写 1 小时缓存，65 分钟后过期，306k / 81.8% 与 349k / 85.9%；pi 与 opencode 在 Claude 侧写 5 分钟缓存，闲置 15 分钟以上就过期，73.0% 与 76.6%。

### 1. 总体命中率

![CLI 模式命中率：每个 CLI 33 次 run 的平均值与分布](images/cache-benchmark/hit-rate-overall-light.png#gh-light-mode-only)
![CLI 模式命中率：每个 CLI 33 次 run 的平均值与分布](images/cache-benchmark/hit-rate-overall-dark.png#gh-dark-mode-only)

CLI 模式（`-p` / `exec` / `run`），每个 CLI 33 次，表中 token 为每次 run 的平均值：

| CLI | 成功 | 命中率（单次范围） | 平均总 token | 未缓存输入 | 缓存读 | 缓存写 | 输出 | 首个 prompt | 平均 prompt | 请求数 | 平均请求体 | 平均 TTFT | 平均用时 | API 等价花费（单次范围） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 33/33 | 87.1%（49–93） | 72.7k | 0.0k | 60.7k | 9.0k | 3.0k | 15.5k | 17.2k | 4.0 | 46 KB | 2.59s | 26s | $0.078（0.039–0.174） |
| 官方 Claude Code 2.1.319 | 33/33 | 87.3%（77–94） | 81.0k | 0.0k | 67.7k | 9.8k | 3.5k | 17.1k | 19.0k | 4.0 | 15 KB | 2.50s | 30s | $0.088（0.039–0.238） |
| 本仓库 · ChatGPT 账号 | 33/33 | 85.3%（50–93） | 75.9k | 10.8k | 62.9k | 0.0k | 2.2k | 10.4k | 12.7k | 5.6 | 59 KB | 3.05s | 61s | $0.050（0.021–0.105） |
| Codex CLI 0.167.0 | 33/33 | 88.8%（79–96） | 80.3k | 8.8k | 69.3k | 0.0k | 2.2k | 14.6k | 16.1k | 4.8 | 19 KB | 2.40s | 59s | $0.047（0.014–0.110） |
| opencode 1.19.5 | 33/33 | 89.2%（71–96） | 81.5k | 8.4k | 69.6k | 0.0k | 3.6k | 0.7k | 7.3k | 9.3 | 33 KB | 2.97s | 95s | $0.059（0.013–0.182） |
| pi 1.5.0 | 33/33 | 84.0%（37–95） | 36.5k | 5.4k | 28.4k | 0.0k | 2.7k | 1.4k | 3.6k | 7.5 | 4 KB | 3.16s | 74s | $0.041（0.008–0.133） |

新会话第一个请求：

| CLI | 首个 prompt | 其中命中 | 未缓存 | 启动到首 token |
| --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 15.5k | 10.0k | 5.4k | 3.4s |
| 官方 Claude Code 2.1.319 | 17.1k | 11.4k | 5.7k | 3.6s |
| 本仓库 · ChatGPT 账号 | 10.4k | 4.1k | 6.3k | 3.9s |
| Codex CLI 0.167.0 | 14.6k | 11.8k | 2.7k | 5.5s |
| opencode 1.19.5 | 0.7k | 0.0k | 0.7k | 5.3s |
| pi 1.5.0 | 1.4k | 0.0k | 1.4k | 3.4s |

opencode 的第一个请求是生成标题的小请求；它第一个带工具的请求平均 5.0k，其中缓存 2.9k（33 次中 6 次为 0）。

官方请求体更小，是因为它用服务器端 thread 续接，只发送增量；计费 token 不受影响。ChatGPT 侧缓存读只收 1/20 价，所以四个 CLI 的花费差距比 token 差距小。

**Claude 模型下的 pi 与 opencode**：pi 和 opencode 另用 Claude API key 跑同样 11 题 × 3 次（`claude-sonnet-5-5`，二者交错运行；本仓库与官方沿用上表 OAuth 数据）。API 等价花费按 Anthropic 公开价计算。

| CLI | 成功 | 命中率（单次范围） | 平均总 token（单次范围） | 缓存读 | 缓存写 | 输出 | 首个 prompt | 平均 TTFT | 平均用时 | 请求数 | API 等价花费 / run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 33/33 | 87.1%（49–93） | 72.7k（32–149k） | 60.7k | 9.0k | 3.0k | 15.5k | 2.6s | 26s | 4.0 | $0.078 |
| 官方 Claude Code 2.1.319 | 33/33 | 87.3%（77–94） | 81.0k（36–159k） | 67.7k | 9.8k | 3.5k | 17.1k | 2.5s | 30s | 4.0 | $0.088 |
| opencode 1.19.5 | 33/33 | 79.2%（59–89） | 92.0k（34–440k） | 68.0k | 17.9k | 6.1k | 10.6k | 2.3s | 45s | 6.1 | $0.119 |
| pi 1.5.0 | 33/33 | 73.4%（32–83） | 21.4k（10–77k） | 13.5k | 4.9k | 3.0k | 2.7k | 2.1s | 23s | 4.0 | $0.045 |

短任务命中率 86.8% / 87.1% / 67.5% / 77.9%，长任务 87.3% / 87.4% / 81.9% / 71.9%（顺序同上表）。四个 CLI 会话中途失效都是 0。pi 命中率低是因为提示只有约 2.7k，新内容占比大，并非缓存失效；opencode 每个会话的第一个请求缓存读都是 0（33/33），另外三个能复用跨会话前缀。本仓库与官方写 1 小时缓存，pi 与 opencode 写 5 分钟缓存。这两组用 API key、在另一时段运行，没有与本仓库、官方交错，比较时有时段偏差。

### 2. 短任务与长任务

![短任务与长任务的命中率](images/cache-benchmark/hit-rate-short-long-light.png#gh-light-mode-only)
![短任务与长任务的命中率](images/cache-benchmark/hit-rate-short-long-dark.png#gh-dark-mode-only)

| CLI | 短任务（15 次） | 长任务（18 次） |
| --- | --- | --- |
| 本仓库 · Claude 账号 | 86.8%（49–93）/ 53.2k | 87.3%（79–91）/ 89.0k |
| 官方 Claude Code 2.1.319 | 87.1%（81–90）/ 53.9k | 87.4%（77–94）/ 103.6k |
| 本仓库 · ChatGPT 账号 | 82.9%（50–91）/ 52.7k | 86.5%（77–93）/ 95.2k |
| Codex CLI 0.167.0 | 89.7%（85–94）/ 58.9k | 88.3%（79–96）/ 98.1k |
| opencode 1.19.5 | 84.6%（71–90）/ 28.4k | 90.1%（73–96）/ 125.8k |
| pi 1.5.0 | 59.6%（37–78）/ 7.7k | 86.6%（64–95）/ 60.5k |

格式：命中率（单次范围）/ 平均总 token。短任务总量小，新会话第一个请求的未命中占比大；Codex 是唯一短任务高于长任务的 CLI，原因同上。

### 3. 按任务类型

![按任务类型的命中率热力图](images/cache-benchmark/hit-rate-by-type-light.png#gh-light-mode-only)
![按任务类型的命中率热力图](images/cache-benchmark/hit-rate-by-type-dark.png#gh-dark-mode-only)

每个任务 × CLI（命中率 · 平均总 token · 平均用时，各 3 次）：

| 任务 | 本仓库 · Claude | 官方 2.1.319 | 本仓库 · ChatGPT | Codex 0.167.0 | opencode 1.19.5 | pi 1.5.0 |
| --- | --- | --- | --- | --- | --- | --- |
| 办公・短 `doc` | 87% · 48.2k · 11s | 87% · 53.4k · 12s | 82% · 44.0k · 22s | 89% · 68.6k · 31s | 87% · 22.9k · 29s | 54% · 5.0k · 17s |
| 办公・长 `doc-l` | 86% · 109.3k · 61s | 84% · 124.3k · 86s | 86% · 104.7k · 154s | 91% · 101.5k · 147s | 91% · 170.0k · 293s | 95% · 113.0k · 272s |
| 研究・短 `research-s` | 87% · 49.5k · 15s | 87% · 54.7k · 15s | 83% · 49.4k · 33s | 89% · 63.2k · 30s | 84% · 41.4k · 50s | 63% · 10.9k · 26s |
| 研究・长 `research-l` | 91% · 85.8k · 22s | 91% · 94.2k · 22s | 88% · 59.9k · 51s | 92% · 81.8k · 49s | 90% · 100.9k · 95s | 64% · 12.1k · 37s |
| 编码・短 `coding-s` | 78% · 43.3k · 14s | 84% · 42.2k · 11s | 85% · 54.9k · 23s | 89% · 61.7k · 21s | 83% · 28.1k · 26s | 57% · 7.7k · 19s |
| 编码・长 `coding` | 83% · 53.3k · 25s | 83% · 58.8k · 26s | 89% · 85.0k · 72s | 89% · 91.5k · 68s | 91% · 92.0k · 98s | 73% · 30.2k · 77s |
| 编码・长 `longcode` | 82% · 76.1k · 47s | 77% · 75.8k · 58s | 91% · 81.5k · 139s | 93% · 93.2k · 146s | 89% · 124.4k · 221s | 88% · 92.9k · 194s |
| 运维・短 `ops-s` | 87% · 48.2k · 15s | 88% · 59.7k · 14s | 77% · 51.2k · 24s | 91% · 61.8k · 22s | 87% · 22.7k · 25s | 53% · 6.7k · 20s |
| 运维・长 `ops` | 89% · 128.8k · 35s | 90% · 135.3k · 34s | 86% · 150.0k · 80s | 83% · 144.0k · 75s | 91% · 226.4k · 134s | 84% · 92.7k · 81s |
| Lean・短 `lean-s` | 91% · 76.7k · 17s | 89% · 59.3k · 15s | 86% · 64.3k · 29s | 91% · 39.3k · 21s | 83% · 26.8k · 26s | 65% · 8.4k · 22s |
| Lean・长 `lean-l` | 90% · 80.6k · 26s | 92% · 133.2k · 34s | 81% · 90.2k · 51s | 85% · 76.8k · 39s | 83% · 40.9k · 49s | 80% · 22.2k · 52s |

pi 在短任务和研究题上命中率低，是因为它的系统提示与工具定义只有约 1.4k，总量太小，未缓存的新输入占比大；按总 token 算它最省。

### 4. 交互与多轮

![TUI 6 轮交互的总 token](images/cache-benchmark/tui-tokens-light.png#gh-light-mode-only)
![TUI 6 轮交互的总 token](images/cache-benchmark/tui-tokens-dark.png#gh-dark-mode-only)

| CLI | 模式 | 成功 | 命中率（单次范围） | 平均总 token | 未缓存输入 | 缓存读 | 缓存写 | 输出 | 首个 prompt | 平均 prompt | 请求数 | 平均 TTFT | 平均用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | TUI 6 轮 | 3/3 | 94.8%（95–95） | 234.8k | 1.2k | 218.8k | 10.7k | 4.0k | 17.0k | 20.3k | 12.3 | 2.13s | 96s |
| 官方 Claude Code 2.1.319 | TUI 6 轮 | 3/3 | 97.3%（97–97） | 640.2k | 4.1k | 618.6k | 12.9k | 4.7k | 32.9k | 36.6k | 18.3 | 1.48s | 104s |
| 本仓库 · ChatGPT 账号 | TUI 6 轮 | 3/3 | 91.0%（89–94） | 309.8k | 27.6k | 279.2k | 0.0k | 2.9k | 11.6k | 13.9k | 23.0 | 2.57s | 182s |
| Codex CLI 0.167.0 | TUI 6 轮 | 3/3 | 93.1%（92–94） | 266.7k | 18.1k | 245.4k | 0.0k | 3.3k | 14.5k | 17.1k | 16.0 | 2.11s | 149s |
| pi 1.5.0 | TUI 6 轮 | 3/3 | 83.5%（81–86） | 80.4k | 12.8k | 65.0k | 0.0k | 2.6k | 1.3k | 3.0k | 25.7 | 2.09s | 154s |
| opencode 1.19.5 | TUI 6 轮 | 3/3 | 90.2%（88–95） | 169.8k | 16.3k | 149.7k | 0.0k | 3.7k | 0.5k | 7.7k | 21.7 | 2.76s | 186s |
| pi 1.5.0 · Claude API key | TUI 6 轮 | 3/3 | 90.4%（90–91） | 60.0k | 0.0k | 50.8k | 5.4k | 3.8k | 2.5k | 4.8k | 11.7 | 1.59s | 88s |
| opencode 1.19.5 · Claude API key | TUI 6 轮 | 3/3 | 90.4%（90–91） | 176.1k | 0.0k | 154.8k | 16.3k | 4.9k | 11.1k | 13.8k | 13.3 | 1.33s | 95s |
| 本仓库 · Claude 账号 | SDK 4 轮 | 3/3 | 92.1%（92–92） | 133.4k | 0.0k | 119.2k | 10.2k | 4.0k | 15.5k | 18.5k | 7.0 | 2.54s | 38s |
| 官方 Claude Code 2.1.319 | SDK 4 轮 | 3/3 | 92.5%（92–93） | 154.8k | 0.0k | 139.2k | 11.3k | 4.3k | 17.2k | 20.5k | 7.3 | 3.23s | 46s |
| 本仓库 · ChatGPT 账号 | SDK 4 轮 | 3/3 | 91.9%（90–93） | 177.5k | 14.0k | 159.9k | 0.0k | 3.6k | 10.4k | 14.5k | 12.0 | 3.44s | 112s |
| Codex CLI 0.167.0 | SDK 4 轮 | 3/3 | 90.7%（89–91） | 201.0k | 18.4k | 178.9k | 0.0k | 3.7k | 15.1k | 18.5k | 10.7 | 2.55s | 118s |
| pi 1.5.0 | SDK 4 轮 | 3/3 | 86.0%（81–91） | 82.1k | 11.0k | 67.5k | 0.0k | 3.6k | 1.4k | 4.6k | 17.0 | 2.37s | 119s |
| opencode 1.19.5 | SDK 4 轮 | 3/3 | 88.9%（87–90） | 188.3k | 20.4k | 163.1k | 0.0k | 4.7k | 0.7k | 9.2k | 20.0 | 2.67s | 158s |
| pi 1.5.0 · Claude API key | SDK 4 轮 | 3/3 | 83.9%（84–84） | 45.1k | 0.0k | 34.4k | 6.6k | 4.0k | 2.8k | 5.9k | 7.0 | 1.51s | 30s |
| opencode 1.19.5 · Claude API key | SDK 4 轮 | 3/3 | 84.1%（83–85） | 123.8k | 0.0k | 99.5k | 18.7k | 5.5k | 10.8k | 15.3k | 8.7 | 1.75s | 51s |
| 本仓库 · Claude 账号 | Web 6 轮 | 3/3 | 94.0%（91–96） | 242.3k | 0.0k | 223.8k | 14.3k | 4.1k | 16.7k | 19.8k | 12.0 | 1.54s | 81s |
| 本仓库 · ChatGPT 账号 | Web 6 轮 | 3/3 | 86.5%（83–89） | 295.8k | 39.5k | 253.4k | 0.0k | 3.0k | 11.0k | 13.7k | 21.3 | 2.90s | 167s |

官方 TUI 命中率更高，但首个 prompt 是本仓库的 2 倍、请求数多 50%，绝对用量大得多。命中率高不等于更省，比较成本以总 token 为准。opencode 与 pi 没有 stream-json 输入，SDK 场景用「每轮一个新进程 + `--continue`」接续同一会话；opencode 每轮先发一个标题请求，计入总量。Web 6 轮只有本仓库有 Web 界面，其他 CLI 不适用。

### 5. 多代理协作

![多代理协作的 token 倍数](images/cache-benchmark/multi-agent-light.png#gh-light-mode-only)
![多代理协作的 token 倍数](images/cache-benchmark/multi-agent-dark.png#gh-dark-mode-only)

| CLI | 方式 | 成功 | 平均总 token（单次范围） | 相对单代理 | 命中率 | 请求数 | 平均用时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 单代理 | 3/3 | 55.8k（50–67k） | 1.0× | 87.4% | 3.3 | 12s |
| 本仓库 · Claude 账号 | 3 个 subagent | 3/3 | 156.2k（155–157k） | 2.8× | 80.6% | 12.0 | 27s |
| 本仓库 · Claude 账号 | Agent Teams 3 人 | 3/3 | 337.0k（336–338k） | 6.0× | 89.8% | 20.0 | 25s |
| 官方 Claude Code 2.1.319 | 单代理 | 3/3 | 61.5k（56–73k） | 1.0× | 87.5% | 3.3 | 13s |
| 官方 Claude Code 2.1.319 | 3 个 subagent | 3/3 | 225.8k（205–236k） | 3.7× | 85.1% | 15.3 | 26s |
| 官方 Claude Code 2.1.319 | Agent Teams 3 人 | 3/3 | 243.8k（230–251k） | 4.0× | 88.1% | 16.3 | 21s |
| 本仓库 · ChatGPT 账号 | 单代理 | 3/3 | 58.8k（57–60k） | 1.0× | 87.5% | 5.0 | 27s |
| 本仓库 · ChatGPT 账号 | 3 个 subagent | 3/3 | 223.1k（217–233k） | 3.8× | 80.3% | 26.0 | 53s |
| 本仓库 · ChatGPT 账号 | Agent Teams 3 人 | 3/3 | 497.8k（429–546k） | 8.5× | 82.6% | 42.0 | 74s |
| Codex CLI 0.167.0 | 单代理 | 3/3 | 66.6k（66–67k） | 1.0× | 87.2% | 4.0 | 28s |
| Codex CLI 0.167.0 | 3 个 subagent | 3/3 | 356.5k（324–406k） | 5.4× | 95.1% | 22.0 | 38s |
| opencode 1.19.5 | 单代理 | 3/3 | 63.1k（61–67k） | 1.0× | 87.5% | 10.3 | 53s |
| opencode 1.19.5 | 3 个 subagent | 3/3 | 128.9k（128–130k） | 2.0× | 83.1% | 25.0 | 76s |
| pi 1.5.0 | 单代理 | 3/3 | 14.7k（14–15k） | 1.0× | 70.2% | 7.0 | 27s |
| opencode 1.19.5 · Claude API key | 单代理 | 3/3 | 36.9k（36–38k） | 1.0× | 75.1% | 4.0 | 13s |
| opencode 1.19.5 · Claude API key | 3 个 subagent | 3/3 | 157.1k（155–161k） | 4.3× | 86.5% | 16.0 | 27s |
| pi 1.5.0 · Claude API key | 单代理 | 3/3 | 11.9k（11–12k） | 1.0× | 75.2% | 3.0 | 9s |

任务：`dates.py`、`money.py`、`textwrap2.py` 各有一个 bug，修好后跑测试。subagent 与 Teams 只在提示里多一句「每个模块交给一个 subagent / 队员」；Teams 提示要求给每个队员命名，9 次 run 都发出了 3 个具名 `Agent` 调用。本仓库的队员是真正的团队成员：带完整主提示和队员附加说明，通过邮箱汇报，收尾时还要处理关闭请求，因此比 subagent 多用 token。官方 2.1.319 在 `-p` 下返回「Async agent launched successfully」，按后台 subagent 运行、没有邮箱，之后的关闭消息报「Task dates is not running」，即实际没有组队；表中官方 Teams 一行只作参考。Teams 用 `dev` `3da7a1d`，它比 `453b1c6` 只多一处 `-p` 下 Teams 收尾时机的改动（[#1038](https://github.com/Esonhugh/claude-code/pull/1038)）。ChatGPT 下每个队员约 8 个请求（模型多为每步一个工具调用），所以请求数和总 token 高于 Claude 侧；约 85% 是缓存读。

Codex 与 opencode 用各自的子代理工具（Codex `spawn_agent`，0.167.0 默认开启；opencode `task`），提示里只把「Agent tool」换成对应工具名；每次 run 都确认开出了子代理。Codex 的 3 个子代理各带完整前缀，总 token 是单代理的 5.4 倍，但命中 95.1%，按 API 价只有 $0.084，低于本仓库 ChatGPT 的 $0.133。pi 没有子代理功能，只有单代理一格。只有 Claude Code 系有 Agent Teams。

### 6. 长时间闲置后的缓存

![长时间闲置：每轮第一个请求的命中率](images/cache-benchmark/long-idle-light.png#gh-light-mode-only)
![长时间闲置：每轮第一个请求的命中率](images/cache-benchmark/long-idle-dark.png#gh-dark-mode-only)

同一会话 7 轮编码（读代码列 bug、修 bug、补测试、加两个 CLI 子命令、写 CHANGES.md、最后跑测试），轮间闲置 0 / 4 / 15 / 65 / 4 / 65 / 4 分钟，整个会话约 2.7 小时，用 SDK 多轮方式驱动（Claude Code 系 stream-json，Codex `exec resume`，pi 与 opencode `--continue`）。

| CLI | 成功 | 总 token（单次范围） | 缓存写 | 整体命中率 | 请求数 | 每轮第一个请求命中率（3 次平均） | API 等价花费 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 3/3 | 306k（301–312k） | 54.3k | 81.8% | 14.0 | 0 / 97 / 98 / 50 / 96 / 28 / 99 | $0.350 |
| 官方 Claude Code 2.1.319 | 3/3 | 349k（340–360k） | 47.6k | 85.9% | 14.0 | 67 / 97 / 98 / 50 / 99 / 39 / 99 | $0.353 |
| 本仓库 · ChatGPT 账号 | 3/3 | 331k（294–373k） | 0 | 91.6% | 23.0 | 35 / 81 / 92 / 98 / 97 / 97 / 99 | $0.132 |
| Codex CLI 0.167.0 | 3/3 | 361k（338–373k） | 0 | 92.7% | 18.3 | 82 / 91 / 96 / 94 / 80 / 97 / 99 | $0.142 |
| pi 1.5.0 | 3/3 | 131k（117–149k） | 0 | 83.1% | 25.0 | 0 / 31 / 96 / 55 / 97 / 97 / 97 | $0.104 |
| opencode 1.19.5 | 3/3 | 358k（296–470k） | 0 | 94.8% | 32.7 | 73 / 97 / 98 / 99 / 98 / 99 / 99 | $0.145 |
| pi 1.5.0 · Claude API key | 3/3 | 100k（94–107k） | 25k | 73.0% | 14.0 | 52 / 89 / 27 / 14 / 96 / 5 / 99 | $0.142 |
| opencode 1.19.5 · Claude API key | 3/3 | 370k（298–468k） | 82k | 76.6% | 20.3 | 0 / 96 / 0 / 0 / 98 / 0 / 99 | $0.388 |

- Claude 侧两次 65 分钟闲置后，第一个请求只命中静态前缀（约一半）；第二次本仓库单次为 0–43%，官方 38–40%。官方的静态前缀被全球用户持续使用，始终在缓存里；本仓库的前缀只有自己用，闲置后容易过期。
- 新会话第一个请求：官方 67%、本仓库 0%（3 次同时冷启动，前缀都还没写入）。CLI 矩阵里本仓库首请求平均命中 10.0k，是因为当天已有其他 run 写过前缀。
- ChatGPT 侧缓存保留时间更长：闲置 65 分钟后，本仓库 ChatGPT 账号 97–98%，Codex 94–97%；pi 第一次 65 分钟后平均 55%（单次 0–97%），第二次 97%。单次的整段失效（如 Codex 第 5 轮一次 60%、pi 第 2 轮两次 0%）出现在短闲置之后，与闲置时长无关。
- pi 与 opencode 在 Claude 侧只写 5 分钟缓存：闲置 15 分钟及以上后，下一轮第一个请求 opencode 每次都是 0%，pi 只剩 5–27%（部分前缀仍在缓存里）。所以 opencode 在 Claude 侧 2.7 小时用了 370k、$0.388，是全表最贵；同一工具在 ChatGPT 侧闲置后仍有 97–99%。
- opencode 每轮先发一个标题请求，表中「每轮第一个请求」取该轮第一个带工具的请求。
- 总 token 本仓库 Claude 比官方少 12%，ChatGPT 账号比 Codex 少 8%。

### 7. 稳定性：会话中途整段失效

| CLI | 失效请求 / 统计请求 | 比例 | 损失的缓存读 |
| --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 0 / 195 | 0.0% | 0 |
| 官方 Claude Code 2.1.319 | 0 / 182 | 0.0% | 0 |
| Codex CLI 0.167.0 | 1 / 215 | 0.5% | 16.1k |
| 本仓库 · ChatGPT 账号 | 9 / 330 | 2.7% | 117.4k |
| opencode 1.19.5 | 10 / 315 | 3.2% | 52.1k |
| pi 1.5.0 | 6 / 142 | 4.2% | 52.5k |

统计范围是 CLI 矩阵全部 run 的主代理请求。ChatGPT 侧的失效发生在 `tools` 与前缀都没变的请求上，来自 OpenAI 后端路由，客户端无法修正；改走 WebSocket 的 10 组对照没有改善（WebSocket 6.3%、SSE 4.1%），Bun 下只用 SSE（记录在 [#1023](https://github.com/Esonhugh/claude-code/issues/1023)）。

### 8. 启动与资源占用

| CLI | `-p` 启动到首个请求 | `-p` 峰值内存 | TUI 可输入 | TUI 待机内存 | 启动后 5–25s CPU | 串流 CPU | 串流峰值内存 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 本仓库 · Claude 账号 | 0.82s（0.77–0.88） | 248 MB | 0.52s | 220 MB | 9.3% | 8.0% | 264 MB |
| 官方 Claude Code 2.1.319 | 0.89s（0.87–0.95） | 254 MB | 0.73s | 240 MB | 1.9% | 10.7% | 281 MB |
| 本仓库 · ChatGPT 账号 | 0.71s（0.70–0.76） | 249 MB | 0.51s | 233 MB | 10.5% | 5.5% | 277 MB |
| Codex CLI 0.167.0 | 2.59s（2.17–3.35） | 209 MB | 0.40s | 597 MB | 1.1% | 未测到 | 629 MB |
| pi 1.5.0 | 0.83s（0.79–0.88） | 125 MB | 0.40s | 99 MB | 0.5% | 3.4% | 133 MB |
| opencode 1.19.5 | 2.81s（2.75–2.91） | 588 MB | 4.83s | 566 MB | 3.9% | 未测准 | — |

各 3 次取中位数。串流 CPU = 让模型输出约 800 字期间整个进程树的 CPU 占用；官方第 1 次串流测量超时，取另外 2 次；Codex TUI 的串流时间太短，测不到；opencode 的 `-p` 首个请求是标题请求，它的 TUI 串流期间还有其他请求，串流 CPU 没有测准，不列。本仓库启动后 5–25 秒有背景预取，CPU 比官方高；60 秒后两边待机 CPU 都低于 0.5%。

### 9. oh-my-pi（功能更多的 pi 分支）

oh-my-pi 18.18.0（`omp`）在 pi 的基础上多了 glob、grep、eval、task（子代理）、wait、todo 等工具，共 10 个（关闭 web_search），默认 effort high。它和 pi 1.5.0 同一时段交错跑全部 11 题 × 3 次，两种账号各一组，132 次全部通过（Lean 两题稍后补跑）。表中本仓库与其他 CLI 取主矩阵同 11 题的数据。

| CLI | 账号 | 命中率（单次范围） | 平均总 token（单次范围） | 输出 | 首个 prompt | 平均用时 | 请求数 | API 等价花费 / 任务 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| oh-my-pi 18.18.0 | Claude API key | 92.0%（74–97） | 100.8k（37–550k） | 5.4k | 11.9k | 42s | 5.5 | $0.091 |
| pi 1.5.0（同时段） | Claude API key | 69.5%（33–83） | 19.6k（9–57k） | 3.1k | 2.7k | 23s | 3.8 | $0.046 |
| 本仓库 | Claude 账号 | 87.1%（49–93） | 72.7k（32–149k） | 3.0k | 15.5k | 26s | 4.0 | $0.078 |
| 官方 Claude Code 2.1.319 | Claude 账号 | 87.3%（77–94） | 81.0k（36–159k） | 3.5k | 17.1k | 30s | 4.0 | $0.088 |
| oh-my-pi 18.18.0 | ChatGPT 账号 | 88.0%（49–97） | 104.5k（31–445k） | 4.6k | 6.9k | 117s | 8.7 | $0.079 |
| pi 1.5.0（同时段） | ChatGPT 账号 | 81.1%（28–95） | 35.4k（5–121k） | 2.5k | 1.4k | 69s | 7.8 | $0.040 |
| 本仓库 | ChatGPT 账号 | 85.3%（50–93） | 75.9k（44–151k） | 2.2k | 10.4k | 61s | 5.6 | $0.050 |
| Codex CLI 0.167.0 | ChatGPT 账号 | 88.8%（79–96） | 80.3k（39–165k） | 2.2k | 14.6k | 59s | 4.8 | $0.047 |

- 前缀从 pi 的 2.7k 变成 11.9k，加上默认 effort high，oh-my-pi 的 token 是同时段 pi 的 3.0–5.1 倍、本仓库的 1.4 倍；固定前缀占比大，所以命中率反而最高。按 API 价它约是 pi 的 2 倍，比本仓库贵 17%（Claude）到 58%（ChatGPT）。
- Lean 两题：Claude 侧 lean-s 46.8k / 88%、lean-l 137.1k / 96%；ChatGPT 侧 lean-s 49.6k / 87%、lean-l 90.4k / 88%。
- 3 个子代理（与第 5 节同题）：Claude 侧 40.1k → 230.0k（5.7×），ChatGPT 侧 65.5k → 196.2k（3.0×）。
- oh-my-pi 在 Anthropic 侧用服务器端对话续接，第二个请求起只发增量；usage 仍完整计入缓存读。Claude 侧它写 5 分钟缓存。

### 10. 运维排障：ssh 与 Kubernetes 真实环境

主矩阵的两道运维题不碰真实系统，这组补了 4 道在真实环境里排障的题：

| 任务 | 环境 | 植入故障 |
| --- | --- | --- |
| `ssh-s` | 每次 run 一台全新 docker sshd 靶机，agent 只有 ops 账号密钥 | `/home/deploy/.ssh` 权限 0777，StrictModes 拒绝登录 |
| `ssh-l` | 同上，另有 runbook 与 healthcheck | AllowUsers 拼错、home 可组写、shell 为 nologin、authorized_keys 限制来源、日志目录属主错误，共 5 处 |
| `k8s-s` | 真实 k3s v1.31.4 集群，每次 run 独立 namespace | 环境变量名拼错导致 CrashLoopBackOff |
| `k8s-l` | 同上：frontend → backend Service → backend + worker | Service selector、readiness 端口、frontend 地址端口、worker 资源请求过大，共 4 处 |

判定全部自动（登录与安全配置检查、Deployment Ready、经 Service 取到数据、INCIDENT.md 覆盖根因），并记录 run 期间对靶机的 `docker exec`（120 次都是 0）。10 个 CLI × 4 题 × 3 次 = 120 次，全部通过，用 `dev` `19b3d5e`，18:59–19:28 UTC 交错运行。

| CLI | 账号 | 命中率（单次范围） | 平均总 token（单次范围） | 请求数 | 平均用时 |
| --- | --- | --- | --- | --- | --- |
| 本仓库 | Claude 账号 | 89.9%（86–97） | 95.4k（50–168k） | 4.9 | 33s |
| 官方 Claude Code 2.1.319 | Claude 账号 | 90.0%（86–97） | 99.2k（54–158k） | 4.8 | 40s |
| pi 1.5.0 | Claude API key | 77.5%（65–86） | 31.3k（12–70k） | 4.9 | 25s |
| opencode 1.19.5 | Claude API key | 75.4%（64–84） | 69.2k（35–133k） | 5.6 | 35s |
| oh-my-pi 18.18.0 | Claude API key | 92.2%（90–95） | 91.4k（39–174k） | 5.3 | 41s |
| 本仓库 | ChatGPT 账号 | 79.5%（64–90） | 76.2k（32–124k） | 5.5 | 60s |
| Codex CLI 0.167.0 | ChatGPT 账号 | 90.0%（86–95） | 126.7k（65–263k） | 6.2 | 51s |
| pi 1.5.0 | ChatGPT 账号 | 73.5%（26–83） | 34.7k（6–73k） | 5.8 | 48s |
| opencode 1.19.5 | ChatGPT 账号 | 84.4%（54–91） | 116.7k（16–265k） | 10.4 | 80s |
| oh-my-pi 18.18.0 | ChatGPT 账号 | 88.5%（73–95） | 164.8k（32–309k） | 10.0 | 103s |

每格 12 次（4 题 × 3）。分题（平均总 token · 命中率，各 3 次）：

| CLI | `ssh-s` | `ssh-l` | `k8s-s` | `k8s-l` |
| --- | --- | --- | --- | --- |
| 本仓库 · Claude | 50.1k · 89.8% | 136.5k · 92.2% | 67.6k · 88.3% | 127.3k · 88.5% |
| 官方 2.1.319 | 54.7k · 90.3% | 126.1k · 92.1% | 60.7k · 87.4% | 155.3k · 89.1% |
| 本仓库 · ChatGPT | 32.7k · 64.5% | 113.0k · 78.9% | 41.7k · 83.2% | 117.4k · 82.9% |
| Codex 0.167.0 | 65.5k · 91.7% | 139.1k · 90.5% | 100.5k · 91.3% | 201.8k · 88.5% |

- Claude 侧本仓库与官方持平（命中 89.9% 对 90.0%），token 少 4%。
- ChatGPT 侧本仓库 79.5%、Codex 90.0%，差距集中在短题（`ssh-s` 64.5% 对 91.7%）：短题只有 3–4 个请求，新会话第一个请求未缓存部分占比大，与主矩阵短任务的结构性差距相同。本仓库 token 比 Codex 少 40%。
- 这组题全部通过，只能区分成本与缓存，区分不了能力。

### 11. dsh（DeepSeek Harness）

dsh 0.2.2-rc.1 用 headless 模式（`dsh --profile headless --json`），模型经它内置的 pi-ai 路由，关闭网页工具后共 22 个工具（含 `subagent`、`subagent_fork`、`workflow`、goal 与后台任务工具），系统提示约 2.3k 字符。11 题 × 3 次，两种账号各一组；Claude 侧与 pi 1.5.0 同一时段交错，ChatGPT 侧单独顺序运行。dsh 每个会话还用主模型发一个生成标题的小请求，计入总量，不计入首个 prompt。其他行取主矩阵与第 1 节同 11 题的数据。

| CLI | 账号 | 成功 | 命中率（单次范围） | 平均总 token（单次范围） | 输出 | 首个 prompt | 平均用时 | 请求数 | API 等价花费 / 任务 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dsh 0.2.2-rc.1 | Claude API key | 33/33 | 88.7%（79–95） | 69.2k（26–365k） | 5.4k | 8.1k | 39s | 6.1 | $0.083 |
| pi 1.5.0（同时段） | Claude API key | 33/33 | 77.0%（33–89） | 26.0k（9–84k） | 3.2k | 2.7k | 25s | 4.6 | $0.049 |
| 本仓库 | Claude 账号 | 33/33 | 87.1%（49–93） | 72.7k（32–149k） | 3.0k | 15.5k | 26s | 4.0 | $0.078 |
| 官方 Claude Code 2.1.319 | Claude 账号 | 33/33 | 87.3%（77–94） | 81.0k（36–159k） | 3.5k | 17.1k | 30s | 4.0 | $0.088 |
| dsh 0.2.2-rc.1 | ChatGPT 账号 | 32/33 | 89.8%（0–96） | 130.2k（5–723k） | 3.4k | 4.1k | 72s | 15.3 | $0.073 |
| 本仓库 | ChatGPT 账号 | 33/33 | 85.3%（50–93） | 75.9k（44–151k） | 2.2k | 10.4k | 61s | 5.6 | $0.050 |
| Codex CLI 0.167.0 | ChatGPT 账号 | 33/33 | 88.8%（79–96） | 80.3k（39–165k） | 2.2k | 14.6k | 59s | 4.8 | $0.047 |

- dsh 首个 prompt 比本仓库小一半（Claude 侧 8.1k 对 15.5k），短任务因此省 token；但请求数多（ChatGPT 侧 15.3 对 5.6），长任务 ChatGPT 侧平均 220.8k，是本仓库的 2.3 倍，`doc-l`、`longcode` 单次最高 723k。
- 唯一失败：ChatGPT 侧一次第一个请求遇到 `WebSocket closed 1006`，dsh 不重试直接结束。
- 3 个子代理（与第 5 节同题，每次确认开出 3 个 `subagent`）：Claude 侧 28.9k → 178.0k（6.2×），ChatGPT 侧 60.1k → 236.3k（3.9×）；每个子代理带完整工具与系统提示。
- ChatGPT 侧会话中途失效按同一口径计 16 次，主要是第二个请求紧跟第一个（约 2 秒内）还读不到刚写入的缓存，以及模型自行开出的子代理首个请求；Claude 侧 0 次。
- ChatGPT 路由下 dsh 输出最终结果后进程不退出（pi-ai 的 WebSocket 连接缓存约 5 分钟），每次都由 harness 结束，用时按最终结果计。

### 12. 公开基准：通过率与花费

上面的题组几乎全部 100% 通过，看不出成功率差别；这一节用公开基准测通过率。题目是 Terminal-Bench 2 ×8、SWE-bench Pro ×8、SpreadsheetBench ×4（共 20 题），15 个 CLI × 账号格，原版和扰动版各跑 3 次，每格 120 次、共 1,800 次 run。全部 run 在任务自己的容器里，每次全新 HOME，关闭 web search。数据采集于 2026-11-08 至 11-09。

![公开基准：每任务 API 等价花费与通过率，15 个 CLI × 账号格的散点，含 3 个套件的分项点与 Pareto 前沿](images/cache-benchmark/public-pass-vs-cost-light.png#gh-light-mode-only)
![公开基准：每任务 API 等价花费与通过率，15 个 CLI × 账号格的散点，含 3 个套件的分项点与 Pareto 前沿](images/cache-benchmark/public-pass-vs-cost-dark.png#gh-dark-mode-only)

| CLI | 账号 | effort | 通过率 | TB2 / SWE-Pro / Spreadsheet | 平均总 token（单次范围） | 命中率 | API 等价花费 / 任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dsh 0.2.2-rc.1 | Claude API key | low | **70.8%** | 28 / 37 / 20 | 256k（27k–3.0M） | 91.2% | $0.176 |
| opencode 1.19.5 | Claude API key | adaptive | 68.3% | 28 / 35 / 19 | 312k（26k–3.6M） | 90.9% | $0.206 |
| oh-my-pi 18.18.0 | Claude API key | high | 64.2% | 22 / 34 / 21 | 386k（30k–5.0M） | 92.0% | $0.233 |
| 官方 Claude Code 2.1.319 | Claude API key | medium | 61.7% | 27 / 28 / 19 | 221k（36k–2.0M） | 92.2% | $0.132 |
| 官方 + 子代理 | Claude API key | medium | 59.2% | 27 / 26 / 18 | 307k（37k–1.7M） | 89.4% | $0.207 |
| 本仓库 + 子代理 | Claude API key | medium | 58.3% | 29 / 22 / 19 | 253k（48k–1.3M） | 86.7% | $0.186 |
| 本仓库 | Claude API key | medium | 54.2% | 22 / 25 / 18 | 234k（34k–2.1M） | 90.4% | $0.146 |
| pi 1.5.0 | Claude API key | low | 52.5% | 21 / 24 / 18 | 98k（6k–1.0M） | 85.7% | $0.097 |
| oh-my-pi 18.18.0 | ChatGPT 账号 | high | **59.2%** | 35 / 18 / 18 | 627k（22k–3.4M） | 93.7% | $0.210 |
| 本仓库 + 子代理 | ChatGPT 账号 | low | 50.8% | 30 / 13 / 18 | 783k（75k–3.8M） | 90.3% | $0.298 |
| pi 1.5.0 | ChatGPT 账号 | medium | 50.8% | 28 / 15 / 18 | 145k（7k–844k） | 88.4% | $0.077 |
| Codex CLI 0.167.0 | ChatGPT 账号 | low | 49.2% | 26 / 15 / 18 | 247k（39k–868k） | 91.2% | $0.094 |
| dsh 0.2.2-rc.1 | ChatGPT 账号 | low | 48.3% | 25 / 15 / 18 | 534k（0–3.2M） | 93.4% | $0.166 |
| 本仓库 | ChatGPT 账号 | low | 45.0% | 23 / 13 / 18 | 311k（31k–1.3M） | 90.8% | $0.117 |
| opencode 1.19.5 | ChatGPT 账号 | low | 45.0% | 24 / 12 / 18 | 343k（21k–1.4M） | 91.6% | $0.131 |

套件列是通过次数，分母分别为 48 / 48 / 24。模型：Claude 侧 `claude-sonnet-5-5`，ChatGPT 侧 `gpt-6.1-sol`；effort 是各 CLI 的默认值，没有统一。「+ 子代理」格在提示末尾要求先并行开至少两个子代理，最后自己检查合并结果。

- **模型差距大于 CLI 差距**：Claude 侧 8 格合计 61.1%，ChatGPT 侧 7 格 49.8%。SWE-bench Pro 上 ChatGPT 侧 7 格都只有 25–38%；openlibrary-89 与 ansible 两题 Claude 侧大多通过，ChatGPT 侧 7 格全部 0/6。
- **Claude 侧 dsh 与 opencode 最好**，比 pi 高 18.3 ± 6.2 与 15.8 ± 5.5 个百分点（逐题配对差 ± 标准误）。ChatGPT 侧只有 oh-my-pi 明显领先，它默认 effort high。
- **本仓库对官方 −7.5 ± 4.4 个百分点，对 Codex −4.2 ± 3.4**，都不到 2 个标准误。Claude 侧差距主要在 make-mips-interpreter（2/6 对 6/6），失败方式与 pi 的 4 次失败相同。
- **子代理**：本仓库 Claude +4.2、ChatGPT +5.8、官方 −2.5 个百分点，花费分别是单代理的 1.27×、2.54×、1.56×；都在噪声范围内。
- **本仓库 Claude 侧平均用时 196s，官方 113s**：`-p` 在后台 Bash 任务不结束时不退出（mailman 题 6/6），已在 #1071 修复；本轮用的是修复前的构建。
- **防污染**：每题另跑一份改写过的扰动版（换措辞、名称、路径、端口与期望输出，评分同步更新，oracle 全部通过）。TB2 原版 54.7%、扰动 55.0%，Spreadsheet 相同；SWE-bench Pro 扰动版低 8.3 个百分点（50.3% 对 41.9%，主要是 flipt 12 → 1）。这可能来自模型记得原版，也可能是改名后更难，本设计分不开。
- **区分度**：20 题里 5 题全格全过或全不过（3 题 Spreadsheet、vuls、navidrome），差别来自其余 15 题。每格 120 次，单格通过率的标准误约 4.5 个百分点。

**dsh 与 opencode 为什么领先（Claude 侧 960 次 run 的逐条记录分析）**

- **差距几乎全在 SWE-bench Pro。** TB2 上 dsh、opencode、官方分别是 58.3%、58.3%、56.2%；SWE-bench Pro 上是 77.1%、72.9%、58.3%。在 5 道有区分度的 Pro 题（ansible、element-web、flipt、nodebb、openlibrary-30）上，dsh 25/30、opencode 23/30、官方 16/30、本仓库 13/30。
- **赢在做得更久、更深，不在工具。** 这 5 题每次 run 的平均值：工具调用 dsh 15.2、opencode 13.9、官方 9.4、本仓库 11.9；输出 token 16.3k、16.8k、9.9k、9.7k；跑项目测试 2.9、3.4、1.9、2.0 次。代价是用时和花费都多约 50%。最后一次测试是绿的 run 里，dsh 19/24 通过，官方 10/21，说明差别不只是少跑测试，也在于实现离题目要求更远。
- **工具设计、子代理、压缩不是原因。** 各 CLI 九成以上的调用都是 bash，编辑工具、grep、LSP 几乎没用到；dsh 和 opencode 在 960 次 run 里没有开过子代理、没有用过 todo，也没有触发压缩。
- **dsh 对 pi 是最干净的对照**：两者用同一个模型调用库、都发 `effort: low`，dsh 仍高 18.3 ± 6.2 个百分点，差别只在系统提示和工具返回。dsh 的提示只有「coding agent」一句加每个工具一条规则（例如「每次看 `[exit code: N]`，失败先查清楚再往下」），在 low 下的思考 token 比本仓库 medium 还多（SWE-Pro 每次 4.8k 对 2.0k）。
- **opencode 很可能主要靠 effort**：它对 Claude 只发 `thinking: adaptive`、不带 effort，服务端按默认值 high 处理；本仓库和官方发的是 medium。
- 这只是观察数据，effort、提示、工具在各 CLI 之间同时不同。本仓库据此考虑的改动（`-p` 默认 effort、系统提示加一句「结束前跑相关测试并清理构建产物」）要先做固定变量的 A/B，目前都没有实现。

## 局限

- 第 0–11 节的题组成功率几乎全部 100%，对成功率没有区分度；成功率比较见第 12 节公开基准。
- 每格 3 次。ChatGPT 侧同一格重跑平均相差 9 个百分点（最大 39），单格差异需超过约 10 个百分点才有意义。
- Agent Teams 只有 Claude Code 系有；pi 没有子代理功能。Web 场景只有本仓库有。
- 补跑的格（opencode 多轮场景、Claude 侧 pi / opencode 多轮场景、多代理新格）与早先的格不在同一时段。

## 数据与复现

重跑用仓库里的 [Agent 基准测试套件](agent-bench.md)（`bun bench/cli.ts`），任务、计价和图表与本页一致。以下是 2026-11-07 这一轮的原始数据。

完整报告、逐 run 汇总、逐请求原始日志与 harness 在项目共享目录：

- `regression/cache-bench-1107-post/`：CLI 矩阵、TUI / SDK / Web（`report.md`、`results.json`、`raw/`、`harness/`）。
- `regression/public-bench-1108/`：第 12 节公开基准（`report.md`、`summary.json`、`raw/`、`harness/`、`charts/`）；扰动版题目在仓库 `bench/public/perturb/`。
- `regression/cache-bench-1107-current/`：多代理、长闲置、启动与资源占用（`raw/sub/`、`raw/team/`、`raw/gap/`、`raw/b6/`、`harness/`）；pi 与 opencode 的 Claude 侧 CLI 矩阵在 `claude-api/`；各 CLI × 账号的补齐格与 API 等价花费在 `chatgpt-api/`（`results.json` 汇总全部逐 run 数据）；oh-my-pi 在 `oh-my-pi/`；dsh 在 `dsh/`；ssh / k8s 运维排障在 `ops-troubleshoot/`。

原始日志按 `raw/<场景>/<任务>/<CLI>-<轮次>/` 存放，只追加不覆盖，不含凭证。本页图表由上述数据直接生成，脚本在 `regression/cache-bench-1107-post/charts/`。

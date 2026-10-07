# Mods model.complete：官方 2.1.292 文本块与回执对照

本批从 feat/mods@1dbb23856e179e8cac0ce371f88eca563e38ba6d 构造独立候选，只提交 model.complete 所需代码、相邻 classify 的结构化结果消费、回归和文档。ROOT 的 fork、调用者链、完整在途取消及其他 Claude 工作保持独立。完整 Mods/API/UI/diff/G5 目标仍未完成。

## 来源与变更

2026-10-07 查询官方 npm latest，版本仍为 2.1.292，包 shasum 为 ecf88deee4c6b1b099d14a8571f1d5cad2ff1897。固定 darwin-arm64 原件 SHA256 为 97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f，235017328 bytes；共享 official-claude/built-claude 没有覆盖。

来源：[官方 npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)、[Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。参考页当前说明范围为 2.1.290，并说明生成声明应以实际安装版本为准；本批运行时依据固定 2.1.292 原件及静态提取模块，不把该网页当成全部 292 行为证明。

完整原始证据位于 `/private/tmp/mods-model-blocks-20261007-el2g6yp4`。`official-source-windows.json` 保存模块 hash、marker 与字符位置，所有分析是静态读取，不执行解包 JS：

| 官方函数 | 模块 / 字符位置 | 作用 |
| --- | --- | --- |
| Fpr / Tf | chunk-r9hj3tk2.js / 205381 | 作者块合法性、文本合并和原始块投影 |
| l5t / d5t | chunk-pwkr374y.js / 2288604、2289120 | 宿主 shape 与仍匹配的前缀缓存标记 |
| p5t / FPt / qV | chunk-pwkr374y.js / 2289820、987255、909381 | 核心完成、错误状态及分类 |
| jW | chunk-pwkr374y.js / 979820 | 实际请求、缓存关闭及 SDK 边界 |
| ACe / nye | chunk-r1spqfr8.js / 387712、388358 | 禁用 thinking 能力和输出余量 |
| Dc | chunk-3813s4yh.js / 2237 | UTF-16 是否完整，允许空字符串 |

生产修改包括：作者 VM 规范化 prompt/system；宿主在 Hooks 前拒绝非法块；核心保留仍匹配的前缀缓存、修复发送文本的未配对 UTF-16、跳过通用 CLI system 前缀；cache 开关生效时删除实际请求的 mark；完成文本直接拼接，返回四项用量及结构化失败；正整数 deadline 限制实际 timer 上限。Hook 的 JavaScript value 按官方保持不透明，不以内部结果类型额外拒绝；公开声明仍精确。

ROOT 原有未提交取消逻辑曾在 Hook 之前启动 deadline，本轮去掉该提前 timer；核心负责 timeout，作者 signal 仍使用原有取消通道。对应旧夹具改为精确断言 middleware 结束后调用 provider 一次并得到成功回执，不删除测试或放宽断言。该完整取消实现尚未纳入候选提交。

## 自动化和构建

候选 sourceSHA256：51b3a37ab982424c5f708f29879bb757d05862d6c48905f2bff721ac5e033db0；ROOT：dca9064b090ab1e3a6d8253e1a68577b6cbb1507dc1f79d7920473c2197bc6c0。来源包含 src/types/vendor/scripts/assets 和实际嵌入的 CHANGELOG，README、此报告和历史账本不属于二进制嵌入链。

| 运行 | 结果 | 原始记录 |
| --- | --- | --- |
| 改动前 ROOT 4 个模型文件 | 55 pass / 0 fail | baseline-model-core |
| 原生产 Worker/adapter 加同一新回归 | 12 pass / 2 fail | regression-red；不是缺少导出造成的失败 |
| 候选相关 10 文件 | 362 pass / 0 fail / 5 既有 skip，1637 expect | candidate-final2-suite |
| ROOT 相关 11 文件 | 390 pass / 0 fail / 5 既有 skip，1735 expect | workspace-final2-suite |
| 候选 make release-check | exit 0，39.106 秒 | candidate-final2-check |
| ROOT make release-check | exit 0，39.392 秒 | workspace-final2-check |
| 候选 / ROOT 隔离 make build | 各 exit 0，3.268 / 2.907 秒 | candidate-final2-build / workspace-final-build |

十一场逐文件独立无认证运行全部 exit 0：候选 TextBlocks/Adapter/Results/Options/Runtime 为 14/10/13/21/7 pass；ROOT 为 14/10/16/21/8，加独立 Cancellation 9 pass。每次使用独立 HOME/config/XDG/真实 TMPDIR；错误分类测试内部设置占位认证并恢复环境，不修改生产 auth。详见 `isolated-summary.json`。

保留原 RED、检查失败和驱动诊断：候选缺少 HttpResponseError 前置类型、Worker 把 HooksError 名称丢成 Error、旧 HTTP 分类断言、测试认证未隔离、只读 expected 类型及当前 TypeScript lib 不支持 toWellFormed 都已逐项修复。Native diagnostic1 profile 解析失败，diagnostic2 的敏感字段脱敏破坏 JSON，diagnostic3 的未配对 UTF-16 导致记录序列化失败；原证据没有覆盖。最终正式 cohort 另起全新目录，记录参数以非敏感字段名称保存，保留实际 wire 数值，未替换或猜测 REDACTED 内容。

## 新制品与真实 tmux

| 制品 | SHA256 |
| --- | --- |
| 候选 2.1.280 | 9514da4e1698b1e584346c82f7ceedc101dd06890fe8bbf23f647b6ed732e09d |
| ROOT 2.1.280 | 81e49afb91b8270beabe7ec7443239fb7748fcaf4f95d344a97347f01afce55e |

本地版本号保持原值。每侧独立 config/plugin/HOME、160×40 owned tmux，全部 literal stdin 输入、readiness、阶段 pane/ANSI/cursor/PTY、debug 与 `/exit` 终态均保存。最终 Hook cohort 为 official/workspace 的 `probe-native-*-final1` 与候选的 `probe-native-candidate-final3`；HTTP cohort 为 official/workspace 的 `wire-native-*-{final2,nocache2}` 与候选的 `wire-native-candidate-{final3,nocache3}`。候选最后移除测试文件的一个尾部空行并重新执行完整检查、362 项 suite 和 build，新 binary hash 后重新执行全部 Hook/HTTP 场景。最终 driver 只替换候选 binary 路径，其他操作/夹具与原件及 ROOT 相同，比较器核对该唯一差异；旧制品结果保留，不冒充最终 hash。

Hook cohort 每侧 9 回执 / 7 个模型事件，精确比较 normalized 输入、freeze、origin、非法块 HooksError 名称/消息、任意 value 和调用前 abort。没有 provider 请求；均正常 exit 0、自有 server exit 0，binary 未变。结果见 `hook-comparison.json`。

HTTP cohort 每侧 20 个 complete 回执、20 个 complete Hook 事件及含 SDK 重试的 26 个 complete 请求；另有一个相邻 classify 请求/回执。通过仅限本机端口的服务提供相同的确定性 HTTP 响应，不接触真实 provider/keychain/用户配置。开启和关闭缓存两轮分别精确比较：

- plain、文本块、追加、块内改写、新开头、cache:false、空列表、未配对 UTF-16、effort、超大 timeout；
- HTTP 400/401/403/404/429/500/529、空回复、timeout、耗时超过 timeout 的 middleware；
- model/max_tokens/messages/thinking/output_config/tools 等与作者 system，实际返回文本/四用量/状态/分类及重试次数；
- 缓存关闭时 Hook 块不变，实际请求标记全部移除。

每个请求必须存在且符合固定序列，不用后续成功补齐缺失记录。正常出口、所有自有 server/HTTP 关闭、binary hash、输入和警告检查都必须通过。超时后测试 HTTP peer 关闭只允许对应 timeout，请求体仍保留。`compare-wire-final.py` 的判定记录在 `wire-comparison.json`。

完整 request body 没有字节相等断言：第一块 attribution 带实际版本与 fingerprint，metadata 属于各自独立会话。比较器明确检查并保留原始记录，仅将该实际 attribution 块排除在作者 system 比较之外。没有把该差异藏成整体 wire 相等。

## 仍开放的差异

- classify 的邻接请求已工作并返回 bug，但官方请求 max_tokens=20、当前=1024，prompt/system 也不同；官方 classify 不再进入公开 model.complete Hook，当前本地会额外触发一次，因此该 HTTP cohort 的总 model.complete 事件是官方20、本地21；额外事件和最后一个请求单独记录，不纳入 complete 输入/body 相等判定。最新标签匹配、失败、调用链和预算行为需下一批实现。
- 完整 in-flight signal / 父 turn 取消和 Worker 生命周期仍属于未提交取消批次；本批只关闭调用前 abort 和核心 timeout 的明确场景。
- 本批 native 使用 claude-sonnet-4-6 + 本机 Anthropic HTTP 夹具，不证明全部模型 capability registry、禁用 thinking/effort 的 provider 差异、OAuth/Bedrock/Vertex/OpenAI、特殊 billing/verification/cloud 错误及无响应网络边界。当前 adapter 仍使用已有模型能力函数；ACe 的完整动态 capability 选择仍需继续对齐。
- 核心非法参数的错误类型/插件前缀、空模型解析和特殊 getter/proxy 的跨 realm 投影需继续核对；已测非法文本块的 host check 错误一致不等于所有参数错误一致。
- 五个既有 suite skip 不计为通过；完整 all-tests/HEAD 比较、所有 public methods/上下文、UI/Band/Client、官方 diff viewer 与 G5 尚未验收完成。

本批没有 push，没有关闭总目标，也没有覆盖原 response.md、fix-instructions.md、improvment.md、官方声明资产或共享二进制。签名提交和精确候选 blob、保留文件核对记录见 evidence 根下的 commit-verification.json。

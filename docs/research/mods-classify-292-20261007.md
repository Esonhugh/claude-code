# Mods model.classify：官方 2.1.292 核心调用与标签匹配

本批基于 feat/mods@1f29ebfcfb32286f4da09630d60a62bf7d2c4712 构造独立候选，并把相同分类修改应用到工作区。完整 Mods/API/上下文/UI/官方 diff/G5 目标仍开放；没有把分类验收扩展为全部兼容性结论。其他 Claude 的 fork、调用链、取消和 UI 工作保留。

## 来源与契约

2026-10-07 重新核对 [官方 npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)，仍为 2.1.292，shasum ecf88deee4c6b1b099d14a8571f1d5cad2ff1897。[官方 Mods reference](https://code.claude.com/docs/en/plugins/mods/reference) 当前说明为 2.1.290，生成声明以实际安装版本为准。本批静态读取官方 2.1.292 的提取模块，不执行解包 JS，也不上传源码或请求体。

证据根：`/private/tmp/mods-classify-292-20261007-vm84ydmw`。`official-source.json` 保存文件 hash、原始窗口和字符位置：chunk-r9hj3tk2.js 的 `var hf=20`：204142、chunk-r9hj3tk2.js 的 `async function Oks`：204526、chunk-pwkr374y.js 的 `var w1o=`：2316678、chunk-3813s4yh.js 的 `function Yl(`：677。固定位置以该 JSON 原始窗口记录为证据。固定官方原件 SHA256 为 97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f，235017328 bytes。

- 分类公开派发 model.classify，核心直接完成请求，不另派发公开 model.complete；分类 Hook 仍可改写、回答或拒绝。
- system 包含以 JSON 字符串表示的标签；prompt 为 <text> 内逐行 `> ` 引用的数据；基础 maxTokens=20，默认使用 small-fast 模型。
- 回复 trim 后移除一个开头引号及尾部引号/句点，先做大小写无关完整匹配，再按长度降序、稳定顺序进行转义后的非单词边界匹配。返回原标签，允许重复，未命中为 undefined，规范化后空回复拒绝。
- 初始文本/列表形状在 Hook 前检查，最终形状在核心再次检查，标签内容在核心检查，允许 Hook 修复标签。公开 TypeScript 保持精确；JavaScript Hook 的 value 按实际官方行为不透明。
- 核心失败与 deny 保留 HooksError、插件及原因，HTTP 分类不公开正文。无类型 null options 的错误文本依据 2.1.292 原生观察保留，其表达式名称属于固定版本诊断，不鼓励作者绕过静态类型。
- debug 只新增插件、模型、字符长度、标签数量、匹配索引或失败原因，没有新增正文/标签内容日志。

## 自动化、类型与制品

候选 sourceSHA256：3b8f881375f5f1f3725c463a3a8953b0ba6a80e20f1570e19514f78e3be5bf05；工作区：1a5fed1548d69da86054f5abe2c176ae52abf5350ad7b9a43879dd10ec42f3d6。manifest 包含 src/types/vendor/scripts/assets 与嵌入的 CHANGELOG；本报告、README 和历史账本不属于二进制嵌入链。

| 运行 | 结果 | 原始记录 |
| --- | --- | --- |
| 改动前工作区 4 个模型文件 | 43 pass / 0 fail | baseline |
| 新分类回归、旧生产 adapter | 6 pass / 25 fail，31 tests | classify-red |
| 最终 Worker 回归、原生产 runtime | 6 pass / 2 fail | routing-red-final |
| 候选相关 11 文件 | 396 pass / 0 fail / 5 既有 skip，1690 expect | candidate-suite-final2 |
| 工作区相关 12 文件 | 424 pass / 0 fail / 5 既有 skip，1788 expect | workspace-suite-final2 |
| 候选 / 工作区 make release-check | 各 exit 0，44.085 / 46.447 秒 | candidate-check-final / workspace-check-final |
| 候选 / 工作区隔离 make build | 各 exit 0，6.072 / 6.050 秒 | candidate-build2 / workspace-build2 |

八场逐文件独立、无认证运行均 exit0：候选 Classify/Adapter/Results/Runtime 为 32/11/13/8 pass；工作区为32/11/16/9。每场独立 HOME/config/XDG/真实 TMPDIR，详见 isolated-final-summary.json。分类预算测试仍要求两次耗时 80ms 的真实服务调用不消耗调用者 Hook 的预算；没有放宽时间断言或增加 skip。非法 text 的原 adapter 断言迁到真实 Worker 的宿主边界；重复标签按已验证官方契约改为允许；标签与提示词的宽松 contains 改为完整值断言。

读取三侧原生加载后生成的声明，使用相同作者源进行 strict/noEmit/skipLibCheck=false 编译；只读标签、模型选项、事件输入、返回值及拒绝回执正例通过，非法文本/数字标签/null/额外选项/结构化返回/数字 Hook value 的负例都由 @ts-expect-error 确认拒绝。author-type-comparison-final.json 三侧诊断均为空。最初夹具误把 OpValueOf 当回执 envelope，三侧一致拒绝；失败与原夹具保留，修正为 OpEventResult 后另场复验，没有修改生产类型。

| binary | 本地版本 | SHA256 |
| --- | --- | --- |
| 官方固定原件 | 2.1.292 | 97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f |
| 干净候选 | 2.1.280 | de0c7e1432f42e3492f363409077f90edcd6f81d440d126c215d2ab356520c71 |
| 工作区 | 2.1.280 | efa48b812e5cff1f06293f008335adf0f2ba7d05786816f14064ca46bbd44a3e |

版本、路径、大小和 mtime 记录在 binary-versions-final.json。本地版本号没有改动，共享 built-claude / official-claude 没有覆盖。

## 本轮真实入口与对照

九场 scripted tmux 串行运行，每场使用独立160×40终端、HOME/config/plugin/cache、只允许自有本机 HTTP 端口的 sandbox 与占位认证。不访问真实 provider、Keychain、用户 .claude，也不向受保护 Claude 进程输入或发送信号。readiness、literal stdin、阶段 pane/ANSI/cursor/PTY、debug、fixture hash 和 /exit 终态均保存。run-native-final.py 驱动，compare-native.py 对全部输入、回执、事件及实际请求逐项判定，结果见 native-comparison.json。

| cohort（三侧各一次） | 回执/侧 | classify Hook/侧 | 相邻直接 complete Hook/侧 | 含 SDK 重试的 HTTP/侧 |
| --- | ---: | ---: | ---: | ---: |
| native-*-formal2 | 38 | 35 | 1 | 34 |
| native-*-nocache2 | 38 | 35 | 1 | 34 |
| extra-*-formal2 | 7 | 6 | 1 | 3 |

每场脚本、fixture 输入和 settings 等价；HTTP 返回确定性的文本与四用量，不冒充真实模型判断质量。主 cohort 覆盖大小写/空白/引号/句点、最长标签、边界、正则字符、Unicode、相同长度、重复/原大小写、未命中、多行数据、默认模型/无类型模型选项、空回复、HTTP400/429/500、Hook 改写/回答/拒绝、非法 shape/标签/null options 及相邻完成。429/500 各有3次实际 SDK 请求；完整序列必须存在，不能用后续成功补齐。附加 cohort 验证数字、任意对象和 undefined Hook value、标签修复及最终非法 text 拒绝。

三侧最终原始回执/Hook 输入（含深冻、origin）相等，全部分类请求 max_tokens=20，相邻直接完成=1024。缓存关闭时所有实际块均无 cache_control。投影后的 request model/messages/system/max_tokens/thinking/output_config/tools 等逐项相等；第一块真实 attribution 及 metadata 带各自版本、fingerprint/会话信息，单独检查和保留，未宣称完整 body 字节一致。每场正常 exit0，自有 HTTP/thread/tmux server 均终止，binary 与原 fixture 字节保持不变，没有 ui.log/status/toast 的丢弃警告。

## 失败保留与验收边界

最初官方 driver 在相邻完成回执的 usage 字段触发标准 debug 脱敏，JSON 解析失败；该次仍正常退出且关闭自有 HTTP/server。原日志保留，没有猜测 REDACTED 数字；新场使用 usage 数组记录非敏感计数。初始 extra 对照真实发现本地丢弃不透明 value、非法改写仍发请求，extra-first-comparison.json 明确 passed=false；修复后完整 checks/suite/build 和全部三侧正式 cohort 重新执行。旧 binary hash 和失败不能作为最终通过证据。

首轮 release-check 的判别联合类型收窄与测试 expected 类型问题、准备脚本中的语法/假定 ROOT 与候选测试完全相同的问题都已修正；旧失败输出保留。没有删除失败测试、吞异常或降低断言来使检查变绿。

本批关闭上一个 model.complete 报告中已记录的 classify 提示词/20-token/额外 complete Hook 差异，及本轮发现的分类值/最终 shape 差异。仍需继续：完整模型能力、非法模型/输出参数的错误命名及空模型解析、特殊 getter/proxy、所有 provider/认证/特殊错误、classify 的父 turn 取消和调用链/生命周期、fork、全部 public API/上下文、UI/Band/Client、官方 diff viewer、完整 all-tests/HEAD 与 G5/required release gates。五个既有 skip 不计为通过。分类核心 aborted 的错误转换有独立测试，不等于完整 Worker 在途取消已验收。

原 response.md、fix-instructions.md、improvment.md、全部非本批文件及其他 Claude 的 fork/WIP 原始内容均保留；保护和精确候选签名提交结果见证据根下 preservation-final.json / commit-verification.json。没有 push，总目标保持 active。

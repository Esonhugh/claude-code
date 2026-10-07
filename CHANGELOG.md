# 变更日志

本文档记录基于 Claude Code `2.1.88` 恢复源码之后的本地变更。

记录规则：

- 发布条目标题固定为 `## YYYY-MM-DD - vX.Y.Z - 标题`，按版本号从新到旧排列。
- 未发布条目标题固定为 `## YYYY-MM-DD - 标题`，不得在标题中包含版本号。
- 发布条目依次包含 `版本状态`、`关联提交`、`变更内容`、`测试覆盖` 四个三级章节，每个章节至少包含一个顶层 `- ` 条目。
- `变更内容` 可以使用 `####` 分组，但每条用户可见 release note 必须单独占一行并以顶层 `- ` 开头。
- 发布条目可以覆盖上一版本 tag 之后的全部提交；未发布条目按对应变更 commit 的提交日期记录。
- `## 2.1.88 base` 是唯一基线条目，固定放在文件末尾，不作为 release note。
- `bun run check:changelog` 是格式规范的可执行门禁；发布时还会校验 tag 版本与最新发布条目一致。

## 2026-10-07 - Mods SDK UI 协议类型与输入边界

### Added

- 补齐 18 类客户端 UI 控制与 5 类引擎 responder 的有限请求/回执定义、组件与 wire tree、客户端模块数据及 system pane/scroll/focus schema；按请求 subtype 关联回执，并保持两个请求方向独立。
- release-check 增加独立 strict 类型门禁，校验 schema 与协议定义双向兼容，保证必填 nullable 字段不会因恢复项目的宽松配置而变成可选。

### Fixed

- ui_attach.answers 最多允许 5 项，合法重复值继续接受；第 6 项在 roster 变更之前拒绝，与官方原生回执一致。
- 保留官方客户端/pane ID 区别、默认 surface/origin、UTF-16 字符上限与整数/可见窗口边界；ui_message 必须携带 data，null 合法，弥补本地 Zod unknown() 缺字段校验差异。

### Tests

- 固化官方 2.1.292 的 17 条原生 UI 回执，并覆盖协议请求/回执、方向、默认值、长度、nullable、绘制树及真实 runtime 的 answers 拒绝行为；原失败与最终源码/新制品对照见 docs/research/mods-sdk-ui-protocol-292-20261007.md。
- 生产入口仍仅接通 attach/detach；其余绘制/交互/client/responder 控制器、system 推送、完整官方 UI/diff/G5 和全量 WIP 继续分批实现及验收。

## 2026-10-07 - Mods 远程客户端连接生命周期

### Fixed

- stdin EOF 在关闭输出前等待未完成的连接控制回执，修复一次输入多条 JSON 行时丢失合法请求回执的问题。
- 连接控制等待首次 Mods binding 完成；后台 observation 等待当前发布队列，防止启动期间静默遗漏 attach 通知。
- stream-json 入口接通 ui_attach 与 ui_detach，校验远程 surface、client_id、viewport 与 answers；连接回执在 observation hook 完成前发送。
- roster 在 session.attach/detach hook 之前更新；重复连接只更新传输元数据，hook 异常、取消及伪造 clientId 回执不撤销连接事件。显式连接保持到 ui_detach 或 session.end，不因单个绘制站点关闭而消失。
- 会话结束先从 roster 移除各客户端，再按原顺序通知 reason=end；调试日志记录客户端身份、surface 和 detach 原因，不打印绘制内容。

### Tests

- 保留真实 Worker 取消、只读字段、返回值、末尾清理与时限检查，将旧的连接回滚预期改为官方已提交传输状态；增加真实 runtime 的 SDK 校验、回执时机、重复连接、绘制站点释放及会话结束回归。
- 官方 2.1.292 与最终候选/工作区的隔离控制协议、类型、构建、聚焦测试和精确边界见 docs/research/mods-remote-roster-292-20261007.md；本批仅接通连接控制，ui_render、远程 responders 与完整 UI/diff/G5 继续独立验收。

## 2026-10-07 - Mods stream 主动取消和资源收尾

### Fixed

- 公开 turn.step 区分取消信号与 stream delivery，允许 hook 在有限时间内完成取消收尾；turn.abort 正常返回，next.signal 同步取消原因 turn-abort，取消本轮模型和工具且不添加用户中断提示。
- 取消期间仍接收实际输出并保留模型/Worker 原始取消身份；真实 hook 错误和缺少合法结果继续诊断，不将所有取消后的异常当作取消或把返回 answer 当作输出。
- 适配器在所有退出路径等待 Worker/model iterator 与快照清理；retained stream watchdog 覆盖初始化 RPC 之后的永不返回 pull，并打印不含正文的 turn/step/块数和 overrun plugin/invocation 调试信息。

### Tests

- 增加合法、协作、缺少返回、真实 hook/模型异常及永不返回的取消回归；原清理断言和时限保留，待完成 Worker RPC 先普通 await 再严格检查取消身份，避免 Bun rejection matcher 阻塞消息投递。
- 12 文件隔离回归：候选 507 pass / 1 fail / 3 skip，工作区 535 pass / 1 fail / 3 skip；唯一失败为原 HEAD 与原工作区均复现的远程 attach/detach 取消。既有 skip 保留，不声明全量门禁或整体 Mods 对齐完成。
- README 补充主动取消用法；最新官方 2.1.292、源/制品身份、失败和精确验证边界见 docs/research/mods-stream-abort-parity-292-20261007.md。

## 2026-10-07 - Mods 查询与工具执行测试定义

### Tests

- 将 query 和共享 executor 的执行型 fixture 改用生产 buildTool，补齐必需方法和具体输入/回调类型，移除不完整对象强转；保留原断言、取消时限、权限与生产行为。
- 消除 query 中 6 项和相邻 executor 中 15 项 fixture 失败；完整相关组仍有 1 项主动 abort 失败，2 项既有 native policy skip 未更改。
- README 补充仓库执行型工具测试写法；双端真实终端的取消差异、精确候选和工作区证据见 docs/research/mods-query-tool-fixtures-20261007.md。本批不声明全量门禁或整体 Mods 对齐完成。

## 2026-10-07 - narration 完成后清理 thinking 预览

### Fixed

- 按官方完成消息消费顺序，已落地的非空 narration 清空短时私有 thinking 预览，再保存原始消息；避免普通视图和 transcript 中重复显示摘要正文。
- 保留 signed thinking/signature、摘要 Mods 绘制及普通私有 thinking 的既有显示路径，增加不含正文的消息 UUID 调试日志。

### Tests

- 增加生产 stream consumer 的完成交接、事件顺序、损坏/空白/混合块和相邻文本回归；候选、工作区及官方真实终端的结果和边界见 docs/research/mods-summary-handoff-292-20261007.md。
- 本批不声明 live thinking delta、指标、Cowork 全屏或完整 UI/diff 已匹配。

## 2026-10-07 - narration 摘要的原生 Mods 绘制

### Changed

- 按官方签名的 protobuf 2/1/8 元数据识别非空 narration，将真实摘要在普通及展开视图中接入 AssistantMessage，传递消息 UUID、显示文本、首行状态与只读 isSummary。
- 摘要保留原生 Markdown 续绘、前导显示空格和单次尾部 summary 标记，对齐有限列宽下的标记换行；插件自定义树不自动附加标记。保留原始 thinking 正文与 signature，普通私有 thinking 不进入摘要钩子。
- 对齐已知模型默认和 capability override 的摘要标记规则，读取匹配 provider/账户的现有 bootstrap 缓存，并在原生行挂载时固定显示决定。
- 增加官方 maxProseWidth 设置解析与摘要 prose 宽度上限，保留表格及顶层代码的终端宽度；空值、非法设置和损坏签名按原生规则处理。

### Tests

- 新增生产 Message/Worker/Ink、protobuf 损坏及重复字段、模型能力/缓存、设置和 Markdown 尾部布局回归；相关 gate 和官方/候选/工作区的私有 tmux 证据、边界见 docs/research/mods-assistant-summary-292-20261007.md。
- 修复既有 bootstrap mock 测试与隔离环境的非必要流量开关冲突，只在 mock 范围内临时解除该测试的开关并恢复原值；生产 Privacy Mode 不变。
- 官方每模型 client-data slots、served capability、动态桌面 attach、嵌套复杂 Markdown 与其他原生 UI/diff 流程继续核对；本批不声明整体 Mods 对齐完成。

## 2026-10-07 - 助手文本行接入 Mods render

### Changed

- 将真实 Message 路由中的助手文本行接入 ui.render，使用消息 UUID 作为 requestId，传递清理后的 text、isFirstOfReply 及现有 viewport/onScreen 上下文。
- 按官方显示投影移除隐藏分析块和 cc-memory 标签外壳，保留其正文、空格及尾部换行；原始消息和 API 错误标记保持在原生续绘路径中。
- 插件可替换、装饰、隐藏或多次 next 原生 Markdown 回复，并改写显示文本和首行标记；不改写持久化会话正文。
- 校验助手行 next 的原始字段类型，禁止添加、删除或改写宿主的 isSummary；错误树或非法续绘回退原生行。

### Tests

- 增加生产 Message + 实际 Worker/Ink 回归及文本投影边界向量；独立候选和工作区执行相关门禁，固定官方制品与新构建执行私有 tmux 对照。精确结果和未关闭项见 docs/research/mods-assistant-text-292-20261007.md。
- 本批仅接通普通助手文本；narration 摘要、其他消息站点、完整 diff viewer 和全部 UI 对齐继续处理。

## 2026-10-07 - 原生 Mods 绘制取消与卸载清理

### Changed

- 原生 render site 在首次绘制尚未完成时即绑定宿主；输入变化、显式失效重绘和组件卸载会取消旧 ui.render，阻止旧请求继续占用 Worker 或发布画面。
- 保留已完成绘制及其回调至新绘制提交；合并尚未执行的过时输入，重复输入不取消正在进行的绘制，非法替换不干扰有效请求。
- 将 ui.render 的取消原因传递至 Worker 中的 next.signal，保留官方 HooksError 和 ui.render: superseded 信息；被替换的错误不覆盖新画面，真正失败仍回退原生行。
- 取消并释放旧 drawing 的资源，初始挂载和卸载的清理均可重入；调试日志输出组件、requestId、drawing 和取消原因。

### Tests

- 增加真实 Worker/生产完成行的四项回归和 render site 的六项生命周期测试，保留相邻 Pane、AbovePrompt、Client、dispatch 和 session 验证；官方固定制品与本轮独立构建通过私有 tmux 对照重绘取消、首次绘制 resize 和 /clear 卸载。准确结果与尚未对齐项见 docs/research/mods-render-lifetime-292-20261007.md。

## 2026-10-07 - 原生完成行接入 Mods render

### Changed

- 将实际 TurnDuration 消息行接入 ui.render：以消息 UUID 作为 requestId，传递 word、durationMs、实际终端 viewport，以及已知的全屏 onScreen 范围。
- 完成动词按官方 2.1.292 的 UTF-16 字符串哈希稳定选择；同一消息重挂载不再随机变词。
- 共享原生绘制宿主支持插件替换、嵌套及多次 next(e) 原生续绘、Client 与真实按钮回调；没有匹配钩子时跳过 render site，钩子重载和卸载更新实际行。
- 可见行测量订阅绘制后的滚动位置，报告部分可见或视口外 null；异常自定义树回退原生行，迟到的卸载绘制不能覆盖终端。
- 输入框 presentation 更新只重画对应 Pane/AbovePrompt，不重复调用未变化的原生 transcript 钩子；显式 invalidate 和插件重载仍更新原生站点。
- 禁止 next(e) 添加、删去或改写由宿主报告的 props.onScreen；保持绘制重写与视口上下文分离。相邻测试夹具补齐原生焦点/订阅接口及已有工具的 isReadOnly。

### Tests

- 增加真实 Worker 与生产 SystemTextMessage/Ink 的 19 项聚焦回归；准确候选和工作区分别构建并与固定官方制品进行私有 tmux 交互对照。分层结果及未覆盖项目见 docs/research/mods-native-duration-292-20261007.md。
- 该批关闭 TurnDuration 的 render 接线，不代表其他原生组件、完整完成时间格式、完整 diff viewer 或全部 Mods 门禁已完成。

## 2026-10-07 - 短轮次完成时记录 transcript checkpoint

### Changed

- 以官方 2.1.292 的主轮次 finally 为基准，移除 `turn_duration` 的 30 秒门槛；短轮次也记录完成 checkpoint，本地非查询命令、查询前拒绝、取消与自动循环轮次不记录模型完成 checkpoint。
- 后台 swarm 尚在运行时继续延后 checkpoint，并保留最初开始时间和最新 budget；完成时打印只含 elapsedMs 的调试日志。
- checkpoint 保存在原始会话历史中，可影响后续 `turn.step.messageCount`；不转换为 API 消息或公共 `session.messages` 聊天条目。UI 隐藏完成时间行仍不删除历史。

### Tests

- 增加实际 REPL 完成语句与查询前置语句的 19 项回归，覆盖 0/1/29999/30000/30001ms、budget、取消、循环、swarm 延后、非查询命令、查询前拒绝和消息投影；保留原始失败用例。
- 准确提交候选、用户工作区及固定官方制品分别验证；原始组合失败、基线对照、逐文件结果、构建和隔离终端证据见 docs/research/mods-turn-checkpoint-292-20261007.md。
- 完整附件上下文、官方完成时间格式和 `ui.render` 的 TurnDuration 接入仍需单独对齐；本批不声明完整 Mods/UI/diff/G5 验收完成。

## 2026-10-07 - Mods 测试凭据与配置隔离

### 变更内容

- prompt.compose 请求回归自行创建真实临时 HOME、配置和 XDG 目录，使用占位 API key；测试结束恢复环境并删除自有配置目录，单文件运行无需开发者凭据。
- prompt.compose 在每个测试边界清空按项目缓存的 memory 路径，防止后续测试重用已删除的临时 HOME；清理失败也会恢复环境。
- model.fork 2.1.292 回归补齐相同配置与 OAuth/凭据文件描述符隔离，保留已有测试正文及所有断言；不改生产认证或 Mods 行为。

### 测试覆盖

- 在准确提交候选和用户工作区分别执行无凭据单文件回归；额外验证两文件组合及继承占位凭据后的九项环境恢复。原始失败、逐文件结果与验收范围见 docs/research/mods-test-isolation-20261007.md。

## 2026-10-07 - Mods 模型 fork 与父轮次取消对齐

### 变更内容

- model.fork 使用官方判别联合回执：尚无主会话快照时返回 nothing-to-fork，其他结果区分回答、空回复、API 错误和取消；正常/核心取消的回执及 usage 保持可修改。
- fork 保留主会话快照中的模型、工具和上下文，去除尾部 assistant 未完成的 tool_use；使用 hook_prompt、plugin_model_fork 与两轮上限，通过权限回调拒绝工具，按官方顺序选择回复文本和最后一个 API 错误。
- 父 turn.step 取消后等待模型核心协作结算：complete/fork 返回取消回执，classify 抛出带插件名的 HooksError；取消发生在 Mods hook 内时保留 user-cancel 错误及 next.signal.reason，允许 finally 记录日志并正常清理 Worker。
- turn.step 未改写用量时保留原始 message_delta 的部分字段，避免改变 fork 的官方用量累加口径；新增 fork 结果、耗时及取消/API 状态调试日志。

### 测试覆盖

- 新增固定官方 2.1.292 的父轮次取消回执夹具，以及 fork 参数、上下文尾部、结果优先级、协作取消与部分 SSE 用量回归。官方/候选提交/工作区的构建、测试和原生交互证据见 docs/research/mods-model-parent-fork-292-20261007.md；完整 API/UI/diff、上下文请求体及 G5 门禁继续验收。

## 2026-10-07 - Mods 模型完成的取消与回执语义

### 变更内容

- model.complete 的作者 options 只读取一次 signal，忽略 JavaScript 未使用的 options/额外参数；信号形状错误保留插件名和 HooksError，提前取消优先于请求检查并复用共享冻结回执。
- 将插件自己的信号按环境和调用编号传递为取消事件；保留取消原因，并发调用互不干扰，结算/卸载时清理监听器与控制器。
- 普通及核心取消回执和用量保持可修改；作者端及 Hook 取消保持冻结。模型分发允许有上限的取消结算，Hook 处理取消时仍可输出最终 ui.log；debug 仅新增环境、调用编号和活动状态。

### 测试覆盖

- 新增官方作者表达式/回执夹具、Worker 取消/日志回归及原始原因、监听器清理和忽略取消的有界等待检查。构建、三侧原生 tmux/本机 HTTP、类型验证与原失败证据见 docs/research/mods-model-signals-292-20261007.md；父 turn.step 取消、fork、完整 API/UI/diff/G5 仍继续验收。

## 2026-10-07 - Mods 模型完成参数与错误边界

### 变更内容

- model.complete 按输入形状、maxTokens、timeoutMs、effort、模型允许列表及输出上限的顺序检查；错误保留官方 HooksError、调用插件名、原输入值和解析后的模型限制。正整数输出采用 Number.isInteger；超出安全整数但仍为整数的值由输出上限拒绝。
- 模型允许列表按去掉 `[1m]` 的解析模型检查；Worker 通用值传递保留 NaN/Infinity/-Infinity，让模型 Hook 可以修复并由核心打印正确数值错误，其他 API 的各自校验继续生效。
- 字符串模型交给已有解析器，空值和空白不在 Mods 层提前拒绝；完整模型名、常用别名和 trim 按实际完成请求验证。模型完成和分类内部完成使用调用插件名，deny 保留官方错误边界，改写后的非法形状在核心入口拒绝。
- 模型完成对未知第一方模型保留 thinking 余量；禁用 thinking 的已知模型、能力开关的精确/前缀规则和后置覆盖按官方侧查询处理。debug 记录请求上限、实际 cap、thinking 余量及钳制后的 deadline，不新增提示词正文日志。

### 测试覆盖

- 保留参数顺序及未知模型请求的原 RED，补充精确错误、模型允许列表、deadline、大整数、能力覆盖、真实 Worker 的改写/拒绝/不透明 value 回归；构建及官方原生对照证据见 docs/research/mods-model-params-292-20261007.md。共享模型解析器的全部规则、动态模型目录、其他 provider、完整取消与其他 API/UI/diff/G5 仍继续验收。

## 2026-10-07 - Mods 分类器核心调用与标签匹配

### 变更内容

- model.classify 保留公开分类 Hook，核心直接使用模型完成服务；分类推理不额外触发公开 model.complete Hook，避免策略重复运行和改写分类提示词。
- 使用官方逐行引用的数据提示词及 20 个基础输出 token；回复先去掉空白、引号和句点，再按大小写无关的完整标签或最长边界匹配返回原标签。允许重复标签，未命中返回 undefined。
- 初始文本/标签形状在 Hook 前检查，标签内容在核心检查，允许中间件修复或回答；最终改写形状在核心再次检查；JavaScript Hook value 保持不透明，公开 TypeScript 类型仍严格。失败、空回复及 deny 保留插件名称和 HooksError。debug 只增加长度、标签数量/索引与失败分类。

### 测试覆盖

- 新增标签、Unicode、正则特殊字符、原标签保持、错误原因和真实 Worker 的检查/修复/回答/拒绝回归；本轮官方/候选/工作区的本机 HTTP 与 scripted tmux 验证记录见 docs/research/mods-classify-292-20261007.md。完整模型能力、取消链、fork、其他 API/UI/diff/G5 继续验收。

## 2026-10-07 - Mods 模型文本块与完成回执

### 变更内容

- model.complete 在作者端将文本块规范化为 Hook 可读的 prompt/system 字符串，并保留原始块；只有仍匹配改写文本的前缀块保留缓存标记，追加文本不自动缓存。关闭模型缓存时移除请求标记，发送前修复未配对的 UTF-16 字符。
- 核心返回结构化完成、空回复、API 错误或取消回执及四项用量，文本块直接拼接；支持 effort 与正整数 timeoutMs，并限制实际计时上限。JavaScript Hook 的 value 保持官方运行时的不透明语义，公开 TypeScript 类型继续严格约束。
- 完成调用跳过通用 CLI system 前缀并保留实际 attribution；debug 记录模型、长度、块数、结果、HTTP 分类与用量，不新增作者正文。

### 测试覆盖

- 新增前缀改写、空块、Unicode、真实 Worker 和严格 Hook 输入回归，保留相邻 classify/fork 测试意图；候选及工作区检查、新制品本机 HTTP/tmux 对照和剩余范围见 docs/research/mods-model-complete-292-20261007.md。完整模型能力表、取消、fork/classify 以及 API/UI/diff/G5 继续验收。

## 2026-10-07 - Mods 剪贴板函数暴露

### 变更内容

- 将官方 ui.copy 函数和事件纳入真实加载、Worker 与 host 路径，允许文本和目标改写，保留拒绝回执及首次附着 surface 选择。仅投影 text/surface，公开 getter 在作者端同步求值。
- 交互式终端提供真实剪贴板 responder；无 surface、无 responder 或写入超过限制时返回官方原因。debug 记录插件、长度、目标和写入状态，不打印复制内容。

### 测试覆盖

- 保留九个 Worker/host 用例、两个终端 OSC 写入边界及两个严格类型用例；真实 tmux 相邻作者操作与官方对照见 docs/research/mods-ui-copy-20261007.md。远程 responder、系统剪贴板和完整 Mods UI 仍需继续验收。

## 2026-10-07 - Mods 最新作者声明

### 变更内容

- 将生成作者声明的完整原始来源更新到官方 2.1.292，保留 2.1.290 历史资产。新增 autocomplete、模型文本块定义，同步 Workflow spawn 身份及重入失败类型；不改变本地引擎版本。
- 当前作者消费者使用对应版本的完整类型契约；旧声明、工具/MCP 增补、默认项目及依赖投影的回归继续保留。

### 测试覆盖

- 新增完整字节、全部导出、严格正反作者输入检查；加载后的真实生成项目和相邻作者操作需使用本轮制品与官方对照，详见 docs/research/mods-declarations-292-20261007.md。类型定义完整不代表新增运行时行为已全部实现。

## 2026-10-07 - Mods Select 展开与选择状态

### 变更内容

- Select 获得焦点时展开，区分已选值与高亮选项；Enter 确认并收起，收起后的 Enter/方向键只展开。字符按标签循环匹配，Space 不提交；列表最多显示八项和剩余数量，标签、箭头和反显遵循官方状态。
- 等值重绘保留乐观选择，新的绘制值覆盖；成功回执改写已选值，迟到回执不覆盖新选择。未知值显示 none；重复选项仍按官方 host 拒绝。
- Ctrl+C 空闲时先收起、再释放焦点；任务运行期间让出给取消逻辑。宿主传入实际 isWorking，Band 使用显式释放回调。

### 测试覆盖

- 新增真实 Ink 状态和连续输入回归，保留原夹具的导航、焦点、选项缩短及 Client 回调意图。候选/工作区检查、新制品三侧终端对照及准确边界见 docs/research/mods-select-state-20261007.md；完整 API/作者类型/UI/diff 和 G5 继续验收。

## 2026-10-07 - Mods Input 光标与提交状态

### 变更内容

- Input 持焦点时加粗标签，按实际光标位置绘制单个字符簇，并显示官方的 ⏎ 提交提示；占位光标、终端失焦和宽度使用现有输入渲染规则。
- 提交收到含 element/value 的成功回执后，仅在没有新编辑时清空当前输入；在回执未返回时抑制重复提交。拒绝、未送达、旧 owner 和卸载后的回执不会清空输入，不产生额外 onInput 事件。

### 测试覆盖

- 新增真实 Ink 输入、字符簇光标、延迟回执与重绘回归；相邻 Worker、焦点和官方 diff 流程，以及三侧新制品和严格面板画面对照见 docs/research/mods-input-presentation-20261007.md。Select 的展开列表、完整 API/作者类型/UI/diff 与 G5 继续独立验收。

## 2026-10-07 - Mods 面板自动聚焦与控件回调

### 变更内容

- 面板取得键盘后，首个声明 autoFocus 的注册控件通过 ui.focus 协商焦点，携带控件插件来源，核心调用者为 engine；拒绝、未调用 next 和改写结果均按实际已发布状态落地。
- 焦点协商保留插件与控件键；按官方注册顺序保留隐藏控件的自动聚焦及方向键行为。同名键沿用官方终端的首个绘制槽位落点。
- 同一次 stdin 读取里的方向键与 Enter/Space 按顺序执行，激活等待焦点协商及绘制提交；取消后的旧按键不会重新触发控件。
- Button 的 onPress 收到完整 ui.press 参数，与 Input 和 Select 一起保留绘制回调来源及站点信息。

### 测试覆盖

- 真实 Worker、Ink 输入与 REPL 回调测试，以及官方 2.1.292、独立候选和工作区新制品的 tmux 对照见 docs/research/mods-automatic-focus-20261007.md；完整 Band/Client 焦点、所有 UI/作者类型和 G5 仍独立验收。

## 2026-10-07 - Mods 面板尺寸与官方控件框架

### 变更内容

- 默认全屏面板采用官方宽度规则，预留对话区，按实际 composer 和覆盖层布局测量可用高度；自定义 columns 请求包含独立的 grip 列。
- 面板预留控件行并绘制关闭标记；inline 模式使用圆角边框、内容自然高度与官方高度预算，空内容允许零行。
- dock 持有焦点或鼠标悬停在独立 grip 列时，边界采用 suggestion 色；移到面板 body 且无焦点时恢复暗色，关闭后清除悬停状态。
- 隐藏面板不提交覆盖旧内容的测量；debug 记录尺寸、绘制标识和滚动偏移，便于核对实际布局。

### 测试覆盖

- 相关 service、真实 Ink/Yoga 与官方 native 终端对照见 docs/research/mods-pane-geometry-20261007.md；完整类型、焦点、全部 UI 和 G5 仍独立验收。

## 2026-10-07 - Mods 面板键盘事件先于输入框处理

### 变更内容

- 持有焦点的 Mods 面板先派发键盘 DOM 事件，使 Enter、滚动和 Esc 在输入框消费按键前到达面板；未处理的输入继续传给输入框。
- 标记已派发事件以避免同一按键重复触发，保留快捷键与 chord 拦截路径。Esc 交还焦点后，Enter 正常提交输入。

### 测试覆盖

- 使用真实 Ink 输入流复现输入框提前消费按键，检查面板按钮、滚动、Esc 交还、未处理输入透传和无重复派发；真实 diff 交互证据见 docs/research/mods-pane-keyboard-20261007.md。

## 2026-10-07 - 官方 diff 模块来源更新

### 变更内容

- 内置 diff 使用官方 2.1.292 的完整模块、身份模块与原始注册闭包，更新字节范围和 SHA-256；生产启动、离线打包、运行资产及 standalone 内嵌路径采用同一固定归档。
- 原有归档保留供历史证据核对；最新加载器拒绝过期或损坏归档并保持原生 diff 可用。
- 绑定变量名归一化后的 diff 闭包与官方 2.1.291 相同，保留原有事件、能力和存储身份；公共声明新增内容需另批对齐。

### 测试覆盖

- 覆盖真实 Worker 启动与接管、scan 元数据、归档重现、损坏和过期输入拒绝、构建资产与内嵌路径；真实终端流程与 UI 对照边界见 docs/research/mods-shipped-diff-292-20261007.md。

## 2026-10-07 - print 模式的 Mods 日志

### 变更内容

- print 主机提供 ui.log 接收端；默认 transcript 和 debug 日志保留插件身份与目标信息，避免被误报为 hook 未执行。
- 日志按官方 2.1.292 的 10000 UTF-16 单元上限截断并保护代理对；不进入模型输入或保存的会话历史；stream-json 的 transcript 目标输出带 plugin/text/uuid/session_id 的 system/ui_log 事件，text/json 保持仅模型输出。
- 公开 ui.log 继续同步返回 void，改写目标和非法目标的诊断保持原契约。
- 交互 transcript 日志使用 notice 级别，默认界面显示为无圆点的暗色提示，修复原 info 级别被隐藏的问题；debug 目标不进入界面。

### 测试覆盖

- 新增隔离的真实 Worker/print 绑定回归，覆盖启动缓冲、默认与 debug 目标、middleware 改写、非法目标、Unicode 边界和三种输出格式；补齐旧 headless 回归中已提交生产代码的 session scope 预期。官方对照与真实终端证据见 docs/research/mods-print-log-20261007.md。

## 2026-10-07 - SendMessage 会话身份绑定

### 变更内容

- 同步 Agent 也登记具名目标，完成或任务移出内存后仍可寻址，包含 print 调用入口。
- 普通子 Agent 消息返回并保存 pin 身份回执；名称换绑后拒绝裸名发送，使用明确 name [ref] 确认新目标。
- 本会话目标解析支持 Unicode 规范化、原始 ID、唯一名称前缀与冲突时延长的准确 ref；歧义不会投递到猜测的目标。
- 恢复和分支从成功 SendMessage 的工具结果元数据重建绑定；clear 清空绑定，回退按保留历史恢复，名称保留以仍运行的任务为准。
- 终端使用专属拒绝提示；模型结果移除 display 并保留官方同步报告框架，关键日志记录名称、完整 ID 和 ref。

### 测试覆盖

- 生产工具回归覆盖首次发送、名称换绑、明确 ref、异步任务写入者和用户取消；契约回归覆盖规范化、歧义、ref 冲突、模型格式化及历史回执过滤。真实终端、官方源码和剩余边界见 docs/research/mods-sendmessage-pin-20261007.md。

## 2026-10-07 - 用户取消 Agent 后拒绝自动恢复

### 版本状态

- 未发布；对齐官方 2.1.292 对用户停止和普通中断的区分。

### 变更内容

- 用户停止快捷键、Agent 视图的 Escape、任务关闭及 SDK stop_task 保存独立的 stoppedByUser 标记；模型调用 TaskStop 和系统中断不产生该标记。
- SendMessage 与共享恢复入口拒绝自动恢复用户取消的 Agent；标记保存在原 Agent 元数据中，重启或任务被移出内存后仍生效。
- 元数据更新按 Agent 串行并通过临时文件替换，避免停止标记被并发写入丢失；恢复注册前重新检查当前状态，避免异步读取跨越用户取消。
- 新增关键 AgentCancellation 日志，记录 ID、停止来源与拒绝位置。

### 测试覆盖

- 隔离回归覆盖用户/模型/系统停止、原始 ID、冷恢复、恢复准备期间取消、后续元数据写入，以及已完成/失败任务的正常恢复；真实终端和验收边界见 docs/research/mods-user-cancellation-20261007.md。

## 2026-10-07 - Mods 工具执行的只读结果标记

### 版本状态

- 未发布；对齐官方 2.1.292 的 tool.call 执行标记及 hook 返回后的引用校验。

### 变更内容

- 只读标记由工具对实际获准执行参数的检查产生，包含 hook 与权限参数改写；未执行的拒绝不带标记，已执行的失败保留标记。
- 跨插件边界只能通过该插件的下游 next 引用与未改写的结果保留 isReadOnly；伪造、替换输出、丢失引用和 deny 会移除它，支持 catch 和重复 next。
- 插件主动调用 $.tool.call 的最终回执按官方实现移除该标记，其下游观察 hook 仍能读取它；官方 diff mod 因而可区分只读与可能写入的执行。

### 测试覆盖

- 新增隔离的实际执行器与 hook 回归，覆盖权限改写、失败、拒绝、跨层引用、结果复制、伪造、重复 next 与作者调用。
- 两个原有 host 夹具与 classic hook 夹具补齐 Tool 必需的 isReadOnly 方法，保留原断言；真实终端与验收边界见 docs/research/mods-tool-readonly-20261007.md。

## 2026-10-07 - 禁用后台任务时同步恢复 Agent

### 版本状态

- 未发布；对齐官方 2.1.292 的 SendMessage 同步恢复、报告分段和结果展示。

### 关联提交

- 本条随恢复生命周期、工具返回类型、报告格式及对应回归独立提交。

### 变更内容

- 禁用后台任务时，SendMessage 等待同 ID 子 Agent 完成并直接返回最终报告；后台恢复仍沿用完成通知。
- 同步恢复不重复发送通知，保留并发计数、任务进度、失败状态、父查询中断和权限恢复。
- 报告返回公开 inlineHandback 内容、分段计数与哈希；模型收到官方格式的缩进报告，界面展示结果及原始 ID 的七位缩写。
- 同步 README、mods-test 与专项证据；官方 web-fetch 特殊恢复入口、报告扫描和完整 Mods/UI/diff 对齐继续单独验证。

### 测试覆盖

- 隔离回归覆盖等待结果、具名与被移除任务、普通与 fork 模型、失败、中断、空报告、框架开关、分段校验和结果渲染。
- 官方/候选/工作区真实终端对照使用保持未放行的恢复 API 响应，核对工具结果、公开字段、七位 ID 显示及通知次数；证据见 docs/research/mods-inline-resume-20261007.md。

## 2026-10-07 - 手动子任务与 fork 指令显示

### 版本状态

- 未发布；对齐官方 2.1.292 的 `/subtask` 后台子任务入口和 worker 指令显示。

### 关联提交

- 本条随子任务入口、继承上下文和对应回归独立提交。

### 变更内容

- 添加交互式 `/subtask <task>`，后台 fork 继承对话历史、系统提示、工具和主模型；用户命令独立于自动 fork 开关。
- 具名 fork 完成后可用同一 ID 恢复，保持主模型；计入共享并发槽并在结束后释放。
- 对完整官方 worker 模板显示 `⑂ <directive>`，保留普通标签文本及改写模板的原文。
- 同步 README、mods-test 与专项证据；官方默认 `/fork` 的独立后台会话及 agent view 映射仍待后续实现。

## 2026-10-07 - 显式 fork 模式与 Agent 类型选择

### 版本状态

- 未发布；对齐官方 2.1.292 的 Agent fork 门禁与类型选择。

### 关联提交

- 本条随独立路由修改、回归及验收记录共同提交。

### 变更内容

- 交互会话默认启用 fork 模式；环境变量可显式开启或关闭，协调模式保持独立路由。
- 省略 subagent_type 始终选择 general-purpose；显式 fork 继承父历史、工具和系统提示，忽略工具参数及全局子 Agent 模型覆盖。
- 校验自定义 fork 遮蔽、允许类型、权限拒绝、递归及 remote 隔离；缺少 general-purpose 时要求明确选择类型。
- Mods spawn 标记脚本入口，非交互脚本可显式 fork；普通 headless 子 Agent 保留同步默认例外。
- 缓存 schema 变体而非启动前的门禁判定；fork 模式隐藏后台参数，Agent 无须 ToolSearch 即可调用，事件与日志使用实际后台判定。

### 测试覆盖

- 新增六种隔离环境下的真实 AgentTool 生命周期回归，并检查会话 latch、模型覆盖、脚本入口和 schema 初始化。
- RED、Make、相关 Bun 回归及官方/候选/工作区终端证据见 docs/research/mods-fork-mode-20261007.md；Workflow、/fork 命令、折叠 UI、G5 与整体 Mods/diff 验收仍分别记录边界。

## 2026-10-07 - 普通 Agent 默认后台路由

### 版本状态

- 未发布；对齐官方 2.1.292 在未指定后台参数时的普通 Agent 路由。

### 关联提交

- 本条随共享路由计算、提示、回归和验收记录共同提交。

### 变更内容

- 普通调用省略 `run_in_background` 时默认后台启动；显式 `false` 保持前台，agent 定义的 `background: true` 仍可要求后台执行。
- 执行、任务元数据和 Mods `agent.spawn` 事件使用相同的后台模式；回调改写后台参数后重新计算执行模式。
- 进程内 teammate 的默认子任务保持同步；禁用后台任务时使用前台执行，内置 web-fetch helper 不受隐式后台默认值影响。
- 更新 Agent schema 和模型提示，说明默认后台及如何请求前台执行。

### 测试覆盖

- 新增隔离进程回归，覆盖省略/显式参数、定义默认值、Mods 改写、禁用后台、teammate 和 web-fetch 身份；前台续跑夹具明确传 `false`，保留原断言。
- 候选及工作区的 Bun、Make 与真实终端对照记录见 [专项验收](docs/research/mods-agent-background-default-20261007.md)；完整 fork 门禁迁移和本地 Workflow 可用性仍是独立缺口。

## 2026-10-07 - 后台 fork 技能与权限范围恢复

### 版本状态

- 未发布；对齐官方 2.1.292 的交互 fork 技能后台启动及权限记录恢复。

### 关联提交

- 本条随默认后台路由、权限范围、类型定义、回归及验收记录共同提交。

### 变更内容

- 文件、MCP builder、插件和 bundled 技能保留 background 与 disallowed-tools；background false、非交互和禁用后台任务选择同步执行。
- slash 与 SkillTool 共享后台启动，保存权限记录后注册命名任务，初始技能不占普通 Agent 容量；使用已有父子生命周期等待通知并以同 ID 续跑。
- 恢复时重新解析 fork 技能，应用当前 allow/disallowed 规则和冻结 deny，保留 effort、名称及递归调用保护；缺失、损坏、超限或身份不一致时拒绝恢复。
- SkillTool 后台结果显示 Running in the background，模型回执区分启动和完成；调试日志记录启动身份、权限保存回退及恢复拒绝。

### 测试覆盖

- 隔离 Bun 回归覆盖解析、加载、启动、同步回退、递归、权限恢复、损坏记录、部分写入和 UI；生产修改前保存失败证据。
- 官方、候选及 ROOT 的本轮构建、scripted tmux、实际 SkillTool/SendMessage 与相邻 Agent 验收详见 docs/research/mods-fork-background-20261007.md；完整 Mods/UI/diff、Workflow 与所有故障组合仍按专项边界验收。

## 2026-10-07 - 统一 fork 技能的 agent 类型解析

### 版本状态

- 未发布；修复项目、用户和旧 commands 技能的 agent 名称解析，不改变默认后台路由。

### 关联提交

- 本条随共享技能加载器、文件加载回归及官方终端对照记录共同提交。

### 变更内容

- agent 非空值按官方规则转换为字符串，数字或布尔 YAML 值可匹配同名代理；null 和缺失字段保持未指定，使用已有默认代理选择。
- 同一解析器服务文件技能和 MCP 技能构造，保留 context、参数替换及来源定义；插件解析器沿用此前已对齐的规则。

### 测试覆盖

- 隔离文件加载覆盖项目、用户、旧命令和 MCP builder，核对数字、零、布尔、null、缺失、字符串及 inline 字段，并验证实际 fork 上下文的代理选择。
- 官方 2.1.292、候选与 ROOT 的 slash/SkillTool、相邻 Agent 入口、Bun/Make 结果及未覆盖项见 docs/research/mods-fork-agent-types-20261007.md。

## 2026-10-07 - 等待后台子任务并自动续跑父 Agent

### 版本状态

- 未发布；覆盖普通后台 Agent 的子任务归属、等待与通知续跑。技能默认后台路由和 fork 权限恢复继续独立对齐。

### 关联提交

- 本条随后台父子生命周期、状态与模型定义、回归测试及官方对照记录共同提交。

### 变更内容

- 后台子任务记录 ownerAgentId，区别于上下文继承的 parentAgentId；通知返回仍存活的 owner。
- 父任务完成当前模型流后释放普通执行名额，保留子任务归属并在公开列表显示 waiting；收到通知后按原 ID 与模型续跑，待子任务全部结束再向主会话通知。
- TaskStop 和 SDK stop_task 可停止等待中的父任务；取消或恢复失败保留最后结果与用量，执行延后的 worktree 清理。
- debug 输出 owner_parked、owner_wake、owner_wake_failed 和清理失败的关联 ID，不打印任务正文。

### 测试覆盖

- 独立进程回归覆盖子任务先/后完成、多次续跑、归属与继承身份分离、公开列表及 TaskStop、取消与恢复失败。
- 官方 2.1.291、干净候选与本轮 ROOT 的 Bun/Make/tmux 结果和未覆盖项见 docs/research/mods-background-owner-20261007.md。

## 2026-10-07 - 保留插件技能的 fork 执行配置

### 版本状态

- 未发布；修复插件技能与旧 commands 目录的 context/agent 加载，默认后台与恢复权限范围继续独立对齐。

### 关联提交

- 本条随插件 fork 配置修复、文件加载回归和真实入口对照共同提交。

### 变更内容

- 插件 SKILL.md、旧 commands 和 manifest 自定义技能路径保留 context: fork 与 agent，使用已有隔离执行入口和指定 agent，避免技能意外展开到主会话。
- context 仅接受精确的 fork 值；agent 非空值按官方规则转为字符串，空值保持未指定。

### 测试覆盖

- 隔离真实文件加载覆盖默认技能、旧命令、自定义路径、inline/无效 context 和 agent 值，同时检查参数及插件路径替换。
- 官方、候选与 ROOT 的编译 CLI slash/SkillTool 对照、RED 证据和验收边界见 docs/research/mods-plugin-fork-20261007.md。

## 2026-10-07 - 修正同步 fork 技能的并发计数与身份

### 版本状态

- 未发布；覆盖同步 context: fork 的 slash 入口，不宣称默认后台技能路由已对齐。

### 关联提交

- 本条随同步 fork 修复、入口回归与官方对照记录共同提交。

### 变更内容

- 同步 fork 技能本身不占普通 Agent 的全局执行名额；技能内实际调用的 Agent 仍检查并占用名额，避免剩余容量被提前耗尽。
- slash 入口向执行器传入进度使用的同一个 agent ID，启动与完成 debug 打印该身份，便于核对查询、事件和进度归属。
- 修正上一批把官方缓存共享 fork worker 计数规则套到 fork 技能的说明；官方 2.1.291 的两种执行路径分别分析。

### 测试覆盖

- 新增同步 slash/SkillTool 成功与异常、进度身份和满额普通 Agent 拒绝回归；独立隔离进程不使用个人 key。
- 官方、本轮 ROOT 与干净候选的 tmux 对照、修复前失败、相关测试和构建身份见 docs/research/mods-fork-capacity-20261007.md；默认后台路由、KAIROS 和完整 G5/UI/diff 仍待独立验收。

## 2026-10-07 - 对齐普通 Agent 的全局并发名额

### 版本状态

- 未发布；覆盖全局执行计数、新建 Agent 拒绝和 Mod 作者返回值。

### 关联提交

- 本条随全局并发实现、类型定义、生命周期回归和验收记录共同提交。

### 变更内容

- 普通 Agent 默认最多同时运行 20 个本地子任务，与插件额度共用有效的 CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS 解析规则；全局计数独立保存在根 AppState。
- 新建任务在准备前与预留前检查额度；普通 Agent 返回明确工具错误，公开 $.agent.spawn 在全局额度耗尽时返回官方格式的 deny 对象。
- 前台转后台继续持有同一名额，运行成功、失败和取消后释放；释放先于终态发布和清理，重复回调不消耗其他任务的名额。
- 恢复任务和 fork 命令占用全局名额，沿用官方不执行新建额度检查的行为；命名 teammate 与真正 remote 启动不占本地执行名额。
- 嵌套上下文保留根计数 reader/writer，关键调试日志记录预留、释放与拒绝计数。

### 测试覆盖

- 新增实际 AgentTool 和生命周期回归，涵盖准备竞争、独立根计数、Mod deny、前后台移交及清理阻塞；恢复和 fork 回归验证满额时仍可恢复并正确占用/释放名额。
- 本轮官方 2.1.291 与本地 Make 制品的真实 tmux 证据、相关测试、类型检查和未覆盖入口见 docs/research/mods-agent-concurrency-20261007.md；整体 G5 与完整 API/UI/diff 设计继续验收。

## 2026-10-07 - 刷新 session usage 测试 mock 的启动时间

### 版本状态

- 未发布；只修正旧测试夹具。

### 关联提交

- 本条与 session usage mock 的修正共同提交。

### 变更内容

- trusted callback 的精确 session.usage mock 及原完整结果断言同时补齐必需的 startedAt，不弱化对 MCP 和用量的断言。

### 测试覆盖

- 旧 HEAD 的 runtimeHostHooks 单文件 25 通过、1 失败；修正后独立候选和 ROOT 各 26 通过、0 失败。此批不改变生产运行时。

## 2026-10-07 - 对齐 Mod spawn 的插件并发名额

### 版本状态

- 未发布；只对齐公开 Mod spawn 的插件计数与后台观察周期。

### 关联提交

- 本条随插件并发限制实现、回归测试和验收记录共同提交。

### 变更内容

- 同一插件默认最多 20 个启动中或运行中的 spawn；有效 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 覆盖默认值，无效输入按官方规则回退。
- 启动回执不释放名额；实际 `async_launched` 的本地子任务结束或记录被移除后释放，其他结果立即释放；调用者结束和插件重载不重置仍运行任务的计数。
- 使用官方拒绝文字；调试日志打印插件、agent/task ID、终态与名额变化，公开作者类型不增加内部回调参数。

### 测试覆盖

- 新增 15 个生产 Worker／真实任务注册回归和 6 个实际 Agent 返回状态分流回归；保留拒绝、失败、三种终态、记录移除及其他插件的断言。
- 本轮独立 HEAD 候选及 ROOT 的相关 Bun 测试、release-check、私有输出 Make 构建与 scripted tmux 对照记录见 `docs/research/mods-spawn-concurrency-20261007.md`；保留修复前及夹具诊断失败证据。
- 官方普通 Agent 的全局并发检查仍是独立待修差异；未声明全部 Agent/Workflow、官方 API/UI/diff 或 G5 已完成。

## 2026-10-07 - 补齐 REPL 提交测试的隔离与恢复依赖

### 版本状态

- 未发布；本批只修复测试夹具和验证记录。

### 关联提交

- REPL 提交测试的封闭环境、既有 diff／resume 依赖及恢复记录断言独立提交。

### 变更内容

- REPL 提交测试自行隔离 HOME／配置／XDG 和占位认证，执行后恢复调用者环境。
- 既有 native diff 测试补齐当前 closure 的所有权依赖；同 ID 恢复测试补齐 restoreSessionCosts，并验证所选记录只传递一次，即使没有恢复成本快照也继续验证 diff 与上下文恢复。

### 测试覆盖

- 保留原有行为断言；独立候选的整份 REPL 测试及 diff controller、cost summary 生命周期回归均通过。工作区复验与未覆盖门禁详见 mods-test.md 的 2026-10-07 记录。

## 2026-10-06 - 对齐 Mod 子任务的完成通知归属

### 版本状态

- 未发布；对齐官方 2.1.291 公开 agent.spawn 的本地任务通知认领。

### 关联提交

- 公开 spawn 通知归属、生产任务／队列回归及使用说明独立提交。

### 变更内容

- Mod 子任务启动后，公开 host 按 agent ID 在根任务表找到本地任务并认领完成通知；完成事件保留，结果不再重复进入主会话并发起额外模型请求。
- 子任务上下文优先使用根任务写入器；不同 task ID、已认领、无任务和非本地任务保持正确边界，普通后台 Agent 的完成通知继续正常送达。
- 调试日志记录实际认领的 task ID、agent ID 和插件名，不打印任务正文。

### 测试覆盖

- 十个隔离 Bun 子进程使用公开 host、实际任务注册／状态／队列模块验证 completed、failed、killed、根任务写入器及普通通知；仅替换 Agent 启动边界，真实 Agent 执行由编译制品的 tmux 对照验证。

## 2026-10-06 - 对齐 Mod 权限查询的原因字段

### 版本状态

- 未发布；对齐官方 2.1.291 的基本权限原因投影。

### 关联提交

- 原因投影、公开 host 回归及使用说明独立提交。

### 变更内容

- $.tool.check 的 reason 只来自底层允许决定的实际原因或 ask／deny 的消息；不再根据权限模式或允许规则生成原因。
- 省略空原因，继续通过 rule 返回匹配规则，并保留 bypass 模式下的拒绝和安全审批。
- 同一投影用于模型工具权限 middleware；本批不包含 hook 来源和递归规则的其他改动。

### 测试覆盖

- 十个独立生产 Bun 子进程通过公开 host 验证允许、审批、拒绝、模式、规则及空原因；查询不执行工具、不调用 hooks、不弹出审批。

## 2026-10-06 - 对齐 Mod 主动工具调用的入口限制

### 版本状态

- 未发布；对齐官方 2.1.291 的作者 tool.call 检查。

### 关联提交

- 工具入口限制、生产回归和使用说明独立提交。

### 变更内容

- Mod 的 $.tool.call 在执行前拒绝 Agent、AskUserQuestion 和 Workflow，引导作者使用 $.agent.spawn 或 $.ui.ask；本地 WorkflowTool 同样不能绕过此限制。
- 按解析后的工具名识别 Agent 的 Task 别名；即使受限工具当前不可用，仍返回对应的 host check 原因。
- 普通工具调用、模型产生的 tool.call 事件及 $.tool.check 权限查询保留原流程。

### 测试覆盖

- 独立生产 Bun 子进程检查名称、别名、工具不存在时的拒绝，验证受限调用没有进入权限、hooks 或工具执行；普通工具控制组继续完整执行。

## 2026-10-06 - 验证并发子任务的根会话账本

### 版本状态

- 未发布；验证既有根会话账本语义，不修改 Agent 执行或计价实现。

### 关联提交

- 并发上下文生产链路回归和使用说明独立提交。

### 变更内容

- 增加生产模块回归：两个并发子任务保留各自的 agent 上下文，同时将模型 token、思考分项及成本累计到同一根会话快照。
- 说明普通子任务的 agent ID 与根会话账本的关系；独立根会话、异常恢复及完整调用矩阵继续验收。

### 测试覆盖

- 通过独立 Bun 子进程加载生产状态、AsyncLocalStorage 上下文、费用累计及快照模块，检查并发累计与离开子任务后的上下文恢复。

## 2026-10-06 - 补充模型用量元数据与 SDK 校验

### 版本状态

- 未发布；对齐官方 2.1.291 的模型汇总字段和 SDK schema。

### 关联提交

- 目录计价元数据、SDK定义和生产链路回归独立提交。

### 变更内容

- 模型累计补充 canonicalModel、provider、costBasis；现有目录模型标记 list，未知模型的默认估价标记 unknown。
- SDK schema 与生成类型加入三个可选字段；旧记录保持可读取，token数量及模型限制按官方 schema 校验整数。
- JSONL及项目配置继续仅保存 wire成本字段；恢复重建当前模型限制，新请求重新填充运行时元数据。
- 不改变现有费用计算；组织定价、促销价格、附加目录和新增提供方的完整来源仍待后续对齐。

### 测试覆盖

- 独立生产子进程覆盖原始模型名、未知模型、五种现有提供方、可选字段、整数校验和恢复后累计；原断言保留。
- 官方源码和本轮真实构建入口的验证范围见 mods-test.md。

## 2026-10-06 - 累计并保存思考 token 用量

### 版本状态

- 未发布；对齐官方 2.1.291 的思考 token 用量传递。

### 关联提交

- API 用量归一化、模型累计及生产链路回归独立提交。

### 变更内容

- 从流式和非流式响应保留 output_tokens_details.thinking_tokens，跨消息累计并加入模型 thinkingTokens；已恢复的历史分项继续累加。
- 缺少详情时归一化为零；后续事件未提供或提供 null 时保留已有值，明确提供零时按累计流式语义更新为零。
- 为旧版 Anthropic SDK 缺少的响应字段补充精确类型，沿用现有依赖；项目汇总和 JSONL 快照通过既有路径保存新增用量。
- 思考 token 是输出 token 的分项，不在 output_tokens 之外重复计费。

### 测试覆盖

- 真实独立 Bun 子进程覆盖零值、累计流式事件、空详情、明确零、跨消息累计、恢复后累计、SDK模型字段和快照；原输入对象保持不变。
- 官方源码、当前构建、真实终端及历史恢复的验收记录见 mods-test.md；完整账本归属、SDK其他元数据和 Mods API/UI 继续对齐。

## 2026-10-06 - 保存与恢复完整会话成本快照

### 版本状态

- 未发布；继续对齐官方 2.1.291 的会话成本恢复。

### 关联提交

- JSONL 成本快照、恢复入口、类型定义及生产存储回归独立提交。

### 变更内容

- 在会话切换、已创建会话的元数据重写及退出时保存完整 cost-state；禁用持久化或文件归属不匹配时不追加，不创建只有成本元数据的新会话文件。
- 各恢复加载器传递实际会话最后一条有效快照，恢复成本、API/工具时长、行数、累计运行时长、启动时间、模型用量及未知价格标志。
- resume、continue、交互恢复及非交互恢复使用 JSONL 快照，不用最近项目缓存代替历史账本；--fork-session 继承源快照，新 branch 和 clear 保持新账本。
- 保留模型 thinkingTokens 并同步 SDK schema、类型和项目配置定义；恢复时重新计算运行时模型限制，活动时钟回拨不产生负时长。
- 分离原始 BetaUsage 与 ModelUsage 的类型，移除不属于成本汇总 schema 的蛇形别名；切换快照与消息按现有队列顺序写入。
- 恢复日志包含源与当前会话、匹配结果、成本和时间，不打印会话正文。

### 测试覆盖

- 校验完整快照经过各加载器、错误项目缓存、压缩前扫描、无效末条记录、会话归属、fork、未知价格标志、数值启动时间和禁用持久化；跨两个独立进程恢复成本及原有时间/ID断言。
- 聚焦测试、release-check、当前二进制 scripted tmux 和官方对照详见 mods-test.md；完整 Mods API/UI 目标继续验收。

## 2026-10-06 - 在终端卸载前保存会话成本

### 版本状态

- 未发布；修复交互式 CLI 优雅退出时的项目成本保存。

### 关联提交

- 成本 hook 的退出时序和生产配置写入回归独立提交。

### 变更内容

- 优雅退出先卸载 Ink 时，成本 hook 在移除 process.exit 回调前保存当前会话的成本、运行时长、启动时间、模型用量和 FPS。
- 普通组件卸载仍只移除回调；保持进程直接退出的原有保存路径。

### 测试覆盖

- 独立生产子进程验证优雅退出、普通卸载和直接退出，核对磁盘配置与当前会话身份、成本及退出时的 FPS。
- 本轮构建与真实终端证据见 mods-test.md；完整 JSONL cost-state 成本恢复仍需后续对齐。

## 2026-10-06 - 保留 Mods 会话启动时间

### 版本状态

- 未发布；延续官方 diff 2.1.291 的会话时间边界。

### 关联提交

- 会话启动时间的保存、恢复、分支及成本时钟校验独立提交。

### 变更内容

- 将逻辑会话启动时间与累计运行时长的计时基点分开；新会话、clear 和原生 branch 取得新时间，恢复会话及 --fork-session 保留源会话的已知时间。
- 在原有 JSONL 元数据写入和恢复路径传递启动时间，并在压缩前元数据扫描中保留该记录；关闭持久化时不追加元数据。
- 读取匹配会话的项目 lastStartTime，以及经官方 2.1.291 完整字段和上限校验的最后一条有效 cost-state 快照；仅恢复本次范围内的启动时间。
- 历史记录缺少启动时间时沿用既有成本时钟，不以消息时间或文件时间伪造原始启动时间；零时长成本恢复正确重置活动时钟。
- 调试日志记录恢复来源会话、当前会话和启动时间，不记录会话正文。

### 测试覆盖

- 覆盖会话切换、读取器快照、重启恢复、continue、JSONL 路径、fork、原生 branch、压缩前扫描、无效元数据及持久化禁用边界。
- 聚焦 Bun、release-check、当前二进制 tmux 及官方对照的最终证据见 mods-test.md；完整 API/UI 兼容仍按其中未覆盖项继续验证。

## 2026-10-06 - 由官方 Mods 接管 diff

### 版本状态

- 未发布；生产启动使用已固定的官方 2.1.291 diff 模块。

### 关联提交

- 官方包加载、可信身份传递、命令及面板接管和生命周期回归独立提交。

### 变更内容

- 校验归档、完整模块、身份模块、注册闭包和扫描元数据后加载原始官方 diff Worker，保留静态命令名称元数据；只读发现不执行插件或授予运行时身份。
- 仅活跃且通过宿主身份校验的 diff 接管 `/diff`；暂停原生面板和后台刷新，禁用、拒绝或卸载时恢复原生路径。
- 一次性迁移面板打开偏好，保留跨重载的请求状态；接受用户关闭后清除该状态。
- 向原始 diff 提供每次读取器固定的 `session.usage.startedAt` 启动时间快照，避免新会话的修改被判为会话前修改；历史会话启动时间持久化仍另行验收。
- 等待已启动的后台宿主调用自行完成，同时区分未来定时器等待；取消、失败、卸载和运行时退出仍撤销相应工作。
- 调试日志记录包版本、来源哈希、加载失败原因与接管状态，不记录补丁正文。

### 测试覆盖

- 仓库内官方归档直接驱动全部14个 diff 接管用例，覆盖伪造身份、损坏模块、策略拒绝、Worker死亡、首次Write、关闭及原生恢复。
- 启动、偏好、后台调用、控制器、只读发现及相邻命令/会话/Worker路径使用聚焦Bun回归；构建和真实tmux入口分别验收。
- 完整官方API/UI矩阵、G5和全量同进程测试仍按 mods-test.md 的边界继续验证。

## 2026-10-06 - 打包官方 diff 归档

### 版本状态

- 未发布；固定官方 2.1.291 diff 的离线归档和构建输入。

### 关联提交

- 原始归档、producer、构建消费者与使用说明独立提交，运行时接管另行处理。

### 变更内容

- 在写入前校验官方完整模块、身份模块、注册闭包和扫描元数据，使用固定 ZIP 时间生成可复现归档，并拒绝覆盖现有输出。
- 发布目录和 standalone 二进制包含同一份 diff 归档，保留已有内置 Mods 归档。

### 测试覆盖

- producer 回归覆盖逐字节复现、损坏或缺失输入、拒绝覆盖与失败不产生输出；现有构建脚本覆盖复制和 file asset 嵌入。
- 验收核对官方二进制模块来源、编译产物中的归档字节，以及私有 tmux 中只复制 standalone 二进制后的冷启动和相邻 CLI 流程。

## 2026-10-06 - 修复作者测试子进程的相对路径

### 版本状态

- 未发布；修复 plugin test 从相对路径启动的子进程。

### 关联提交

- 插件根目录传递、路径回归及使用说明按独立功能提交。

### 变更内容

- 子进程命令使用解析后的真实插件根目录，避免切换cwd后再次拼接原始相对路径。
- 保留绝对路径支持，并支持带空格路径和符号链接。

### 测试覆盖

- 三种路径回归在旧接口上失败，在独立候选和工作区各通过3项测试；release-check与本轮新构建均通过。
- 两侧新制品的真实plugin test验证三种路径成功exit0及作者失败exit1，并完成交互式启动、草稿清空、正常退出和自有进程清理。

## 2026-10-06 - 保留作者测试错误的消息和调用栈

### 版本状态

- 未发布；改进 plugin test 的失败诊断。

### 关联提交

- 作者测试错误识别、回归及使用说明单独提交。

### 变更内容

- 正确识别来自测试 VM 的原生 Error，并保留原始调用栈。
- 调用栈缺少具体消息时补充错误名称和消息，帮助定位真实失败。

### 测试覆盖

- 回归先在旧实现上失败；独立候选的诊断回归与53项相邻集成测试通过，release-check和新构建通过。
- 独立与工作区新制品的真实 plugin test 分别核对成功exit0、作者失败exit1及消息/原始frame；交互式启动、草稿清空、正常退出和进程清理通过。

## 2026-10-06 - 串行发布内置 Mods 缓存

### 版本状态

- 未发布；修复多个 CLI 同时恢复损坏缓存时的发布竞态。

### 关联提交

- 缓存发布锁、并发回归及使用说明按独立功能提交。

### 变更内容

- 内置 Mods 的缓存替换使用进程间发布锁；取得锁后重新校验已有完整树，复用其他进程已完成的结果。
- 保留内容校验和失败恢复，并清理临时树、旧树及发布锁。

### 测试覆盖

- 新回归在旧实现上复现持锁期间提前替换；独立提交副本和当前工作区各通过27项测试、release-check及新构建。
- 两侧新制品均通过真实 tmux 启动：两个进程等待同一锁后修复缓存，后续启动复用原内容与mtime，三场正常退出且无自有进程残留。

## 2026-10-06 - 对齐 dock 尾部与输入框前的留白

### 版本状态

- 未发布；按官方 `2.1.291` 的布局量测对齐，正文预算保持独立。

### 关联提交

- dock 尾部、通知可用宽度与相关布局缓存修复按同一 UI 功能独立提交。

### 变更内容

- 全屏输入区保持终端全宽；dock 只延伸到位于 bottom 起点的实际 prompt margin，不覆盖前置 spinner 或输入框。
- 输入区通知使用 dock 左侧的可用列数，保留相同主题背景和边框样式。
- 绝对定位区域尺寸或样式变化时清理原绘制范围，防止缩短尾部后将旧边框留在输入框上。

### 测试覆盖

- 三项真实物理单元格回归覆盖有/无前置内容、resize、通知、margin 增减和 anchor 卸载；独立提交副本通过检查、构建和真实插件命令的缩放及输入验收。
- 当前工作区新制品的 `/diff` 打开、两次 resize、关闭重开四个稳定画面，右侧36行的字符及样式与官方一致；ask/取消及正常退出通过。AbovePrompt 布局、grip/focus、inline 及异步取消诊断仍需继续对齐。

## 2026-10-06 - 保留 Mods 原生错误的消息

### 版本状态

- 未发布；不改变公开 API、取消流程或错误对象传播。

### 关联提交

- 原生错误的消息传递、回归和使用说明按独立功能提交。

### 变更内容

- 跨 Worker 的 capability 错误读取原生 DOMException 消息，防止 AbortError 的确切消息被替换为通用错误。
- 使用原生 accessor 的 brand check，保留已有普通错误消息，且不执行自定义访问器或 Proxy trap。

### 测试覆盖

- 三项真实 Worker 回归覆盖原生消息、原对象传播、覆盖 getter、普通错误、代理和伪造原型；独立提交副本通过检查、构建及真实插件定时器退出验收。
- 当前工作区新制品的真实 `/diff` 完成 resize、ask/取消、关闭重开并退出0，诊断保留原生取消消息。取消仍被报告为异步错误，与官方的诊断时机差异继续保留。

## 2026-10-06 - 对齐 Debug 状态栏与通知分层

### 版本状态

- 未发布；标准终端布局对照官方 `2.1.291`。

### 关联提交

- Debug 状态标记和通知分层按同一 UI 功能独立提交。

### 变更内容

- Debug 使用官方的文字、warning 颜色和底栏位置，不再作为全屏提示框上方的通知绘制。
- 普通终端将通知和状态标记分成上下两层，保留 Goal、undercover 和 Bridge 状态。

### 测试覆盖

- 四项真实 PromptInput 回归覆盖普通/全屏、调试开关、状态行高度和 Goal 共存；相邻通知、prompt.edit 和同批按键测试通过。
- 新制品与官方在真实 tmux 中验证四种模式/开关组合，Debug 的逐字符颜色和右侧位置一致，正常退出；diff 的 resize、ask/取消和关闭重开保持通过。面板底部空白行及退出诊断差异继续保留。

## 2026-10-06 - 修复高亮 diff 的 UI 测试文本读取

### 版本状态

- 未发布；仅修正测试辅助方法。

### 关联提交

- 测试文本读取按独立验证功能提交。

### 变更内容

- DiffView 测试通过已有 strip-ansi 读取 Raw ANSI 的可见文本，防止语法颜色码隔开文件正文导致断言和等待失败。

### 测试覆盖

- 高亮修复后的独立基线与背景修复后的工作区均复现相同12项失败；修正辅助方法后两侧 DiffView 测试通过，原断言、截图检查、测试数量和超时预算保留。

## 2026-10-06 - 修复 diff 正文与边框的背景继承

### 版本状态

- 未发布；引擎版本保持 `2.1.280`，样例对照官方 `2.1.291`。

### 关联提交

- 默认背景、边框和缓存更新按同一功能独立提交。

### 变更内容

- Raw ANSI 绘制使用父容器的默认背景，同时保留代码自身的行级和词级背景、前景及其他样式。
- 边框继承自身或父容器背景；缓存包含背景，防止背景移除后复用旧色块。

### 测试覆盖

- 新增五项真实屏幕单元格回归，覆盖样式重置、多行、实际 diff 文本和行号、四边边框、背景切换与移除，以及关闭颜色的情形。
- 独立提交副本通过类型/lint 检查、构建及真实 `/diff`；当前工作区制品在 resize、ask/取消、关闭重开后保持样例代码颜色一致。面板底部高度和退出诊断差异仍保留。

## 2026-10-06 - 修复 diff 与代码预览的语法高亮

### 版本状态

- 未发布；引擎版本保持 `2.1.280`，真实 diff 样例对照官方 `2.1.291`。

### 关联提交

- 高亮依赖适配和回归按单一功能独立提交，不包含其他未提交的 Mods 改动。

### 变更内容

- 从 highlight.js 实际的 `_emitter` 读取 token tree，校验其子节点数组；修复读取不存在的 `emitter` 后抛错或静默退回普通颜色的问题。
- 缺少有效 token tree 时安全记录结果字段名称并保留普通文本，不再对不存在的对象调用 `Object.keys`。

### 测试覆盖

- 新增三项回归，覆盖 TypeScript diff 的行号、原始文本、关键词/字符串/数字和词级颜色，暗色/浅色代码预览及未知扩展名的普通文本。
- 本轮 ROOT 与官方真实 tmux 流程涵盖 resize、ask/取消、关闭重开和正常退出；样例代码前景及变更行 ANSI 一致，上下文/容器背景与退出诊断差异继续保留。精确日志、独立提交检查及总体范围见 mods-test。

## 2026-10-06 - Mods 依赖类型根与生成项目刷新

### 版本状态

- 未发布；引擎版本保持 `2.1.280`，源码与真实 CLI 对照官方 `2.1.291`。

### 关联提交

- 依赖类型、生成文件恢复和相关回归按同一作者项目功能独立提交。

### 变更内容

- 按加载顺序遍历直接与间接依赖，包含没有 hooks 或自身契约的中间插件；去重并终止循环，排除无关和停用插件。
- 依赖契约加入作者项目的明确类型根，优先链接真实文件；链接失败时复制不超过 256 KiB 的普通声明并去掉 BOM，拒绝越界契约和不安全名称。
- 与官方一致，刷新改写或截断的生成主声明、内部配置和 ignore 文件；退役依赖索引时保留作者同目录文件和根配置。两种根路径写法的并发安装使用真实路径串行化及原子写入。
- 同名 inline 插件可满足 marketplace-qualified 依赖；`inline`、`skills-dir` 和 `synced` 来源的裸名称不继承虚拟 marketplace。debug 输出类型根、纳入的类型名称、实际入口和变更文件。

### 测试覆盖

- 新增15个回归用例，覆盖依赖闭包、严格类型、复制边界、清理、配置恢复、路径保护、并发安装及 runtime 重载。
- 按官方生成目录语义更新既有断言，保留作者根配置、外部链接目标和旧非生成辅助文件的保护检查。
- 官方与本地新制品通过同样的真实 tmux 命令、reload 和正常退出流程；源码工作区门禁及独立提交副本的精确结果见 mods-test。

## 2026-10-06 - Mods 目录外入口的作者类型检查

### 版本状态

- 未发布；引擎版本保持 `2.1.280`，对照官方 `2.1.291`。

### 关联提交

- 按作者项目功能独立提交，其他 Mods、UI 和 diff 变更继续分批处理。

### 变更内容

- 作者项目追加 `hooks/` 外的实际入口文件；保留入口顺序并去重，不将无关同目录文件纳入检查。
- `/reload-plugins` 更新目录外入口；入口移回 `hooks/` 后移除旧 include，并保留作者根配置。
- 初版使用归属检查保护内部生成配置；该行为已由后续「Mods 依赖类型根与生成项目刷新」条目修正为官方的刷新语义。debug 输出插件、类型根、入口和写入文件。

### 测试覆盖

- 新增7个回归用例，覆盖精确入口的严格检查、目录边界、重载、配置保护、摘要完整性及 runtime 调用；原6个失败用例修复后通过。
- 官方和本地真实 tmux 使用同一插件、160×40终端、无凭据隔离配置，执行作者命令、`/reload-plugins` 和 `/exit`；两阶段默认项目严格类型检查通过。

## 2026-10-06 - 项目说明改写测试的 hook 夹具

### 版本状态

- 未发布；只修正测试夹具，生产运行时和版本保持不变。

### 关联提交

- 独立于作者声明和 runtime 批次提交。

### 变更内容

- 第二个 `prompt.context` 注册使用官方接受的空 matcher，保留同插件内的下游顺序与 provenance 检查。
- 加载后立即断言无诊断，避免把拒绝加载误判成模型请求内容改写失败。

### 测试覆盖

- 官方 2.1.290 与本地原生均拒绝旧夹具、接受更新夹具；Anthropic/OpenAI 三种说明改写情景的原断言保留。
- 实际 ROOT 原18个子测试18/0、包装器2/0，同一夹具在 clean HEAD 包装器2/0；166个变更文件的固定源码验证和仍开放的全量/UI边界见 mods-test。

## 2026-10-06 - Mods 完整作者声明与默认项目

### 版本状态

- 未发布；引擎版本保持不变，声明内容固定来自官方 2.1.290 原生制品。

### 关联提交

- 作为作者类型与项目生成批次验证；提交仍按功能和依赖拆分。

### 变更内容

- 用完整官方声明体替换手工维护的子集，保留公开类型、全部事件和操作映射、testing 及全局定义；明确列出仍缺失的生产运行时能力。
- 始终生成 `claude-code`、`claude-code-tools` 和 `claude-code-mcp` 三个类型根；默认根项目与官方相同，已有 tsconfig/jsconfig 和作者文件保留。
- 升级时移除仍校验匹配的旧生成 `results.d.ts`；作者替换、改写和符号链接保持原样。旧本地类型别名迁移方法见 README。

### 测试覆盖

- 官方原始声明与本地生成声明对同一批作者输入给出相同诊断；保持业务断言，按官方类型修正旧别名、pattern、挂载形状和 MCP 命名表检查。
- 精确提交副本的新制品与官方 290 使用相同的真实 tmux 插件加载、作者命令和正常退出流程；完整声明体和默认项目字节匹配，同一严格作者项目检查通过。
- 当前工作区已迁入这批源码，相关 ROOT 测试和旧 response 报告逐文件复验的精确结果见 mods-test；传递依赖、目录外 hooks 入口和完整 UI/diff 门禁仍未关闭。

## 2026-10-06 - Mods 通知便利调用契约

### 版本状态

- 未发布，版本和依赖保持不变。

### 关联提交

- 本条随通知便利调用、声明和生命周期回归测试一起提交。

### 变更内容

- `$.ui.log/status/toast` 同步返回 `void`；异步拒绝记录所属插件、操作名和原因，插件继续运行，`await` 不提供完成屏障。
- 文本在作者调用边界转换为字符串，status 的 `null`/`undefined` 清除；log 默认 transcript，toast 只传递数值 timeout，getter 和文本转换错误同步抛出。
- 导出可变的 `UiLogOptions`、`ToastOptions` 及 `UiLogSink`；status 作者参数要求显式传入 `string` 或 `undefined`。
- 无效的原始 `ui.log` sink 在进入 middleware 前拒绝，保留有效输入的下游改写。
- 已经开始的 capability 调用在作者 hook 正常返回后继续执行，保留原始所属插件；真实父调用取消、hook 失败和超时仍取消工作，恢复 catch 使用独立生命周期。

### 测试覆盖

- 实际 Worker 7案、严格作者类型2案、生命周期与现有 dispatch 回归、相邻UI回归，以及完整类型、lint、release-check和新构建验证；官方2.1.289及准确提交副本的新制品使用相同tmux输入和隔离环境对照返回值、转换、后台警告及继续执行。
- `toast(..., null)` 的跨realm `instanceof TypeError` 仍与官方不同；完整操作类型映射、API、UI帧及既有diff验收继续开放。

## 2026-10-06 - Mods 持久状态通知

### 版本状态

- 未发布，版本和依赖保持不变。

### 关联提交

- 本条随持久状态通知的实现、使用说明和回归测试一起提交。

### 变更内容

- `$.ui.status(text)` 显示在输入框下方，使用 `⚠ plugin: text` 的通知样式；同插件更新会替换旧条目，传入 `undefined` 会清除。多个插件的状态独立保留，toast 超时、折叠和抢占不清除持久状态。
- 通知状态增加独立的 pinned 列表，按优先级稳定排列；重复 key 不重复添加，也不启动超时。

### 测试覆盖

- 实际挂载的通知 hook 与 Ink 呈现检查 7 pass / 0 fail；原生 tmux 中对照官方2.1.289的显示、多插件共存、更新和两次清除，五阶段的状态行、ANSI 样式和相对位置一致，双方正常退出。
- 此批仅覆盖通知呈现；`ui.log/status/toast` 的同步返回值、错误报告与完整官方操作类型映射继续处理，不据此宣称完整 Mods 兼容。

## 2026-10-03 - Mods 请求上下文与独立修复

### 版本状态

- 未发布；本次按功能拆分本地签名提交，保持版本不变。

### 变更内容

- `prompt.compose` 在每次实际模型请求、fallback 和 retry 前使用当次模型与工具目录重组系统 prompt，并保留 shared/session 缓存边界和嵌套调用的 hook snapshot。
- `ui.toast` 校验通知载荷并按插件限流；terminal AbovePrompt 的绘制和 Client 交互接入 composer 焦点所有权。
- Mods 流取消等待异步清理，并保留宿主与 Worker teardown 异常。
- sticky 滚动保留已挂载范围的下界，避免离开底部时出现空白 spacer。
- Keychain 预取失败保留同步凭据回退；隔离构建测试在真实 `/tmp` 中保留证据。

### 测试覆盖

- 功能批次在独立累积快照中验证；官方 2.1.287 兼容性回归 37 项通过，G5 验证器 19 项新增检查及原有 driver 回归通过。各批测试、提交和未覆盖项见 `mods-test.md`。
- 此次未发布或推送；S7 并发验收工作保留未提交，完整 logical/physical 与 release 门禁仍 blocked。CHANGELOG 变更需要重新构建，历史 binary 证据不作为当前文档制品的验收。

## 2026-10-01 - Builtin Mods 启动生效、telemetry 默认关闭与 /diff 外观对齐

### 版本状态

- 未发布；保持版本与依赖不变。

### 变更内容

#### Mods 作者工具链与状态

- 增加 `claude plugin validate` 的 hook module、类型契约、state 读写和跨插件声明检查，以及 `claude plugin test` 的隔离 runner、`claude-code/testing` UI 查询/交互、mock、超时、子进程和 bun 风格报告；加载非 builtin Mod 时自动维护作者声明、tool/MCP 类型、`tsconfig.json` 与 `.gitignore`，并按完整旧内容身份迁移本地 2.1.280 生成布局，不覆盖未知或作者修改文件。
- 增加版本化 Mod state、owner-only 写入、JSON/大小边界和 `ifVersion` CAS；按实际读取的 key 记录 UI instance 订阅，state 变化只失效相关绘制，并对 reset、迟到写入和旧 render generation 做 fencing。
- 增加 `/plugin-authoring` 内置指南与 session consent：为当前 session 创建独立 authoring root，在公开 turn 结束后加载；同 session resume 恢复，`/clear` 和 fork 不继承。取消、迟到授权、session 切换和 withdrawn activation 不发布旧结果。
- 增加 terminal `AbovePrompt` surface 与焦点/滚动接线；修复嵌套 engine continuation 的解析，使合法 middleware 组合不会把未知 continuation ref 交给普通 Pane renderer。
- 增加官方 2.1.287 Token Weather、Blast Radius、Replay Theater 作者示例与 marketplace；作者文件保持官方原样并可在官方与本地 CLI 间互换。

#### Builtin Mods 与 diff

- 修复 builtin Mods 启动后需 `/reload-plugins` 才生效：MCP 配置在 builtin 异步注册完成前已 memoize 不含 builtin 的插件列表，注册完成后现在失效该缓存。
- `telemetry` builtin Mod 默认关闭，仅在 `CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY=1` 或 `/plugin` 手动启用时加载。
- Mods 不再获得当前会话的 Anthropic 凭据；生产环境中的 `session.authorize()` 恒返回空授权，builtin telemetry 即使显式启用也不会继承用户 credential。
- `/diff` sidebar 外观对齐官方：灰底无边框、单行 `N files changed +a -r ✕` 头部且计数与所示文件一致、`────` 文件分隔、未跟踪文件提示、按路径排序、按 base 居中的空状态；sidebar 不再显示无效按键提示；修复小 diff 被 render budget 截断及窄 dialog gutter 丢失 `+`/`-`。保留 Ask、按轮次查看、noise/pre-session 开关。
- `/diff` sidebar 接通 `ctrl+x b` 切换 base 与 `ctrl/meta+up/down` 切换文件；键绑定 hook 只在匹配自身 action 时结束 chord，取消交由全局 chord interceptor 判定，修复 diff 面板打开时 `ctrl+x b` 第二键落入输入框、`ctrl+x ctrl+e` 无法打开外部编辑器。

### 测试覆盖

- G1–G4、G6–G7、P1、P3、P9 的 runner、声明、validate、schema、runtime state/CAS、targeted invalidation 与 AbovePrompt 焦点/continuation 行为已有源码级回归；原样三个作者示例曾在隔离 native binary 中取得 validate 全部成功、test 依次 1/4/3 pass，并验证冷入口跨插件 state、旧声明迁移与失败退出。历史命令、制品身份和限制保留在 `mods-test.md`。
- G5 最新同轮 retained 专项的 not-now、enable/clear-cancel、cancel、turn-end-load、same-session-resume、fork-session 六场景均通过；该 manifest 仍为 `overall_verdict=blocked`，logical/physical frames、独立 child command、其余 M287/S1–S9 与 25 个 required targets 未完成，不宣称完整 feature/release gate 或全面官方 parity。
- 新增插件缓存失效、telemetry 默认/opt-in、生产授权恒空与 acceptance-only dummy 授权、diff 截断/窄 gutter/外观/空状态的回归测试；`mods-test-lab` 的 builtin telemetry/diff 验收不再先执行 `/reload-plugins`。
- CHANGELOG 会内嵌进 binary；上述 G5 动态证据使用的 SHA-256 `4157c065c477fe9440e92e8e36612be86ccdea533dde4115ed4331a7fbd3d9ab` 仅标识当轮历史产物。本文修改后必须重新构建并按新制品身份验收，不能沿用该 hash 声称当前产物通过。

## 2026-09-30 - v2.1.280 - Mods 宿主扩展、OAuth 与 OpenAI Daybreak

### 版本状态

- 本地待发布版本：`v2.1.280`；累计范围为上一 release tag `v2.1.219` 之后至当前实现提交 `29d8fef`（即 `v2.1.219..29d8fef`）。`29d8fef` 尚未推送至 `origin/feat/mods`；文档提交将在本条关联提交中单独记录。此版本不等于官方 Claude Code 功能全量对齐，本次不发布、不打 tag。
- `package.json` 及 SDK/Bun 依赖保持不变；版本提升使本地构建、billing 标识与 Claude OAuth `User-Agent` 的 `2.1.280` 版本一致。

### 关联提交

- `4444348^..39a9abd` — 独立本地会话通信、Plan mode 配置、跨平台进程身份、构建宏与当前功能说明；`fb7b441^..531dfdf` — Mods 生命周期、宿主能力、UI/REPL/Agent/模型与 builtin compiled 验收的累计实现、修复、测试和说明。
- `3b0d6ce`、`dbdb97e^..9ba61da`、`20ad11e^..57bd3a6` — OpenAI reasoning 恢复、`AGENTS.md` 指令链、Usage/Stats/status、Agent/TUI/diff、模型与运行时可靠性等累计改动。
- `9ba33c6` — 固定 Claude.ai OAuth 请求的 CLI UA 与 Stainless SDK/runtime headers，并设置 retry count `0`、timeout `600`；`3c4220e` — 校验手工 OAuth callback state，并修复服务端拒绝 token 后的强制刷新、并发替换识别与保存失败处理。
- `f024fd3^..7a337fe` — credential handle 撤销、完整 lifecycle cleanup、Pane redraw 串行化、`command.run.context`、stream resume rewrite 拒绝及 compiled telemetry credential recheck 验收；`bd06460` — extended cache TTL beta 与实际 request marker 对齐；`d031266` — 将默认构建版本更新为 `2.1.280` 并整理发布记录；`c07bf85` — 更新本版本变更日志。
- `ca233cb` — 修复 custom Clawd fullscreen 覆盖与超宽 wrapping、native `/diff` same-chunk navigation 与异步 body/frame rendering、中文 UTF-8/CSI-u/未闭合 bracketed paste 输入恢复及 Mods Pane focus handoff；`838dcdc` — 修复动态 Mods lifecycle、ToolSearch catalog/tool reference 刷新、managed tool hook 重复执行与无效输出回退；`a6bf5f3` — 兼容 stable/beta cache-control message blocks；`b8997a9` — 收紧 release-driver 的 terminal frame、nested Agent、SSH evidence 和 required-target 验证；`0e11b48` — 刷新本版本候选说明与当前使用文档；`887c499` — 增加 OpenAI Daybreak access program 命令、设置、Responses request mapping 与回归测试。
- `60e234a` — 稳定 native `/diff` sidebar 输入所有权、selection/body commit 与 terminal rendering；`e11af01` — 阻止非可信 Mods 注入 Agent 权限配置并保护后出现的 MCP/plugin/session 命名空间；`29d8fef` — 按 provider、endpoint 与 credential/account identity 隔离模型发现、bootstrap 与 gateway cache，并补齐 gateway credential 和请求身份边界。

### 变更内容

#### Mods 与插件宿主

- 累计提供可信 Mods 的加载、隔离 activation、作用域生命周期和配置管理，以及 tool/prompt/turn/command/session/settings、MCP、fs/process/store、模型、Agent、usage/telemetry、terminal media 与跨 surface UI 等宿主能力；支持 builtin modules 打包、compiled activation 和独立 acceptance host。
- 完善 prompt context/provenance、queued submission、fork/compaction、工具准入与取消、session shutdown、动态 commands/config、REPL 与 Agent provider 绑定；按 activation generation 原子发布与恢复能力，避免 stale runtime、缓存或设置刷新破坏当前会话。
- 修复 Pane/dock/fullscreen diff 的焦点、分页、滚动、尺寸、tab、图片更新和跨 Agent view 刷新，并补充官方类型 fixture、runtime test plugin、compiled builtin 与 telemetry release-driver 覆盖。
- `command.run` 支持官方 context 契约，逐层验证 context 只能追加且保留重复项，并将最终 context 作为隐藏但 model-visible 的 meta messages 注入；短路 hook 不再静默删除上游 context。
- session authorization handle 在每次 first-party HTTP 请求前重新解析 credential；credential kind、secret、session 或 activation 变化以及并发撤销都会永久拒绝旧 handle，拒绝路径不调用 transport。
- runtime、Worker environment 与 UI cleanup 改为完整、有序且幂等的 settled cleanup，保留多故障 `AggregateError`；同 target 的慢 redraw 串行执行并合并 trailing invalidation，close/unload/reopen 不再发布旧绘制。
- `turn.step` catch 只允许以等价输入恢复既有 downstream stream；改写 model 或嵌套输入时明确失败，不静默忽略，也不隐式创建第二次模型请求。

#### 会话、指令与运行时

- 增加 official-compatible 本地独立会话发现、认证通信、策略、receipt 和 UI；补齐 Linux/Windows 进程身份、Windows x64 构建目标，并以设置显式控制 Plan mode 可用性。
- 将 `AGENTS.md` 纳入指令发现、onboarding、memory、Agent 与 Workflow，保留结构化 prompt sections、来源与附件；改进 context window/usage breakdown、token cancellation、task 隔离、clear/fork snapshot 及 subprocess/SSH 失败恢复。
- 更新 Usage/Stats/status、Agent transcript 与任务操作、TUI resize/switching、原生 fullscreen diff、多 base Git backend、模型默认值和 request contracts；修复 OpenAI reasoning 跨 resume 持久化。
- 修复 fullscreen condensed custom Clawd 固定高度覆盖正文和超宽行 uncontrolled wrap；图案按 display-cell width 在横排与纵排间切换，并在可用宽度内截断。
- 修复 native `/diff` 连续按键与同 chunk `Down + Enter` 读取旧 selection、selected body 被渲染预算挤出，以及 resize、异步 partial publish 和 alternate-screen 增量输出可能出现的 logical/physical 不一致。
- 修复 PromptInput 在同一 stdin chunk 中提交中文、退格或导航时读取旧 cursor；支持 Unicode Kitty CSI-u，并让未闭合 bracketed paste 经两阶段有界恢复释放迟到 literal payload 后返回普通输入。
- 修复 Mods Pane 在 Escape 释放旧 drawing 后，新的 Tab focus 已发布却被旧 pending redraw 阻止同步到实际 DOM element 的焦点竞态。

#### OAuth 与版本标识

- Claude.ai OAuth first-party 请求固定发送 `claude-cli/2.1.280 (external, cli)`，并发送 Stainless JS package `0.112.1`、Node runtime `v26.3.0`、retry count `0` 与 timeout `600` headers；自定义 headers 仍保留既有覆盖顺序。
- 手工 OAuth callback 现在必须匹配当前 flow state；不匹配时拒绝 code exchange，并将错误返回 headless control caller，而不是接受错误或过期 callback。
- 收到 OAuth `401` 后即使本地 token 尚未过期也会强制刷新；等待锁期间若其他进程已替换失败 token则直接复用，刷新 token 保存失败则明确返回失败，不再误报恢复成功。
- 默认本地构建版本升至 `2.1.280`，使 binary/billing 版本和固定 OAuth UA 一致；未升级 Anthropic SDK 或 Bun runtime，也未验证真实 TLS JA3 指纹一致性。
- 主请求和 side query 仅在实际发送 `ttl: "1h"` cache marker 时附加 `extended-cache-ttl-2025-04-11` beta；遵守 first-party/experimental gate，并保持 5m、禁用 experimental 与不支持 provider 请求不携带该 beta。

#### 模型发现与缓存隔离

- OpenAI API、ChatGPT OAuth、official Anthropic bootstrap 与自定义 Anthropic gateway 的模型目录按 provider、规范化 endpoint、认证模式和 credential/account identity 隔离；身份不匹配时不读取旧目录，成功空响应只清空当前身份的目录。
- Anthropic gateway 使用独立磁盘缓存并保留 `display_name`、`name`、description 与 hidden metadata；最终 wire `Authorization`/`x-api-key` 参与缓存身份，custom headers 大小写不敏感覆盖默认值，原始 credential 不落盘。
- 自定义 gateway 只接受 `ANTHROPIC_AUTH_TOKEN`、显式 `ANTHROPIC_API_KEY` 或可信 `apiKeyHelper`，不发送 `/login` managed key 或 `CLAUDE_CODE_OAUTH_TOKEN`；gateway discovery 失败不回退 official bootstrap。
- First-party bootstrap 响应在请求开始与提交时校验同一身份；发现模型追加到内置 Claude catalog，client data 与 compaction window 只在当前 first-party identity 匹配时生效，切换 provider、gateway 或账户不会消费旧 bootstrap 数据。

#### OpenAI Daybreak

- OpenAI provider 新增 `/daybreak [blue|red]`：无参数时显示当前状态，有效值写入 user settings，非法值返回用法且不改写已有配置；非 OpenAI provider 不注册该命令。
- 配置 `blue` 或 `red` 后，普通 OpenAI Responses create 请求分别发送 `access_programs: { cyber: "daybreak_blue" }` 或 `daybreak_red`；未配置时省略该字段，remote compaction 请求始终不携带该 access-program marker，服务端拒绝仍按原始 OpenAI API 错误返回。

### 测试覆盖

- OAuth 定向测试为 12 passed / 0 failed，覆盖 callback state、`401` 强制刷新、并发 token 替换、保存失败以及固定 UA/SDK/runtime/retry/timeout headers；`cchFetch` 自执行断言通过。
- Mods focused regression 为 605 passed / 4 skipped / 0 failed；完整 `src/services/mods` 为 1274 passed / 11 skipped / 0 failed；后续竞态修复定向回归为 294 passed / 1 skipped / 0 failed，slash-command Mods 集成为 67 passed / 0 failed。
- `make release-check` 与 `make build` 已通过；本轮交互修复的 focused regression 分别覆盖 custom Clawd physical layout、Mods focus handoff、native `/diff` state/frame/physical terminal、中文 same-chunk 输入、Unicode CSI-u 与 bracketed-paste recovery。最终 scripted binary matrix 与 candidate binary SHA-256 仅在四路 release gate 全部完成后确认，本条不复用旧制品哈希声称通过。
- Daybreak command 回归覆盖 OpenAI-only 可见性、当前状态、大小写归一化、user settings 持久化、非法值不改写和 settings schema；OpenAI compatibility 回归覆盖 blue/red streaming 与非 streaming wire mapping、未配置时省略、remote compaction 隔离和 `403` 错误传播。
- 模型发现定向验证通过：`context.test.ts` 26 passed、`modelOptions.test.ts` 9 passed，`openaiModelOptions.test.ts` 与 `bootstrap-openai.test.ts` 自执行断言通过；覆盖 provider/base URL/account/credential/custom-auth-header identity、gateway hidden metadata、managed key 隔离、失败保留、成功空目录、请求中身份变化及 bootstrap client-data 失效。最新实现另通过 TypeScript、ESLint、`git diff --check` 和 `make build`，构建产物 SHA-256 为 `d87d1a9c4def2464b1a6948360d8f3c20a5fbc0aff3e0383552e18b7886eed42`。
- 只读远程能力检查分别确认 official Claude OAuth bootstrap/profile/models、Anthropic-compatible gateway `/v1/models` 与 ChatGPT OAuth Codex models endpoint 可访问；未发送 Messages 请求。隔离 OAuth 配置下的本地 binary `/status` 与 `/model` 显示 Claude Pro 登录及内置 Claude catalog；这些检查验证认证和目录入口，不等同于完整 release gate 或跨平台验收。
- 本条保留历史未发布条目中记录的局部失败、平台限制和未覆盖边界；credential 变化后的吊销、cleanup fault aggregation、slow redraw/reopen、command context 与 streaming catch rewrite 仍主要由源码级确定性测试覆盖，不以 builtin compiled gate 声称这些分支已有 binary fault-injection 验收；Daybreak 尚未完成本轮 fresh built binary 交互门禁，且 access-program 实际授权由 OpenAI 服务端决定；本轮未验证 JA3，未升级 SDK/Bun，也不声称全部平台或官方 runtime 完整 parity。

## 2026-09-19 - Mods 分页焦点与自适应布局修复

### 版本状态

- 未发布；保持版本与依赖不变。以下修复不解除旧 Workflow timeout、PTY 退出码异常的推送门禁。

### 变更内容

- 修复 Mods 分页复用 DOM 行时旧逻辑 key 和 plugin 行坐标未注销的问题，保留同 key 其他有效节点；host snapshot 同步焦点不再反馈成新的人工导航。跨页回调返回旧窗口槽位 key 时，在确认同一 DOM 已成为新绘制的请求目标且带 autoFocus 后交接焦点，避免选中项和实际焦点错位。连续导航等待已开始的绘制完成及对应 snapshot 实际提交后再解析下一目标，无重绘时直接继续；Escape、隐藏、owner 切换和卸载释放等待，替代绘制不再受旧绘制阻塞，后续独立焦点移动不复用旧分页交接，不使用固定延时。
- Button/Select/Input 的 key 复用既有 UI 字符串长度与总量预算，不再因完整文件路径超过64字符拒绝官方 diff 绘制；保留控制字符校验和精确 key 身份。
- Select/Input 的焦点高亮随实际 focus/blur 更新，不再出现 Input 始终高亮或 Select 入焦不可见。
- Diff 使用与插件绘制一致的 body 宽度预算，并按嵌套 Code 容器的实际 Yoga 宽度约束布局，替代固定76/80列；重绘和终端 resize 更新可用宽度与滚动范围。局部布局的 metrics 回报在 commit 完成后读取 viewport，避免父 ref 尚未重挂时的空指标触发更新循环。
- Dock 正文高度按实际 viewport 回报，composer 高度改变后重新绘制插件，焦点操作不再把测量值重置为终端估算值；Pane 保留基础高度并伸展填满可用空间，支持缩小后恢复，不将高度修复等同于插件虚拟分页的尾部可达性保证。
- Mods Pane 获焦时 transcript 让出 PageUp/PageDown 等键盘滚动，保留 Pane 外滚轮与失焦后的原快捷键行为；不再由 legacy handler 提前消费 Pane 的翻页输入。文件控件被详情重绘移除后，失效焦点回到 Pane 正文，方向键滚动正文而非误入辅助控件；Tab 仍可进入控件，Input/Select 保留自身按键消费。

### 测试覆盖

- 增加真实文件 key、五行窗口延迟重绘的16文件正反分页回归，覆盖逐次和连续方向键；补充精确注销、host 焦点回声、控件高亮、109/110列切换及嵌套 padding 的红绿验证。
- 新制品的限定 scripted tmux 验收、相邻回归及未覆盖项记录在 `mods-test.md` 对应历史轮次中；历史失败保留，不以本轮局部结果声称全仓或官方完整 parity 通过。

## 2026-09-19 - Mods 输入链与 SSH 长临时路径修复

### 版本状态

- 未发布；版本与依赖保持不变，不创建 tag 或 release。以下修复不覆盖上一轮失败，也不宣称官方完整兼容或 full-covered。

### 变更内容

- Mods Pane 增加受 composer/dialog 所有权约束的人工 Tab/鼠标入焦；方向键按可见控件顺序导航，使用 middleware 最终焦点落点并串行处理连续输入，Escape 取消待处理焦点。
- Pane 的 Button action 接入既有 keybinding/chord 系统，补齐 diff 文件导航与 base 切换默认键位，保留用户重绑/解绑及 drawing 生命周期；已被 legacy handler 消费的输入不再重复激活 DOM 控件。
- 保留已有鼠标 parser 的 wheel 坐标，按实际命中 Pane body 转为相对坐标传入 ui.scroll；插件虚拟列表可自行消费滚轮，无需外层内容溢出，不抢焦或额外滚动 transcript。
- SSH control/proxy socket 使用唯一私有目录，按 UTF-8 字节预算保留 OpenSSH 临时后缀空间，过长 TMP 自动选择短临时根；清理不递归删除仍存活的 socket，失败可诊断并重试。
- SSH child close/error 的 proxy 清理异常在事件回调边界记录，避免同步逸出；显式 stop 仍保留错误与重试语义。

### 测试覆盖

- SSH 长路径、多字节、并发目录、真实本地 UDS、启动失败和清理重试取得红→绿；主线程追加 close/error 两项红→绿，相邻10文件142 pass / 0 fail。该结果不代表真实远端 SSH 集成。
- Mods 输入链的红绿、相邻回归、提交后完整自动化及新制品 scripted tmux 结果见 `mods-test.md` 第 8 节；CHANGELOG 内嵌制品，后续动态测试结果不改变已构建内容身份。
- Workflow 原5000ms超时仍未定因；一次有界诊断的目标通过，但镜像漏内嵌 CHANGELOG 导致完整前缀不合格，不把未复现当成修复。指定 settings 的官方检查在 sandbox 编译前置受阻，official 未启动，不据此判断认证或 gate；推送门禁仍保留。

## 2026-09-18 - Mods 生命周期、宿主能力与兼容性收口

### 版本状态

- 未发布；记录 Mods 实现系列及本轮 settings/Escape 修复，不代表公开包已包含这些变更，不创建 tag 或 release。
- `Makefile VERSION` 保持 `2.1.219`，`package.json` 保持 `0.0.0-dev`；测试计划和最终验收记录位于根目录 `mods-test.md`。
- 本地源码支持范围、官方完整类型通过、本地运行官方插件原件与官方 binary runtime parity 分别判定，不宣称全官方 API、全部平台或 full-covered。

### 关联提交

- `fb7b441`、`54695c3`、`1476236` — Mods 基础生命周期、tool middleware、inline 启停与研究记录。
- `3dd5536`、`2899097`、`96e68bf` — accepted settings 内容身份、managed source merge 与 hook provenance。
- `83f72ac`、`9a1f602`、`e859a75`、`ad9af61`、`24e416c`、`9f64669` — loader/Worker 契约、fs/process/store、scoped classic hooks、命令、Pane 与宿主准入。
- `eb2c146`、`d48c698`、`164e811` — managed 工具审核与 prompt/turn/command 接线、初始化期间的草稿所有权。
- `462c676`、`1f09ebb`、`bc34711` — queued admission/public turn 生命周期、Pane resize 焦点与 mode-only managed precedence。
- `446eb28`、`d421338`、`19638f5`、`6c7b0e0`、`a46ed1a` — provenance、SSH/Workflow 回归与历史兼容性证据。
- `c006eeb`、`8de982f`、`0da3f73` — 本轮 hooks snapshot 审核边界、非法 remote managed 磁盘缓存回退和 Pane Escape 所有权修复。
- `be36848`、`ef1f440` — Mods 使用与测试方案；首次 SSH bootstrap 测试同步调整，后续完整复验仍重现。
- `d9a28d1` — SSH 测试用 awaited React `act` 等待 effects/state commit，显式验证 callback 安装并保证清理；保留全部原断言，不修改生产语义。

### 变更内容

- 可信 Plugin 可声明 Function Hooks modules；采用固定源码快照、共享 Worker 和独立 activation VM，按 register、engine.create、准入、session.start barrier 发布能力。
- 增加作用域能力与 lazy continuation，保留在途 generation；技术 reload 失败保旧，refuse/disable/remove 撤旧，取消和 Worker 失效不重放宿主副作用。
- 接入 tool/prompt/turn middleware、activation-owned commands、terminal Pane、session/settings、fs/process 和 JSON store；普通模型工具继续经过 managed hooks、schema 与权限主管线。
- 排队输入保存已完成的 admission，drain 不重复运行 prompt hooks；public turn 身份与初始化输入消费、新草稿恢复分离，避免队列或 barrier 导致重复注入和草稿覆盖。
- Pane resize 保留已有焦点，禁用释放 command/UI 所有权；本轮阻止 overlay 持有键盘时 composer 记录 Escape，避免快速关闭 Pane 误开 Rewind。
- 本轮移除 hooks snapshot 更新中的隐式磁盘 cache reset，使外部 settings 候选不能绕过 ConfigChange；可信启动/worktree cwd 转换显式刷新缓存。
- 本轮在 settings 边界验证 remote managed 磁盘缓存；非法 remote 层保留诊断但不参与 precedence/merge，合法 MDM、file、HKCU 层可接替，不把 schema 重依赖引回 leaf cache。
- README 增加 Mods 加载、启停、生命周期和可信代码边界；研究报告标清历史首批范围，根目录 `mods-test.md` 记录完整测试方案及后续结果。

### 测试覆盖

- 三项产品修复均取得最小红→绿；settings 四文件相邻回归117 pass / 0 fail，UI 相邻回归25 pass / 0 fail。首轮提交后 `make release-check`、`make build` 通过，版本保持不变。
- 首轮261文件独立进程为260 qualified、1565 registered pass / 3 Peer fail、106个完成脚本；同进程 raw 为1565 pass / 4 fail / 1 error，额外SSH readiness顶层失败确实存在。Mods 子集22文件559 pass / 0 fail / 0 skip，不能与全清单重复相加。
- 后续完整复验分别暴露既有SSH ControlPath长TMP限制、短TMP runner遗漏Peer fixture授权及SSH readiness再次失败，原始记录全部保留。最终SSH测试修复在两次完整清单中均完成；两轮分别1565 pass / 3 Peer fail与1564 pass / 4 fail，第二轮新增Workflow command-runner的5000ms超时、根因未定。Peer身份环境限制保留，历史PTY异常本轮未重现，不称根因已修复。
- 新binary的官方diff原件补验中，inline Enter、详情滚动、两级Escape及fullscreen鼠标row/边缘按钮分别通过；部分方向键导航、fullscreen快捷键与滚轮失败，不能宣称终端交互完整兼容。命令/UI smoke的13条通过不替代活跃Agent/Workflow/后台任务验收。
- 当前整体未通过，推送门禁仍阻塞；完整数字与证据见 `mods-test.md`。官方2.1.272自然gate限制、remote managed编译制品公开入口限制单列；父LCOV不能覆盖Worker/VM/child/compiled。CHANGELOG参与制品内嵌，结果回填后的构建与smoke另列身份，不沿用首轮制品hash。
- 已完成的真实 `@esonhugh/claude-code@2.1.219` 上下文对比：默认首轮内容 81984→74771 bytes，减少 8.80%，主要来自工具集合/描述差异；统一 Read-only 后六次规范化请求相同。不是功能等价优化、真实 tokenizer/计费测量或新构建的结果。

## 2026-09-15 - 独立会话通信、Plan 模式开关与运行时兼容性

### 版本状态

- 未发布；本条目覆盖 `v2.1.219..d7a939c`，不修改版本号、不创建 tag，也不代表公开产物已经包含这些变更。
- 当前本地发布线和 `Makefile VERSION` 保持 `2.1.219`，`package.json` 保持 `0.0.0-dev`。
- 同机 peer messaging 已在 macOS 当前构建中完成真实双向交互验证；Linux 和 Windows 的实现与静态/构建证据不等同于三平台完整原生运行验收。

### 关联提交

- `4444348` — 捕获同步 subprocess spawn 失败并按既有无抛出契约返回结果。
- `239893b` — 增加兼容官方协议的本地独立会话发现、收发、策略、回执、UI 和生命周期实现。
- `fb79ed0` — 通过 `planModeAvailable` 设置显式控制新进入 Plan mode 的能力。
- `f156fd4` — 对齐 Linux peer registry 的 PID domain 与进程启动身份。
- `0541ae4` — 修复跨会话启动竞态、macOS socket namespace 和运行时兼容细节。
- `b999302` — 增加 Windows process-start identity，并扩展 Windows x64 binary 构建目标。
- `dadf5b8` — 为受 guard 保护的版本读取统一注入 binary build macros。
- `d7a939c` — 去除 peer ingress 中重复的安全与回复提示。

### 变更内容

#### 独立 Claude 会话通信

- 新增 `ListAgents`、`SendMessage` peer 路由、`/list-agents` 和 `/peers`，允许同一 config 范围内的独立本地 CLI 发现并按名称、`name [ref]`、session UUID 或精确 `uds:` 地址通信；本进程 Agent 和 Teams 的既有路由优先级保持不变。
- 本地消息使用 official-compatible `msgV: 1` JSON-lines wire；macOS/Linux 使用 Unix domain socket，Windows 使用 named pipe，并通过独立 key 文件中的随机 token 完成首帧认证。
- Registry 记录协议、endpoint、session、名称、cwd、PID domain 和操作系统进程启动身份；发现时过滤当前实例、过期进程、PID reuse、namespace 不匹配和不兼容协议。
- 入站策略支持 `accept`、`hold` 和 `refuse`；空闲接收可唤醒队列，忙碌时保持队列顺序，hold 消息可在策略放行后处理，会话切换和退出会结算未处理消息。
- Peer 输入在 transcript 中使用独立 sender 标签和 provenance，禁用 slash command 与 attachment 解释，并明确声明其不是用户指令或权限批准；模型可按需通过 deferred `SendMessage` 回复。
- 发送成功只确认 transport write，不宣称对方已经接受或处理；`held`、`delivered`、`refused`、`dropped` 和 `expired` 通过关联 control receipt 独立更新。
- macOS 默认 socket namespace 对齐官方 `/tmp/cc-socks`；`/list-agents` 等命令等待 messaging setup 完成后再构建，避免启动时永久缓存缺失命令。
- Linux 使用 boot ID 与 PID namespace inode 组成 PID domain，并读取 `/proc/<pid>/stat` start time；Windows 使用 `OpenProcess` / `GetProcessTimes` 获取 FILETIME identity，并在 key/registry 中与其他平台字段分开保存。
- Peer 安全与回复提示只在 queued command 转换为 API attachment 时注入一次，避免 ingress 和 normalization 两次追加相同上下文。

#### Plan 模式和运行时可靠性

- `planModeAvailable` 显式控制 `/plan`、EnterPlanMode、Plan-sensitive tool schema、mode cycle、提示和 Agent 启动参数；关闭后禁止新进入 Plan mode，但保留已存在限制的退出路径。
- 同步 subprocess spawn 失败现在转换为稳定的 `execFileNoThrow` 结果，不再绕过调用方的错误处理契约。
- Binary 构建为 feature/version guard 注入一致的 macros，避免源码构建与 standalone 产物对受保护版本读取产生不同结果。
- Binary packaging 增加 Windows x64 与 Windows x64 baseline 目标；baseline 用于不具备 AVX2 的兼容环境，不代表 Wine 或 Windows 原生交互已经完整验收。

### 测试覆盖

- Cross-session 专项 Bun tests 隔离运行 40 passed / 0 failed，覆盖 UDS listener、分帧与认证、registry/discovery、PID reuse、接收策略、队列上限、session switch、receipt、`ListAgents`、`SendMessage`、print mode、prompt normalization 和进程身份。
- 当前 `built-claude` 双终端交互通过：模型经 ToolSearch 发现 deferred `ListAgents` / `SendMessage`，按 `name [ref]` 投递，接收端使用来信 `from` 地址自主回复精确 nonce，发送端真实 enqueue/dequeue 并显示回信；两端 `/cost` 可用，退出后 socket 已清理。
- 补充受控实验确认，仅依靠 peer prompt 中的回复提示即可触发 ToolSearch → deferred `SendMessage` → 真实回程；该实验不证明模型会对所有普通 peer 消息主动回复。
- 20 个隔离 OAuth fixture 的五角色 A/B 实验完成 20/20 transcript、`/cost`、statusline 与 debug/API usage 取证；B 组 10/10 形成 transport write → enqueue → dequeue → 后续模型响应。每个五会话 cluster 的平均 input-total 增量为 1,639 tokens，未观察到可稳定归因于 peer messaging 的 cache-hit 下降；该实验未覆盖模型自主选择 `SendMessage`，自主回复由上述补充实验单独验证。
- macOS 当前 binary 的同机双向发现、投递、自主回复和清理已运行验证；Linux 完成受限的本地身份/registry 验证，Windows 完成官方制品静态分析、process identity tests 和 x64/baseline 构建，Windows 原生完整 CLI↔CLI 与 Linux onboarding 后完整链路仍标记为 not covered。
- `make build`、peer 相关 ESLint 和 `git diff --check` 通过。`bun test src` 当前为 676 passed / 36 failed / 14 errors；失败集中在全量单进程的跨文件 mock/global/env 污染。裸 `bun test` 还会扫描需要 Jest 或外部 MCP conformance harness 的 `dist/codex` tests，因此不能作为本条目的通过门禁。

## 2026-09-10 - v2.1.219 - 插件重载、按需工具与 OpenAI 可观测性

### 版本状态

- 待发布版本：`v2.1.219`；2026-09-11 第 17 轮候选工作区的四路发布门禁全部通过，相关内容随后分批提交并推送至 `master`（`b88e81a`）。尚未打 tag 或正式发布。
- 已推送候选范围为 `v2.1.218..b88e81a`，包含 teammate transcript 保留与交互修复、OpenAI 类型修复、回归测试和发布门禁改动。两份既有 `docs/design/cross-session-messaging*.md` 设计草稿未提交，不属于本次发布内容。
- `Makefile VERSION` 与 README 本地发布线更新为 `2.1.219`；`package.json` 保持 `0.0.0-dev`。

### 关联提交

- `2ed520d`、`d5f1b98` — 插件更新后完整重载当前会话及设计说明。
- `cca3bfb`、`12a473d`、`fdd93e6`、`f796b86` — Workflow/Terminal 按需工具定义、上下文统计与 OpenAI 工具发现。
- `389a4e3`、`591087e`、`0f1febc`、`3d0525f` — 通用工具策略、单一 Workflow opt-in 设置与文档。
- `1192b1b` — `/stats` 增加 OpenAI 活动页。
- `30f754a` — 被查看 Agent 的活动显示独立于 coordinator。
- `cfe837c` — 记录 OpenAI 压缩 checkpoint 元数据。
- `59cda8d` — 统一 OpenAI instructions 序列化。
- `3dc228b`、`3c765fe`、`203131f` — 请求 wire prefix 诊断、跨 client 保留有界基线与回归测试。
- `99b9e4d` — OpenAI adapter 默认映射模型更新为 `gpt-5.6-luna`。
- `0833ba6` — OpenAI instructions 类型修复与 compact 调用契约测试。
- `2fca12e` — teammate transcript 宽限期、查看入口与导航按键隔离，以及会话插件重载回归测试。
- `c71f197`、`20115c2` — Usage 测试 mock 隔离与 Workflow fixture 显式启用配置。
- `d539543` — 确定性 binary 交互发布门禁与驱动回归测试。
- `b88e81a` — `v2.1.219` 版本配置与发布说明。

### 变更内容

- 插件 Update now 后的 `/reload-plugins` 完整应用安装版本、commands/skills 删除与替换，以及插件 MCP 重新发现；保留无关 MCP，重载不负责下载升级。
- ToolSearch 生效时按需提供 Terminal 和已启用的 Workflow schema；Workflow 使用 `enableWorkflows: true` 显式启用，上下文统计包含完整工具定义和已发现工具。
- OpenAI 工具搜索结果保留发现的工具名称；默认主提示集中提供通用工具与 Git 授权策略，精简 Bash schema 提示。具体行为及既有验证边界见下方 2026-09-08 条目。
- `/stats` 新增按需请求的 OpenAI 活动统计页，支持 `r` 刷新；本地统计加载、为空或失败时不阻塞页签切换。
- 被查看 Agent 的工具运行标识、loading 状态与本地 Agent spinner 使用自身状态，避免混入 coordinator 活动。
- 已查看的终态 teammate 在退出或切换后沿用 30 秒 panel 宽限期，期间允许重新打开已有 transcript；重新打开暂停回收，退出后重新计时，由既有 task GC 回收。Idle teammate 仍为 running，不按终态清理；未查看即结束或已回收的任务不在此重新打开保证内。
- OpenAI compact boundary 记录 provider、压缩前后 token、压缩调用 token 与可用的 compaction response ID。
- 普通与压缩请求统一 instructions 序列化，避免相同 system blocks 因拼接差异改变请求前缀。
- debug wire 诊断使用进程内摘要记录 instructions/tools/input 大小及公共前缀，按 thread/cache scope 与 create/compact 隔离，跨 client 保留最多 100 份基线；诊断不记录请求正文，也不证明服务端缓存命中。
- Anthropic 模型名称在 OpenAI adapter 中默认映射为 `gpt-5.6-luna`；显式 OpenAI 模型名称不变，实际可用性取决于服务端。

### 测试覆盖

- 第 17 轮候选工作区验证通过：相关 feature tests 为 146 passed / 0 failed，发布 driver 自测通过；`make release-check` 的版本、TypeScript、ESLint、imports/assets 与 diff 检查通过；`make build` 后的 scripted tmux binary gate 为 16/16 passed；release/docs 审计通过。
- 上述结果对应提交前的 `99b9e4d` 加第 17 轮基线记录的工作区改动，而非裸 `99b9e4d`；这些内容随后提交至 `b88e81a`。本次验收状态文案修订发生在该轮之后，不将该轮结果宣称为修订后 HEAD 的新一轮完整门禁。
- 新增 wire 回归断言覆盖 diagnostics disabled、跨 client 基线、create/compact 与 thread 隔离、有界淘汰及日志不含请求正文。
- 发布 driver 增补 coordinator/transcript 生命周期、插件重载、工具按需发现、OpenAI Stats、默认模型映射、wire diagnostics 与 checkpoint 元数据的交互场景及正反自测；这些场景已在第 17 轮真实 binary 门禁中通过。Workflow failure 与 partial retry 同时验证受控故障注入；自测和 binary 交互分别取证，不互相替代。
- 新场景使用隔离 dummy 认证、localhost Responses/MCP 和本地 marketplace；Stats 使用仅对子进程生效的测试 CA 与隔离 HTTPS fixture。验证范围不包含真实 OpenAI 服务可用性、模型自然调度成功率或远端 marketplace 下载。

## 2026-09-08 - 插件重载、工具按需加载与提示词精简

### 版本状态

- 未发布；本条目记录 master 的源码更新，不修改版本号、不创建 tag，也不代表公开包已包含这些变更。
- 当前本地发布线和 `Makefile VERSION` 保持 `2.1.218`，`package.json` 保持 `0.0.0-dev`。

### 关联提交

- `2ed520d` — 插件更新后的会话重载完整应用安装状态、commands/skills 与插件 MCP 连接。
- `d5f1b98` — 补充交互式插件更新与重载的设计、验证范围和限制。
- `cca3bfb` — Workflow 工具改为显式启用并延迟加载 schema。
- `12a473d` — Terminal 工具 schema 延迟到发现后加载。
- `fdd93e6` — 上下文统计包含完整工具定义，并区分已发现与未加载工具。
- `f796b86` — 在 OpenAI 搜索结果转换中保留已发现工具名称。
- `389a4e3` — 集中通用工具策略并精简 Bash 指引，补充专项测试。
- `591087e` — 统一使用 `enableWorkflows` 作为 Workflow opt-in 设置。

### 变更内容

- `/plugin manage` 的 Update now 更新安装缓存和记录后，通过 `/reload-plugins` 将已安装版本应用到当前会话；重载不承担 marketplace 升级或重新下载。
- 插件重载清除安装快照并完整替换 commands 与独立 skills，包括删除项与空集合；已安装的本地 marketplace 插件使用安装缓存版本，不绕过 update 读取已修改的 source。
- 显式插件重载在配置未变化时也清理插件 MCP 旧连接，再重新发现；不强制重启无关 MCP，清缓存也不会为了清理而启动未连接服务器。
- 重载摘要分别统计 commands 和 skills；MCP/LSP 数量表示配置数量，不表示异步服务已就绪。设计与验证边界见 [插件 marketplace 架构说明](docs/architecture/plugin-marketplace.md)。
- Terminal 和已启用的 Workflow 工具在 ToolSearch 生效时按需提供 schema；ToolSearch 未启用时仍可直接提供完整定义，不将 deferred 标记视为无条件隐藏。
- Workflow 使用 `enableWorkflows: true` 显式启用；功能未启用时不能通过 ToolSearch 将其加载。
- 上下文分析按工具名称、描述和输入 schema 估算工具开销，并将已发现的 deferred 工具计入加载部分；compact boundary 保留的发现记录继续参与统计。
- OpenAI Responses adapter 将 `tool_reference` 转为 `Tool available: <name>` 文本，避免搜索结果变为空字符串；完整 schema 仍由请求的 tools 数组提供，混合图片结果保持图片转换行为。
- Bash 工具说明移除 Git/PR 教程；默认主提示保留简短的 Git 操作授权及 hooks/signing 要求，专用工具优先与独立调用并行策略统一由主提示提供。
- Bash 保留 description 参数，删除长示例和用词禁令；创建文件前的 ls 检查仅要求用于尚未检查的目录，允许合理使用 cd 和多行脚本。
- 自定义 system prompt 替换默认主提示的调用方，需要自行提供从 Bash schema 移出的通用策略；本次不改变 Bash 执行器或权限检查。

### 测试覆盖

- 插件重载回归测试覆盖安装快照失效、commands/skills 替换与清空、数量统计、插件 MCP 能力移除和非插件保留，以及真实 install/update 的安装缓存版本选择。
- 已有 scripted tmux 验证在同一 CLI 进程中通过 Update now 和 `/reload-plugins` 检查同名 command/skill 更新、command 新增/删除、插件 MCP 新工具调用及非插件连接保留；模型使用受控 localhost fixture，不代表真实模型服务验收。远端 marketplace 下载、skill 新增/删除、hooks/LSP 完整生命周期、连续 reload 和恰好一次重连未包含在该交互结论中。
- Bash/主提示专项测试覆盖策略归属、Git 指令开关、description schema、条件化目录检查及 cd/多行指引，连续三轮均为 10 tests、64 assertions 通过。
- OpenAI adapter 回归测试先复现工具引用丢失，再验证普通和混合图片结果；工具发现、上下文分析与 adapter 相关测试通过。
- Anthropic-compatible 与 OpenAI 路径完成 ToolSearch → CronList → 再次调用的非交互和 scripted tmux 闭环；不据此声称 auto 阈值或自然语言发现率已验证。
- 合并基础配置与 provider 配置后，Bash 专项 Anthropic-compatible 重跑完成三次交互和两次非交互样本，另一次非交互超时停止；场景包含显式行为指令，不作为自然触发率或完整通过率的证明。
- 请求级 token A/B 仅包含 Bash 工具和固定输入，两个 provider 各三对请求均净减少 774 input tokens，已计入新增 Git 主提示开销；这是受控最小请求的 API usage 差值，不是完整 CLI 上下文下降比例，也不是原生 Claude tokenizer 的测量。

## 2026-09-02 - v2.1.218 - OpenAI 压缩、Goal/Hook、Trust 与 SSH 可靠性

### 版本状态

- 准备发布版本：`v2.1.218`。
- 本次发布覆盖 `v2.1.217..HEAD`，包括 OpenAI 压缩、Fast mode 与图像输入、Goal 与 Hook 生命周期、TrustDialog 风险提示、SSH 部署和 release gate 改动。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.218`。

### 关联提交

- `82999e8` — 在重复 OpenAI remote compaction 时保留上一轮 opaque compaction item。
- `7745df6` — 为手动 OpenAI compaction 创建独立 turn scope。
- `beffbf0` — 为连续阻止结束的 Stop hook 增加有界续跑与状态重置。
- `8a1f775` — 增加可持久化、可恢复的 Goal 状态与专用 Stop hook 生命周期。
- `3837ccb` — 增加交互式 `/goal` 状态查看、设置和清除流程。
- `ad16ce7` — 在 subagent query 提前失败时补跑 SubagentStop hooks。
- `850e6ce` — 为 OpenAI provider 增加 Fast mode priority 请求路径。
- `984d98b` — 更新 OpenAI Fast、Goal 生命周期与 Hook 可靠性的发布文档。
- `07d92b4` — 准备 `v2.1.218` 并扩充按变更路径选择 binary target 的 release gate。
- `e78a2bd` — 安全恢复 Goal 状态、会话 cost state 与 token baseline。
- `b143a06` — 保留 session hook 的 source、matcher、callback 与原始 hook identity。
- `3ea518f` — 完整处理 subagent 异常退出时的 SubagentStop fallback。
- `ab04807` — 在 workspace trust 对话框展示项目预授权权限和附加目录。
- `8a2e2df` — 为 SSH binary 上传复用 ControlMaster 连接。
- `06d5552` — 禁止模型通过 Skill tool 调用非交互式 Goal command。
- `555e7a3` — 在 Goal 状态视图中区分 active 状态。
- `b1a6437` — 将 SSH 部署块增大到 16 MiB，减少分块传输开销。
- `561022a` — 对齐 Goal resume 的 fresh metrics epoch 和内联生命周期提示。
- `7b1ecb8` — 为 ClearGoal tool 显示调用与结果消息。
- `42134af` — 修复 ClearGoal 结果消息未使用 Ink `Text` 渲染导致的交互式崩溃。
- `ca93894` — 补充 `v2.1.218` 的 release notes 与验证范围。
- `76ef725` — 补全 `v2.1.218` 的关联提交列表。
- `0571998` — 为 OpenAI Responses 转换用户与 Read tool 的图像输入。
- `8ae57b4` — 在构建中显式提供 bundled image processor fallback。
- `6da88a0` — 将 OpenAI 图像输入和 bundled fallback 纳入 `v2.1.218` 发布说明。
- `da1eb01` — 更新 embedded image runtime 与 scripted tmux 验证说明。
- `ee3bb5d` — 为 standalone binary 嵌入目标平台的 sharp/libvips runtime。
- `83b3d6a` — 为发布产物增加 bundled image runtime 门禁。

### 变更内容

#### OpenAI compaction

- OpenAI provider 下手动 `/compact` 即使不在 query turn 内也会创建稳定的 session、thread、turn 与 prompt cache scope，并继续使用 remote compaction 路径。
- 连续执行 remote compaction 时，后续请求会保留上一轮 opaque compaction item；压缩后继续对话也会携带该 item，避免早期会话上下文在重复压缩后丢失。

#### OpenAI Fast mode 与图像输入

- OpenAI API key 与 ChatGPT OAuth 用户现在可以使用 `/fast`；OpenAI model 不再受 Anthropic Opus 4.6 eligibility 限制，设置页、Model Picker 和 Fast mode 对话框使用 provider 对应的说明。
- OpenAI Responses 请求将 Fast mode 映射为 `service_tier: "priority"`，不发送内部 `speed` 字段；priority tier 不受支持时直接保留服务端错误，不启用 Anthropic 专属的 beta header、状态预取或自动降级路径。
- OpenAI API key 与 ChatGPT OAuth 会话现在会将用户图像和 Read tool 图像结果转换为 Responses `input_image`；独立 CLI 产物按目标平台嵌入并按需加载 sharp/libvips runtime，在原生 image processor 不可用时仍可缩放超限图像。

#### Goal 状态与恢复

- 交互式 `/goal` 无参数时打开状态视图，展示未设置、进行中、已完成或失败状态，以及耗时、turn、token 和最后检查原因；`/goal <condition>` 与 `/goal clear` 分别设置和清除 Goal，非交互式调用继续使用原有 prompt command。
- Goal 状态通过 `goal_status` attachment 持久化到 transcript；resume/continue 会恢复 active Goal 及其 source-scoped Stop hook，本地 transcript resume 会从当前时间、0 turn 和当前累计输出 token 创建新的 metrics epoch，避免把上一段会话的耗时、迭代和 token 计入 resumed Goal。
- Goal 判定为未完成时显示 `Goal not yet met… continuing` 并继续工作；完成、impossible 或 clear 时显示对应终态及 metrics。持久化 sentinel 不重复渲染，也不占用可见消息预算。
- Goal 状态视图使用独立 active 标识；ClearGoal tool 显示 `Clear active goal` 调用消息及 `Goal cleared`/`No goal set` 结果。
- 仍有后台任务运行时只延后 Goal 判定，不跳过普通 Stop hooks；Hooks 被策略限制或交互式 workspace 未信任时拒绝启动 Goal，Agent subagent 也不能通过 Skill、SetGoal 或 ClearGoal 修改主会话 Goal。

#### Prompt、Stop 与 SubagentStop hooks

- 普通 prompt hook 返回 `ok:false` 时默认阻止当前 turn，`continueOnBlock:true` 可继续；Stop/SubagentStop evaluator 返回 `ok:false` 时将 reason 注入 transcript 并继续 query，只有 Stop-class hook 的 `impossible:true` 会产生 terminal failure。
- Prompt evaluator 禁用 tools；API error 保持非阻塞。Command hook 的 exit code 2 优先于 stdout JSON，session hook 结果按 source、matcher 和原始 hook index 关联，避免 wildcard、并发完成顺序或 stale callback 串线。
- Stop hook 默认在第 9 次连续阻止结束后终止续跑并显示 warning；`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调整上限，`0` 或负数可禁用该上限，`maxTurns` 仍具有更高优先级，正常 tool round 会重置连续计数。
- Subagent query 在到达正常 hook 边界前异常退出时补跑一次 SubagentStop hooks，并保留完整 conversation、有效 permission mode、默认 timeout 和 blocking feedback；已经产生 SubagentStop progress/result 或正常完成时不会重复执行。

#### Workspace trust 与 SSH 部署

- TrustDialog 在接受 workspace 前展示项目配置预授权的 tool permissions 与 additional directories；按影响排序并清理 ANSI、控制字符和 bidi 字符，disabled 或 managed-policy 排除的来源不会进入提示。
- SSH binary 部署复用带 `ControlPersist` 的 ControlMaster，使用 16 MiB 分块降低重复握手和传输开销，同时保留逐块 checksum、重试、整文件 SHA-256 校验和原子安装。

### 测试覆盖

- OpenAI 测试覆盖 standalone turn scope、手动与连续 compaction、opaque item replay、`/fast` availability、provider eligibility、Anthropic 状态预取隔离、priority wire mapping、不支持 priority 时的错误传播，以及用户/Read tool 图像到 `input_image` 的 API key 与 ChatGPT OAuth wire 转换。
- 构建测试覆盖 image processor fallback、按目标选择和延迟加载 embedded sharp runtime、普通源码 build 隔离及 glibc/musl 依赖安装；FileReadTool 测试覆盖 PNG、JPEG、GIF 和 WebP 图像读取。
- Scripted tmux 图像门禁在当前 `built-claude` 中执行 2100×1 PNG 的 Read 流程，断言实际缩放为 2000×1，并验证单次稳定 call ID 的 OpenAI Responses `function_call_output`/`input_image` wire、prompt recovery 与进程清理。
- Goal 与 hook 测试覆盖交互式状态视图、attachment/sentinel、fresh resume metrics epoch、内联生命周期提示、success/block/impossible、后台任务延迟、command exit 2、callback identity、策略限制、长 transcript 重试和连续 block cap。
- Agent 测试覆盖 query 异常退出后的 SubagentStop fallback、完整 conversation、permission mode、blocking feedback、sidechain 记录及 exactly-once 边界。
- TrustDialog、SSH 与 ClearGoal 测试覆盖 permission/directory 风险摘要与清理、managed source 过滤、ControlMaster、16 MiB chunk、Goal 清理状态和 tool 消息。
- Scripted tmux 对照覆盖本地与官方 Goal 生命周期提示、完成 transcript replay 去重、active Goal resume fresh epoch、启动、dispatch 和 prompt recovery。
- 发布门禁运行 changelog schema/tests、TypeScript、ESLint、missing-import audit、`git diff --check`、聚焦 Bun tests 和当前源码 binary build。

## 2026-08-31 - OpenAI 手动与重复压缩修复

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.217`。
- 本条目覆盖 CHANGELOG 上次更新提交 `bdb25bd` 之后、2026-08-31 的 2 个提交。

### 关联提交

- `82999e8` — 在重复 OpenAI remote compaction 时保留上一轮 opaque compaction item。
- `7745df6` — 为手动 OpenAI compaction 创建独立 turn scope。

### 变更内容

#### OpenAI compaction

- OpenAI provider 下手动 `/compact` 即使不在 query turn 内也会创建稳定的 session、thread、turn 与 prompt cache scope，并继续使用 remote compaction 路径。
- 连续执行 remote compaction 时，后续请求会把上一轮 opaque compaction item 放在新输入之前；压缩后继续对话也会携带该 item，避免早期会话上下文在重复压缩后丢失。

### 测试覆盖

- OpenAI compatibility 测试覆盖 standalone turn scope、手动 compaction、连续两次 compaction 的输入顺序，以及压缩后继续对话时 opaque item 的保留。

## 2026-08-30 - v2.1.217 - OpenAI 会话路由与 GitHub Native 更新

### 版本状态

- 准备发布版本：`v2.1.217`。
- 本次发布覆盖 `v2.1.214..HEAD` 的 OpenAI Responses 会话路由、WebSocket/SSE 回退、Remote Compaction V2、Agent 委派提示及 GitHub Release native installer/update 改动。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.217`。

### 关联提交

- `fa385be` — 对齐 OpenAI Responses 的 session/thread/turn identity、prompt cache usage、WebSocket fallback 与 remote compaction，并减少重复 Agent 委派。
- `45c80d4` — 将 native install/update 迁移到经过 SHA-256 校验的 GitHub Release assets，并增加 Linux musl 构建。

### 变更内容

#### OpenAI Responses 会话与压缩

- OpenAI 请求按根 session 保持稳定 `prompt_cache_key`，区分 session、thread、turn 与每次 transport dispatch 的 request ID，并以 first-wins 方式保存 `x-codex-turn-state`。
- ChatGPT Responses transport 支持 WebSocket 优先及输出前 SSE 回退；输出开始后不重放请求，caller abort 不触发回退。
- OpenAI Remote Compaction V2 使用 opaque compaction item 持久化 compact boundary，并复用既有 hook、attachment、usage 和本地 fallback 生命周期。
- Agent 创建提示要求先检查是否确有必要委派，避免重复 Agent、重复上下文传递和无效迭代。

#### Native 安装与更新

- Native installer 和 `claude update` 从 GitHub Releases 查询版本、下载平台二进制，并使用同一 release 的 `SHA256SUMS.txt` 验证内容后再原子安装。
- Release workflow 新增 `linux-x64-musl` 与 `linux-arm64-musl` 构建，并在 Alpine 容器中执行验证，避免在缺少 musl loader 的 glibc runner 上产生伪失败。
- Native 自动更新与 Doctor 使用 GitHub latest release；实际版本二进制保存在 XDG data 目录，用户入口 symlink 指向当前版本。

### 测试覆盖

- OpenAI adapter 覆盖 request identity、cache usage、turn state、WebSocket fallback/abort、Remote Compaction 协议和 opaque replay。
- Native installer 覆盖 GitHub latest tag、release URL、checksum 精确匹配、二进制内容以及 native update 的 updated/already-current 状态。
- 发布前通过相关 Bun 测试、build packaging test、ripgrep tests、TypeScript、ESLint、missing-import audit 与 `git diff --check`。

## 2026-08-27 - v2.1.214 - Prompt 缓存稳定性、Effort 透传与 SSH 状态恢复

### 版本状态

- 准备发布版本：`v2.1.214`。
- 本次发布完整覆盖 `v2.1.213..HEAD` 的 21 个提交：20 个非 merge 功能、修复、测试与文档提交，以及 1 个整合 OpenAI/Skill prompt cache 修复的 merge commit；其中包括 first-party bootstrap 修复、对应测试与 release driver 调整。未跟踪的 `test-gate-bugs.md` 仅为内部 handoff，不属于发布内容。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.214`。

### 关联提交

- `818ceea` — 为模型发现缓存加入 provider/endpoint cache key，并在 provider 或 endpoint 切换时清理陈旧 Model Picker 选项；后续提交补齐 credential/account identity、endpoint 规范化与有效空列表语义。
- `b619ea1` — 按稳定核心、能力与任务动态层组织 system prompt，收敛 mode guidance，并加入可重复的 prompt cost 分析工具和测试。
- `2fd778f` — 在 custom system prompt 路径保留 proactive guidance，并修正对应 prompt 分析证据。
- `e918003` — 记录 prompt 分层候选与基线的隔离多轮 A/B 结果和证据边界。
- `3ee190c` — 补充 A/B scorer blind spots，收窄 permission、task 与 TMPDIR 结论。
- `25b0768` — 为 OpenAI Responses 请求发送稳定 session routing key，并将 cache usage 转换为 Anthropic-compatible additive buckets。
- `fbe0740` — 在生成 Skill listing prompt 前按 name 排序，避免 discovery order 破坏跨进程 cache prefix。
- `9bb1cb9` — 删除 provider-specific effort remapping，让 configured effort 原样进入 API，并贯通 `minimal` 配置档位。
- `cb00522` — 合并 OpenAI prompt cache reuse 与 Skill listing cache prefix 修复，同时保留本地 effort 透传改动。
- `65e9d88` — 允许 update-config 将不可直接表示的 Zod input 类型生成为 JSON Schema，并增加 bundled skill 回归断言。
- `b3a43ed` — 保留 OpenAI Responses reasoning summary/raw text，并将其转换为 Claude thinking blocks；补充相关 streaming 与非 streaming 回归覆盖。
- `fd4452f` — 记录官方 changelog migration candidates，明确本地 release 范围与上游迁移审计边界。
- `d961be2` — 允许 Agent 清除主会话已完成或不再适用的 active Goal，并保持主线程 Goal lifecycle 一致。
- `13ee2d4` — 同步 SSH remote 的 Goal、task、stream、tool 与 permission lifecycle，并在断线和会话替换时清理 stale runtime state。
- `4f6e02b` — 保留模型发现返回的 capability 状态，并修正 identity-aware cache 在有效空列表与失败响应下的更新语义。
- `1c739ef` — 加固 release binary driver 的 target coverage、evidence ownership、manifest 与 cleanup 验证。
- `96ad024` — 持续转发 SSH remote response text，并补齐 stream completion 与状态清理回归覆盖。
- `a79960d` — 保留 OpenAI caller metadata headers、处理无 trailing newline 的 SSE 终态，并在 SSH session 结束或断开时清理 permission state。
- `e96f037` — 加固 release validation 的 bootstrap、lease、manifest、SSH lifecycle 与 launcher 回归契约。

### 变更内容

#### Prompt 分层、模式指引与缓存边界

- system prompt 明确分为 `stable-core`、`capability` 和 `task-dynamic` 三层，稳定内容位于全局 cache boundary 之前，session-specific scratchpad 等动态内容保持在边界之后；重复 section 会去重，冲突 owner 必须显式 override。
- Plan mode 继续限制只读操作和 plan file 例外；与 Auto mode 同时启用时，Auto 只负责 Plan 已允许操作的 permission classification，不再产生可执行实现的冲突指引。
- proactive mode 不再暗示未经授权的 commit、push 或 PR；custom system prompt 在非 coordinator 会话中继续获得已启用的 proactive guidance。
- scratchpad 指引区分跨 tool call 的 session artifact 与 Bash 命令内 `$TMPDIR`，并提供 prompt dump 成本分析脚本、分层回归测试及限定结论的 A/B 评估文档。

#### 模型发现与 Prompt cache

- 模型发现缓存绑定当前 provider、ChatGPT/API 身份、gateway credential 与规范化 endpoint；发现启用时 Model Picker 只读取 identity 匹配的缓存：成功发现的非空结果替代对应 provider 的基础列表，成功但为空的结果会清空该 identity 的旧列表且不恢复 provider 基础列表，显式 current/custom model 仍可显示；切换 provider、账户、credential 或 gateway 后也不会混入上一配置的模型。模型发现关闭时，first-party bootstrap 返回的无 identity 附加模型仍按既有行为显示。
- OpenAI Responses 请求使用 session ID 填充 `prompt_cache_key`、`session-id`、`thread-id` 和 `x-client-request-id`，为同一会话后续 turn 提供稳定 routing/cache keys，支持服务端复用；caller `defaultHeaders` 中的普通 metadata header 会保留，而认证、content type 和 session routing headers 仍由 client 控制。
- OpenAI cached/write token usage 转换为 Anthropic additive usage buckets 时扣除已包含在 `input_tokens` 中的缓存 token，避免输入用量重复计算；兼容 OpenAI 与既有 Anthropic-style usage 字段；Responses reasoning summary/raw text 同时转换为 Claude thinking block，保留 streaming 与非 streaming 的可见推理内容；`response.incomplete`、`response.failed` 和 `error` 事件会保留服务端原因并作为请求错误传播，SSE 在 EOF 前没有 trailing newline 时也会处理最后一条完整事件。
- Skill listing 在格式化前稳定排序，避免不同进程中的 discovery order 改变 prompt prefix 并使 Anthropic cache 失效。
- 显式设置 `USE_LOCAL_OAUTH` 时，external build 也可使用配置的 local OAuth endpoint；未设置时继续使用 production OAuth，staging endpoint 仍仅限内部构建。

#### SSH remote 状态恢复

- SSH bootstrap replay 会将最后一个 Goal 状态恢复到本地 AppState；remote task start/progress/stop、streamed response text、response length 和 active tool ID 同步到 REPL，history replay 与 live echo 继续按 UUID 去重。
- remote terminal result、异常 SSH process exit 和显式 disconnect 会清理该 SSH session 拥有的 permission prompt、streaming tool、in-progress tool 与 background task state，避免断线后保留不可响应的 UI 状态。

#### Release validation driver

- release baseline 绑定 HEAD、完整 staged/unstaged/untracked/ignored 内容 identity 与本轮 binary metadata；binary driver 根据 committed release range 和工作树路径自动推导 mandatory feature targets，并使用隔离 dummy OpenAI endpoint 验证 effort wire、reasoning-to-thinking、模型发现空/非空状态、update-config skill 和 prompt mode cache prefix；first-party bootstrap target 必须实际命中隔离 endpoint、持久化 unkeyed cache 并由 Model Picker 消费，OpenAI error/usage 转换由 API 回归测试覆盖。
- binary driver 使用 resolved repository identity 的跨进程 lease 避免并发 gate 竞争，并在 final manifest 明确记录 normal/interrupted lifecycle 和矩阵完整性；SSH 变更会强制 isolated fake transport 的 built-binary lifecycle target。driver regression 与 scripted tmux gate 明确区分 spec、unit、fault injection 和 binary evidence；受控 workflow transient fault、稳定 Task/Run/Agent ID、terminal marker、通知、进程清理及 Git/workflow artifact 副作用任一缺失时均 fail closed；`/code-review` Scope agent 仅读取 diff stat、changed-file list 和相关 `CLAUDE.md` 等 bounded metadata，不读取完整 patch 或 changed source。

#### Effort 与 update-config

- `/effort`、Model Picker、settings Zod schema、SDK control/core schema、Agent definition 和 API adapter 新增 `minimal`；OpenAI 可选列表同时保留 `none`、`xhigh`、`max` 与 `ultra`，并向 Model Picker 和 SDK 声明 effort capability。
- configured effort 不再按 Anthropic/OpenAI provider 重写：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 和 `ultra` 均原样传入所选 API；本地编排模式 `ultracode` 仍展开为 API `xhigh`。
- bundled `update-config` skill 以 input schema 生成完整 Settings JSON Schema，并将 Zod 无法直接表示的 input 类型降为 JSON Schema `any`，避免 schema 生成阶段抛错而使 skill 不可用。

### 测试覆盖

- Prompt 专用测试覆盖 layer ordering、cache boundary、重复/冲突 section、Plan + Auto scope、scratchpad、custom/proactive system prompt、Bash/TaskCreate guidance，以及 prompt dump 分析器的稳定输出。
- API 与配置回归测试覆盖模型发现 cache identity、OpenAI request body/headers、同步与 streaming cache usage、reasoning-to-thinking 转换、Skill listing 顺序、configured effort 透传、`minimal` 的 CLI/settings/SDK/Agent schema 接受路径，以及 update-config schema JSON 生成；模型发现测试使用隔离 HOME 时不再依赖环境中预设的 custom model。
- 完整发布门禁要求同一源码状态下通过相关 `bun test`、`make release-check`、本轮 `make build` 后的 scripted tmux binary 交互矩阵和 release/docs audit；最终验收结果由本版本发布验证报告记录。

## 2026-08-22 - v2.1.213 - SSH 交互完整性、Prompt 精简与 Gateway 模型发现

### 版本状态

- 准备发布版本：`v2.1.213`。
- 本次发布的功能范围为 `v2.1.212` 之后、发布准备提交之前的 16 个功能与文档提交（`782826d..c080f70`）；发布元数据提交不计入功能提交数。范围包含 SSH local/remote 状态同步与路径交互修复、prompt context 精简，以及 OpenAI/Anthropic gateway 模型发现。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.213`。

### 关联提交

- `782826d` — 将 SSH settings 与认证保留在本地主机，并由 host-managed auth proxy 向远端提供最小接口。
- `082d331` — 同步 remote-owned history replay、消息 UUID、隐藏消息和 file-suggestion control lifecycle。
- `5b13424` — 补齐 SSH 远端目录、文件与 fuzzy suggestions 的连续路径补全。
- `b52f9a2` — 完成 managed SSH shell、history、Agent/工具显示、权限与路径交互，并精简主会话、Bash、Explore 和 Plan prompt。
- `2c860b4` — 通过 SSH control request 同步 permission mode、永久规则和取消状态。
- `a56a673` — 延长 managed SSH bootstrap timeout，允许较慢远端认证完成。
- `1b50a42` — 在远端验证 managed SSH workspace directory，避免本机路径判断污染远端行为。
- `6825bd9` — 保留 cold SSH file index build，并在当前 query 有效时有界刷新。
- `4248001` — 正确解码不完整 quoted path mention，覆盖空格和特殊字符路径。
- `b137c65` — 记录 prompt context 优化的设计、测量方法和边界。
- `df67d92` — 默认通过 attachment 暴露 Agent listing，减少基础 prompt 常驻内容。
- `0cae893` — 压缩 deferred tool namespace 指引，保留按需发现契约。
- `e742b05` — 精简 Agent orchestration guidance，删除重复说明。
- `1941b48` — 记录 prompt context 精简结果与剩余风险。
- `3133565` — 保持 deferred app namespace 相互独立，避免同名工具集合覆盖。
- `c080f70` — 增加统一模型发现入口、共享 Model Picker 缓存及 OpenAI/Anthropic gateway 回归测试。

### 变更内容

#### SSH 交互与执行边界

- SSH 本地 TUI 只负责 transport、认证 proxy 和权限交互；tools、skills、plugins、Agent、hooks、MCP、文件索引和 transcript 保持由 managed remote child 执行，避免加载本机项目上下文。
- `--settings`、`--setting-sources`、provider/upstream、Auth helper、custom headers、client certificate/key 和网络代理配置留在本地；原始配置、路径与 secret 不进入远端 argv/environment，远端 settings 也不能覆盖 host-managed provider/Auth/session 标记。
- permission mode、永久 permission rules、interrupt/cancel acknowledgement 和 replayed response 通过 control protocol 同步；失败或乱序响应不会错误提交本地状态。
- remote-owned history 在接受新输入前完成 bootstrap，保留 UUID、hidden/meta 消息、compact boundary 和顺序并与 live echo 去重；退出提示使用远端 session identity、target 和 cwd 生成可安全复制的 SSH resume 命令，本地不再双写 transcript。
- SSH `!command` 在 managed remote cwd 执行，和模型 turn 串行互斥；输入、stdout 与 stderr 以转义后的 synthetic transcript 提供给后续模型 turn，并保留中断、部分输出与退出状态。
- PromptInput 查询远端目录和 fuzzy index，支持 cold-index refresh、目录连续补全，以及包含空格、引号、反斜杠、美元符号、反引号和 Unicode 的路径。
- managed SSH bootstrap 与 workspace directory validation 使用远端语义，并为慢速认证、请求取消与断线 cleanup 提供明确边界。
- 远端 Agent 的 assistant/tool-result progress、Bash 和未知 MCP tool card 可在本地 TUI 显示；display-only fallback 不进入本地 execution catalog，也不能在本机执行。

#### Prompt context 与 deferred tools

- 主会话操作安全、Bash Git/PR、Explore 和 Plan 的静态说明在保留授权、安全、只读与输出契约的前提下合计从 13,439 缩至 3,833 字符，四类提示合计估算约减少 2,402 tokens；普通主会话冷缓存请求约减少 1,715 tokens。
- Agent listing 默认移入增量 attachment，首轮仍包含完整可用类型与权限，后续只发送增删；Agent orchestration guidance 合并重复的 foreground/background、fresh-context、briefing 和 resume 说明。
- deferred tool namespace 对同一 MCP namespace 的大列表使用汇总索引并保留精确增量状态；26-tool 样本从 935 缩至 64 字符。不同 Codex App namespace 保持独立，避免同名集合覆盖或错误路由。
- 新增 prompt context 优化设计与结果文档，记录测量基线、cache 稳定性收益、节省来源和未覆盖风险。

#### 模型发现与缓存

- `CLAUDE_CODE_USE_OPENAI=1` 时自动发现模型：ChatGPT OAuth 查询 Codex models endpoint，API key billing 查询 `OPENAI_BASE_URL/v1/models`，未配置 base URL 时使用 OpenAI 默认 API。
- Anthropic API billing 在设置 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 和 `ANTHROPIC_BASE_URL` 时查询 gateway `/v1/models`；`ANTHROPIC_AUTH_TOKEN` 使用 Bearer 且优先于通过 `x-api-key` 发送的 `ANTHROPIC_API_KEY`，普通 `CLAUDE_CODE_OAUTH_TOKEN` 不作为 gateway 发现凭据。
- base URL 会规范化为唯一的 `/v1/models` 路径；OpenAI 默认 API 过滤到受支持的 GPT/o-series/Codex 系列，自定义 OpenAI-compatible endpoint 与 Anthropic gateway 保留响应中声明 API support 的其他模型，hidden 项在 Model Picker 标记为 `(Hidden)`。
- OpenAI、Anthropic gateway 与既有 bootstrap model options 统一使用 `additionalModelOptionsCache`；启动模式固定时不再维护 OpenAI 专用缓存。
- 发现被禁用、缺少 base URL/认证、网络失败、超时或响应 malformed 时保留已有共享缓存，并回退到缓存或内置模型；成功且格式有效的空模型列表是 authoritative result，会清除对应 identity 的旧发现缓存，而不是恢复旧项。
- OpenRouter 仅作为 OpenAI-compatible `/v1/models` 测试目标，未增加 provider、路由、环境变量或专用缓存。

### 测试覆盖

- SSH focused tests 覆盖 settings/auth boundary、history replay、permission control、远端目录验证、cold-index refresh、特殊字符路径与 managed lifecycle；prompt tests 覆盖 Agent attachment、deferred namespace 和精简后的工具指引。
- OpenAI model options、bootstrap、OpenAI compatibility 和 auth env focused tests 通过，覆盖 discovery disabled、缺少 base URL、无可用 gateway auth、网络失败及失败时保留共享缓存；使用 `~/.codex/auth.json`、mjclouds Anthropic/OpenAI-compatible profile 和 OpenRouter profile 完成真实发现请求，分别发现 9、13 和 421 个可用模型。
- 使用当前源码构建 binary，并逐个打开 5 个 `~/.claude/settings*.json` profile 的 `/model` picker，验证当前项定位、滚动、方向键移动和 Esc 不保存；`v2.1.213` 完整 release gate 由本条目对应的发布验收流程执行。

## 2026-08-19 - v2.1.212 - SSH 权限同步与远程执行边界

### 版本状态

- 准备发布版本：`v2.1.212`。
- 本次发布覆盖 `v2.1.211..v2.1.212` 至 2026-08-19 的 SSH 权限模式同步、远程 shell、既有 Direct Connect 控制协议加固和本地/远端执行边界修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.212`。

### 关联提交

- `b82848a` — 同步 SSH 本地 TUI 与 managed remote child 的 bypass 权限状态，并在远端确认成功后更新本地模式。
- `3fa3cb4` — 将 shell、工具和项目上下文执行收敛到 managed remote child，并隔离本地 SSH UI 的项目设施。
- `06a9203` — 加固 Direct Connect control schema、permission cancellation 和 late response cleanup。
- `8a9381d` — 完成 remote session release candidate 的边界检查、测试与发布元数据。

### 变更内容

#### SSH 权限模式与控制协议

- `/plan`、`/yolo` 和 Shift+Tab 通过 SSH control request 同步到 managed remote child；显式 CLI permission 参数在 remote child 启动命令中转发。本地 UI 只有在远端成功确认 live mode change 后才提交模式变化，失败或乱序响应会恢复已确认状态。
- root remote child 只有在 host-managed provider、SSH remote marker 和非空随机 capability token 同时成立时才能使用 bypass；settings env 无法伪造或覆盖这些会话能力标记。
- 永久 permission updates 在 SSH、Direct Connect 和 Remote Session permission response 中保持完整；SSH manager 额外处理 replayed permission response、interrupt acknowledgement、取消超时、断线和 pending request cleanup。
- 本次发布不新增 Direct Connect transport；它在 `v2.1.211` 中已经是 HTTP session + WebSocket remote transport。本次仅使用完整 control schema 拒绝 malformed frame，跟踪 pending permission request，并在 server cancellation 到达时移除对应权限提示，避免 stale prompt 和取消后的迟到响应。

#### 远程 shell 与 transcript

- SSH 会话中的 `!command` 直接在 managed remote child 的远端 cwd 执行，不再发送给模型或误在本地主机运行；shell 与模型 turn 串行互斥，并支持中断、部分输出和明确退出状态。
- 远程 shell 输入、stdout 和 stderr 经过 XML 转义后写入 synthetic transcript，并立即尝试持久化；持久化失败会记录 debug error，但不改变已经成功的 shell 结果。后续模型 turn 可以引用内存中的真实远端输出，同时避免 transcript markup 注入。
- direct-shell control request 要求匹配每次会话生成的 capability token；缺失、空值或不匹配时 fail closed。

#### 本地与远端执行边界

- 本地 SSH 进程仅保留 TUI、SSH transport、认证 proxy、账户 onboarding 和 permission UI；tools、skills、plugins、agents、hooks、MCP、LSP、scheduler、文件索引、附件、repository context 和 remote transcript 均由 managed remote child 负责。
- SSH local UI 使用固定安全 slash-command 列表，并跳过本机 `CLAUDE.md`/Memory、Git repository、installed plugins、startup hooks、Logo recent-session preload、background housekeeping 和 spinner plugin predicate 扫描，避免把本机项目上下文泄漏到远端会话。
- SSH root argv 解析统一处理 `--`、dash-prefixed required values、agent/model precedence、auto-mode aliases 和 attached short options；明确拒绝 remote 不支持的 worktree、tmux 与 SDK URL 组合，并将 remote-owned advisor 参数转发给 managed child。
- 所有 remote execution session（Remote Session、既有 Direct Connect 和 SSH）当前都禁用本机 IDE integration、local tools 和 local skill watcher，避免本机 IDE/workspace 与远端执行上下文混用。该保守边界是 SSH 隔离所必需的，也意味着即使 Direct Connect server 与本机共享 workspace，remote session 也不会暴露本机 IDE MCP tools。

### 测试覆盖

- 当前六文件 SSH focused suite 共 86 项测试通过，覆盖 permission mode、capability token、direct shell、transcript、argv parsing、部署与 managed control lifecycle；Direct Connect control protocol 的 malformed request、server cancellation、socket close cleanup 和 late response 有专用回归测试。
- TypeScript、ESLint、missing import/asset audit 和 `git diff --check` 通过；实现阶段使用 `pojun-master` root 与 `test` 用户验收远端 shell、模型读取 shell transcript、`/plan`、`/yolo`、Shift+Tab 和 CLI bypass，ControlMaster cleanup 成功。
- debug log 证明 remote child 从 `bypass=false` 启动，收到并确认 `bypassPermissions` control request；最新 boundary run 未再观察到本机 Memory、Git repository 或 installed plugins 的加载日志。

## 2026-08-17 - v2.1.211 - Remote SSH 部署与生命周期加固

### 版本状态

- 准备发布版本：`v2.1.211`。
- 本次发布覆盖 `v2.1.210` 之后至 2026-08-17 的 SSH 超时、Remote binary 部署与 ControlMaster 生命周期修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.211`。

### 关联提交

- `37c0ba0` — 延长 SSH command timeout，并允许较慢的远端认证和连接重试完成。
- `c8d1585` — 强化 Remote SSH 分块部署、生命周期日志、ControlMaster cleanup 与短 ControlPath。
- `b20724c` — 首次补充 Remote SSH 加固说明；本条目将误放在 `v2.1.210` 下的内容移至正确版本。
- 当前维护本条目的 release metadata commit 因提交时 hash 尚未生成，不在关联提交中自引用；完整范围以 `v2.1.210..HEAD` 为准。

### 变更内容

#### SSH 连接与生命周期

- SSH command timeout 延长至 2 分钟，并使用 30 秒连接超时与 3 次连接尝试，允许较慢的远端认证和连接重试完成。
- ControlMaster 使用系统原生临时目录中的 96-bit 短随机 socket path，避免 macOS OpenSSH 的 Unix socket 路径长度限制并保持 Windows 兼容。
- SSH Remote 为 probe、部署、proxy、remote child 和 ControlMaster lifecycle 增加 debug log，并在启动失败、断线或正常退出时幂等清理远端 socket、认证 proxy 与本地 ControlMaster。

#### Remote binary 部署

- Remote binary 改为按 2 MiB 分块上传，每块校验 SHA-256 并对瞬时传输失败重试；全部完成后再次校验完整文件，再通过临时文件和原子 `mv` 安装，避免 partial binary 被执行。

### 测试覆盖

- SSH focused tests 覆盖慢速认证参数、分块上传与 checksum、瞬时失败重试、短 ControlPath，以及启动失败、断线、正常退出和 cleanup 失败时的幂等资源清理。
- 发布门禁要求 SSH focused tests、`make release-check VERSION=2.1.211`、发布版本 binary 构建与版本输出验证通过；真实 `pojun-master` 验收确认已安装 `v2.1.210` 无法完成 remote binary 部署，而 `./built-claude` `v2.1.211` 命中已校验 remote cache、启动 remote child 并进入远端 TUI。

## 2026-08-16 - v2.1.210 - SSH Remote、安全认证隧道与任务详情增强

### 版本状态

- 准备发布版本：`v2.1.210`。
- 本次发布覆盖 `v2.1.209` 之后至 2026-08-16 的 SSH Remote、SetGoal 输出、Terminal task 参数展示与发布门禁修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.210`。

### 关联提交

- `c0d0f78` — 在 Terminal 后台任务详情中保留并显示原始参数数组。
- `90d5325` — 在 SetGoal tool output 中显示当前目标内容。
- `eb8dbc3` — 默认启用安全的 SSH Remote 会话、认证隧道和 Linux remote binary 部署。
- `d054818` — 将本地解析后的 model 显式传给 SSH remote child。
- `a036cbf` — 修复 `/terminal` command source 合并冲突，并补齐 SSH lifecycle、managed env、root argv 与 Terminal detail 发布门禁覆盖。
- `444a7d3` — 修正 deep-research binary gate 对合法 source shortfall 的误判，并严格验证缺失 rank 的零工具调用契约。
- `7b2e0d2` — 将本地解析后的 model 显式传给 `ssh --local` child。
- `a563c88` — 将 release code-review gate 限定到显式解析的 release commit range，避免自动扩大审查范围。
- `91fa57f` — 准备 `v2.1.210` 的版本号、README 与 CHANGELOG 发布元数据。
- `92728c5` — 补充 local SSH model forwarding 与 bounded code-review gate 的发布说明。
- 当前维护本条目的 release metadata commit 因提交时 hash 尚未生成，不在关联提交中自引用；完整范围以 `v2.1.209..v2.1.210` 为准。

### 变更内容

#### SSH Remote 与认证边界

- 默认构建启用 `SSH_REMOTE`，新增 `claude ssh <host-or-config> [dir]`：本地 TUI 通过 stream-json 驱动远端 Linux child，支持 SDK 消息、tool permission allow/deny/cancel、interrupt 与断线清理。
- SSH host 可以直接使用 `user@host`、`~/.ssh/config` alias，或 settings 中的 `sshConfigs` ID；managed config 可声明 port、identity file 和默认远端目录，命令行 `[dir]` 可覆盖该目录。
- API/OAuth 凭据仅由本地 provider-aware Unix socket proxy 注入；远端 child 只收到 placeholder 与 reverse-forwarded socket path，不继承本机 OpenAI/Anthropic credential、base URL 或 auth token。
- 本地 proxy 分别限制 OpenAI `POST /responses` 与 Anthropic `POST /v1/messages`、`POST /v1/messages/count_tokens`，过滤请求和响应中的 credential/cookie headers，限制 request body，并拒绝非 loopback 明文 HTTP upstream。
- SSH Remote 将本地已解析 model 作为 `--model` 转发给 remote child；`ssh --local` 同样显式传递该 model，使自定义 gateway/model settings 在两种 child 启动路径中保持一致。

#### Remote binary 构建与部署

- SSH Remote 探测远端 Linux architecture，x64 主机使用 `linux-x64-baseline`，ARM64 使用 `linux-arm64`；远端 binary 按版本和 target 缓存在 `~/.cache/claude-ssh/` 并在部署前验证可执行版本。
- 发布 workflow 新增 `linux-x64-baseline` asset，并在生成 `SHA256SUMS.txt` 前校验完整平台 artifact 集；下载路径先核对 release checksum，再原子写入本地 cache 和远端目标。
- 开发态仅直接使用当前可执行文件相邻的 `dist/release` artifact，不从工作目录加载同名 binary；只有从 GitHub Release 下载的 asset 才要求 `SHA256SUMS.txt`，checksum 缺失或不匹配时 fail closed。

#### Goal 与 Terminal task 展示

- `SetGoal` tool output 显示当前目标内容，普通模式按显示宽度截断，verbose 模式保留完整多行目标。
- Terminal 后台任务保存原始 `args` 数组，并在任务详情中以 JSON 形式展示 command、args 与 cwd，避免只看到 executable 而无法还原启动参数。
- 用户输入 `/terminal` 时保留 `getCommands()` 中同名的内置 slash command 与 bundled Terminal skill；plugin/MCP command source 合并不再误删用户命令，用户侧优先打开 Terminal task 详情，模型侧 Skill lookup 仍保留原有 skill。

### 测试覆盖

- SSH focused tests 覆盖连接配置与输入校验、shell quoting、stream-json init/readiness、消息与 permission control、interrupt、早退/断线、OpenAI/Anthropic auth tunnel、settings env 隔离、header/route/body 安全边界、local/remote model forwarding、baseline target、checksum 与 cache 约束。
- build/release tests 覆盖默认 `SSH_REMOTE` feature、Linux x64 baseline target、release artifact 清单、checksum 生成顺序与 npm platform package 排除规则。
- SetGoal output、Terminal task details 和 `/terminal` command/skill name collision tests 覆盖短/多行/宽字符目标、后台参数持久化、UI 展示、真实 command source merge 与 user/model invocation 分流；deep-research driver regression 额外覆盖少于 15 个 unique URL 时实际来源 exact-once WebFetch、缺失 rank 的 `url: null`/`missingReason`/zero-tool 契约及非法 shortfall；code-review driver regression 验证使用解析后的 `<release-base>..HEAD` 且禁止扩大 diff range；发布门禁继续要求 focused tests、`make release-check`、当前 `built-claude` scripted tmux 交互和 release/docs audit 同轮通过。

## 2026-08-10 - v2.1.209 - Workflow 终态、失败诊断与会话一致性修复

### 版本状态

- 准备发布版本：`v2.1.209`。
- 本次发布覆盖 `v2.1.208` 之后至 2026-08-10 的 effort、自动压缩、主线程目标与 Workflow runtime 修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.209`。

### 关联提交

- `5c31e45` — 保持用户显式配置的 effort，不再根据模型 capability 静默降级。
- `66f9543` — 保留自动压缩与 Workflow failure 的原始错误、usage 和 retry 详情。
- `92220db` — 串行化同一 Workflow run 的进程内及跨进程 session mutation。
- `50684e4` — 允许主线程通过 `SetGoal` 设置自主完成目标，并隔离 Agent context。
- `b027a8b` — 收敛未等待的 runtime call，保护 Workflow task、run 与 terminal 状态一致性。
- `af64f72` — 移除 declarative Workflow 的默认 stall timeout，仅在显式配置正数阈值时启用 stalled 中止与重试。
- `fb84d33` — 补充本版本 Workflow stall 修复的发布说明；该提交仅维护 release metadata。

### 变更内容

#### Effort 与自动压缩错误保真

- 用户显式配置的 `xhigh`、`max`、`ultra` 和 `ultracode` 按 provider 映射后传入 API，模型 capability 仅限制可选档位，不再静默覆盖已有配置。
- 自动压缩遇到 `429`、rate limit 或 usage limit 时保留原始错误文本并恢复为 rate-limit/429 分类，不再统一伪装成 prompt-too-long；其他 blocking-limit 场景继续返回明确的上下文过长错误。

#### 主线程目标与 Workflow 诊断

- 主线程新增 `SetGoal` 工具并复用 `/goal` Stop hook，在目标尚未完成时阻止会话提前结束；Agent context 的工具过滤和运行时校验继续拒绝修改主会话目标。
- Workflow retry 与失败路径保留 logical worker、attempt、error kind、token、tool use、duration 和原始错误详情；跳过、暂停与终止路径固化相应 task/attempt 状态及当前 usage。
- 同一 Workflow run 的 session 更新通过进程内 mutation queue 与 canonical path 上的跨进程文件锁串行提交，并保留第一个 terminal 结果。

#### Runtime 终态完整性

- Workflow script 返回后等待已启动的 `agent()` 与 child `workflow()` runtime call 收敛，未等待或传递性启动的失败不会被误报为 completed。
- 重复 Workflow run ID 不再注册第二个 task；task 注册失败会留下可诊断的 failed session，terminal 后的迟到进度不能覆盖 task/run 终态。
- official-style script runtime 与 declarative Workflow Agent 未显式配置 `stallMs` 时均不附加隐式 stall timeout，可保持 running 直到真实终态；只有调用方显式配置正数 `stallMs` 时才启用 stalled 中止与重试。

### 测试覆盖

- effort、blocking-limit/compact error、SetGoal 隔离、Workflow usage/retry/session concurrency/runtime terminal integrity 均有对应 focused regression tests。
- 发布门禁要求完整执行 changelog 校验、TypeScript、ESLint、missing asset audit、`git diff --check`、ripgrep packaging tests 与当前源码 binary build/smoke；Python 验证脚本生成的 bytecode/cache 不进入 release payload。
- binary-side 验收使用 scripted tmux 覆盖直接/嵌套 Agent、Workflow、受控 retry/failure、`/deep-research` 和 `/code-review`；任一缺少稳定 ID、terminal marker、debug evidence 或副作用检查的目标均不得判为通过。

## 2026-08-04 - v2.1.208 - Agent、Workflow 生命周期验证与重试可靠性修复

### 版本状态

- 准备发布版本：`v2.1.208`。
- 本次发布覆盖 `v2.1.207` 之后的 Agent、Workflow、coordinator 和 release validation 生命周期修复。
- `package.json` 继续保持 `0.0.0-dev`；发布产物版本由构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.208`。

### 关联提交

- `c70318b` — 修复并发 teammate 注册时的 Team 配置覆盖与同名冲突。
- `564d0e3` — 修复 transient Workflow worker 重试，并保留 logical worker 与 attempt 诊断。
- `604e54f` — 支持发现并合并 persisted Workflow runs。
- `3c420ae` — 使用稳定 target identity 修复 coordinator Agent 视图导航。
- `a4bab5c` — 增加 Workflow runtime release gate 覆盖。
- `9db95a5` — 强制 Agent 与 Workflow 生命周期完成证明。
- `95f3743` — `docs: record unreleased workflow validation changes`，记录本次 Agent、Workflow 生命周期验证与重试可靠性修复。

### 变更内容

#### Team 与 Workflow 可靠性

- 并发 teammate 注册、删除和模式更新在最新 Team 配置上串行提交，避免 stale snapshot 覆盖成员状态，并为同名 teammate 分配稳定名称。
- transient Workflow worker 只重试失败的 logical worker，成功 worker 不重复执行；deterministic、schema 和 permission failure 不自动重试。
- Workflow 记录 task、run、phase、logical worker、attempt、error kind 和 terminal 状态，详情保留失败根因与重试链路。
- 进程重启后可以发现 persisted Workflow runs，并以 live run 优先、按 `workflowRunId` 去重提供只读 fallback。

#### Coordinator 与 Agent transcript

- coordinator 使用稳定 target identity 管理 main、background、Agent 和 Workflow 导航，目标消失时确定性回退到可见祖先或主线程。
- `local_agent` 与 `in_process_teammate` 统一 viewed-Agent 选择语义；正在查看的 terminal teammate transcript 在退出视图前保持完整。

#### Release validation 生命周期门禁

- binary gate 必须观察真实 Agent terminal marker、assistant transcript、Workflow worker/phase terminal、task notification 和主 prompt 恢复后才允许 cleanup 或判定通过。
- release driver 对缺少 terminal evidence、notification 或稳定 Task/Run/Agent ID 的场景 fail closed，避免仅凭 pane 文本或状态文件产生假阳性。

### 测试覆盖

- Team、Workflow retry/diagnostics、persisted Workflow、coordinator selector、viewed Agent transcript 和显式 permission mode focused tests 通过。
- `test-release-driver.py`、`bunx tsc --noEmit --pretty false`、`bun run lint`、`make release-check` 和 `make build` 通过。
- built binary 生命周期验收通过 Agent 前后台、nested Agent、inline Workflow、`/deep-research`、`/code-review`、deterministic failure detail 和 partial transient retry targets。

## 2026-08-02 - v2.1.207 - MCP Skill 生命周期与 Agent transcript 上下文修复

### 版本状态

- 准备发布版本：`v2.1.207`。
- 本次发布覆盖 `v2.1.206` 之后至 2026-08-02 的 Agent transcript 上下文修复与 MCP Skill over MCP 生命周期实现。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.207`。

### 关联提交

- `5ac290f` — 2026-08-01 — `fix: preserve agent transcript context`
- `1ade751` — 2026-08-02 — `feat: implement MCP skill extension lifecycle`

### 变更内容

#### Agent transcript 上下文与会话切换

- 选中 local Agent 或 in-process teammate 时，REPL transcript 使用该任务自己的 messages、运行状态和 in-progress tool use，不再错误回退或混入 leader 会话内容。
- 进入 transcript 模式时同时冻结当前 task identity、message length 和 streaming tool-use length；即使随后任务状态变化，当前 transcript 仍绑定进入时选中的 Agent，上下文不会在会话之间漂移。
- 统一 viewed Agent selector，使 local Agent 与 in-process teammate 共享明确的选择语义；无选择、无效 task ID 或非 Agent task 均不静默回退到其他任务。

#### Skill discovery、identity 与完整性

- 普通 MCP server 支持 `io.modelcontextprotocol/skills` 扩展的 `skills/list`、`skills/get`、empty/partial listing 和 direct/unlisted URI activation；Skill identity 绑定 host-assigned server 与完整 URI，不再依赖名称或 `skill:` scheme，并为同名不同路径 Skill 生成可区分的调用名称。
- `resources[]` 作为完整 manifest 绑定 `SKILL.md` 与 supporting resources，逐文件验证 canonical `sha256:` digest，并要求 listing frontmatter 与实际 `SKILL.md` frontmatter 逐字段一致；content-addressed cache 同时绑定 server identity、URI 和完整 manifest snapshot。
- 保留无 `resources[]` dynamic Skill 和 legacy single-file Skill 的加载路径，但不为 dynamic content 建立持久 cache，且 supporting-resource 访问默认 fail closed。

#### Resource scope 与目录读取

- `ReadMcpResourceTool` 将 supporting-resource 访问绑定 active Skill 的 originating server、Skill URI 和 manifest grant，在模型看到内容前验证 text/blob 原始内容 digest，并拒绝未列出、跨 server、响应缺项、额外资源和 malformed base64。
- 新增 `ReadMcpResourceDirTool` 和 `resources/directory/read` pagination；目录访问限制在显式 Skill root 内，结果由 manifest 推导 direct children 和 metadata，拒绝 ancestor traversal、跨 origin、unlisted child 与 incomplete listing。
- 普通 MCP Skill 顺序激活时替换上一 Skill 的远程资源 scope，避免权限累积；可信 Agent definition 显式 preload 的多 Skill union 保持原有设计。

#### Codex Apps 隔离

- Codex Apps 继续使用独立的 `resources/list + mimeType: "mcp/skill"` lazy materialization，不受普通 MCP Skill extension discovery、resource grants、cache 和 attachment guard 影响。
- 声明 Skill extension 的普通 MCP server 不能通过 generic attachment preload 绕过 `skills/get`、digest、frontmatter identity 或 SkillTool permission gate；普通 generic MCP resources 与 host-owned Codex Apps 保持原行为。

### 测试覆盖

- `src/state/selectors.test.ts` 覆盖 leader 无选择、无效 task ID、local Agent、in-process teammate 和 teammate-only selector 边界。
- MCP focused suite 共 `82 pass`、`0 fail`，覆盖 canonical manifest、`skills/get`、direct URI、domain-native URI、same-name disambiguation、frontmatter identity、per-resource digest、directory pagination、cache identity、dynamic fail-closed、root containment 和 sequential scope replacement。
- `bunx tsc --noEmit --pretty false`、`bun run lint`、`git diff --check`、`git diff --cached --check` 和 `make build` 均通过；发布前重新构建并校验 `2.1.207 (Claude Code)` 产物。
- scripted tmux runtime validation 通过 canonical list/load/invoke、direct URI、same-name activation、supporting-resource allowlist、directory pagination、same-identity cold/warm cache、dynamic no-manifest denial、ancestor directory denial，以及 OAI/non-OAI settings 下 ordinary MCP 与 Codex Apps materialization 隔离。
- non-OAI ordinary MCP invocation 已 qualified passed；真实 settings proxy 下的 authenticated OAI ordinary invocation和实际 authorized Codex Apps 调用仍为 `not covered`，未将临时 MITM harness 的失败归因于产品路径。

## 2026-08-01 - v2.1.206 - Coordinator、MCP Skill 与 Agent 生命周期增强

### 版本状态

- 准备发布版本：`v2.1.206`。
- 本次发布覆盖 `v2.1.205` tag 之后至 2026-08-01 的全部提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.206`。

### 关联提交

- `9a9d4b5` — 2026-07-31 — `fix: collapse nested agents in coordinator status`
- `710d4f2` — 2026-07-31 — `fix: align recursive coordinator navigation and rows`
- `26f95b3` — 2026-08-01 — `feat: expose MCP skill provenance`
- `7da0067` — 2026-08-01 — `feat: route nested agents through coordinator worker`
- `51721b7` — 2026-08-01 — `docs: document coordinator worker changes`

### 变更内容

#### Coordinator 与 Agent 生命周期

- Coordinator 主视图聚合递归子 Agent，支持 root、child、grandchild transcript 导航，并隔离 Workflow Agent 子树；Agent 行显示真实类型、description、焦点状态和运行中后代数量。
- Coordinator 模式恢复内置 `worker` Agent，提供自主执行任务所需的工具、权限和运行轮次，并约束 Worker 的任务范围、子 Agent 派生、错误处理和结果汇报。
- nested Agent 在父 Agent 仍运行时将终态 notification 路由到父 Agent；父 Agent 已结束、不存在或不可消费时回退主线程，避免结果在 Coordinator 上下文中重复展示。
- Agent 结束时检查未匹配的 `tool_use`；工具调用尚未完成时进入 failed 状态，不再使用旧文本结果错误生成 completed 状态。

#### MCP Skill 与 Codex Apps 来源

- 非 Codex MCP server 支持通过 `io.modelcontextprotocol/skills` 扩展和 `skills/list` 发现社区 Skill over MCP，并通过 `resources/read` 延迟加载 `skill://<name>/SKILL.md` 内容。
- Skill 来源拆分为 `MCP skills` 与 `Codex skills`，slash autocomplete 增加 Codex 来源标记；远端 Skill 内容不会获得工具、hook、model、agent 或 shell 执行权限。

### 测试覆盖

- Coordinator 行模型、Worker 定义、nested notification 路由、通知去重、未完成 tool use 失败、前后台续接、MCP Skill discovery 和来源展示均有 focused test 覆盖。
- `make release-check` 通过：CHANGELOG、TypeScript、ESLint、缺失导入审计和 `git diff --check` 全部通过；本轮 `built-claude` scripted tmux 验证通过 direct Agent 前后台生命周期、nested Agent、Workflow/WorkflowTool、task/notification、`/deep-research` 和 `/code-review`。
- `/deep-research` 验证 5 次 WebSearch 与 15 次 WebFetch exact-once；`AgentTool.nesting.test.ts` 的额外 worktree 断言受当前 Agent Teams 计划门控影响，未将未覆盖部分伪造为通过。

## 2026-07-27 - v2.1.205 - Agent 权限继承、Workflow 稳定性、release notes 校验与用量成本修复

### 版本状态

- 准备发布版本：`v2.1.205`。
- 本次发布覆盖 `v2.1.204` tag 之后至 2026-07-27 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.205`。

### 关联提交

- `2f0331a` — 2026-07-25 — `update: expose ChatGPT usage and reset controls`
- `ccbbd3e` — 2026-07-26 — `update: bundle and validate release notes`
- `b89577c` — 2026-07-26 — `fix: inherit agent permissions across launches`
- `cca50c2` — 2026-07-27 — `fix: harden agent and workflow launches`
- `7164ec2` — 2026-07-27 — `fix: undefined of usage.input_token bug`

### 变更内容

#### Agent 与 Workflow 权限继承

- Agent tool 的 `mode` 改为可选；未显式指定时继承调用方权限。父会话为 `bypassPermissions` 时，模型直接派发的 direct、resume、named、process/pane 和 in-process Agent，以及省略 `permissionMode` 的 Workflow Agent 均保持 bypass。
- 普通 Agent mode 按官方权限等级限制提权，同时保留可信 Agent definition 的 `permissionMode` 提权能力；父会话为 bypass 时忽略模型自动生成的较低 mode，避免被意外降为 `default` 或 `acceptEdits`。Workflow 配置中显式声明的 `permissionMode` 仍作为可信 launch context 生效；plan approval 后同步 task 与 team member mode。
- Agent definition 的 `tools`、`disallowedTools` 及 `Read(example.txt)`、`Bash(npm test)` 等参数化 permission rules 传播到 schema、session allow rules 和子进程 CLI flags。

#### Workflow runtime 与发布门禁

- bundled deep-research 新增单一 passive `select-sources` phase：统一按 Search worker/result 顺序去重并选择 15 个 URL，15 个 Fetch worker只消费各自的 `oneBasedRank`；缺少 rank 时不编造或替换来源，binary gate 校验 Search/WebFetch exact-once、共享 rank 一致性、retry 与意外工具调用。
- Script Workflow 的 Agent stall 现在同时中止子 controller 并终止 runtime await；即使底层 Agent call 忽略 abort，parallel workflow 仍会将该 Agent 记为 failed 并进入 task/run/notification 终态，不再永久停在 running。
- built-claude 验证 launcher 在 `env -i` 隔离下仅透传大小写 proxy 变量，不传播 auth 或无关宿主变量；binary driver 等待持久化 task notification，并将 Workflow 未完成时未执行的 UI 检查明确标记为 skipped。

#### ChatGPT usage 与 release notes

- `/usage` 和 Settings Usage 支持 ChatGPT 用量窗口及 rate-limit reset credits，reset 操作经过确认并在成功后刷新显示。
- release notes 改为从内置 `CHANGELOG.md` 读取并按当前 binary version 截断；新增 changelog 格式、版本和发布脚本校验。

#### 用量成本计算修复

- 非流式 fallback 路径在 API 响应缺失 `usage` 时不再崩溃：调用侧改用归一化后的 `usage`，`calculateUSDCost` 增加缺失 `usage` 的边界守卫并按零成本处理，修复 `undefined is not an object (evaluating '$.input_tokens')`。

### 测试覆盖

- Agent permission、resume、foreground/background continuation、teammate propagation、Workflow stall terminalization、bundled deep-research source-selection 和 release driver focused tests 均通过；TypeScript、ESLint、missing imports/assets audit 与 `git diff --check` 通过。
- `src/utils/modelCost.test.ts` 覆盖 `calculateUSDCost` 在缺失 `usage` 时返回 0 且不抛异常、正常 `usage` 仍计算正成本。
- 同一 Round 9 fresh `2.1.204` binary（SHA-256 `7b61f508bebf4c2d71e6d00fa07494194a9723bd0fbd79ebd66afc4714875951`）完成 readiness、direct foreground→background、nested Agent、inline Workflow UI/task/notification、deep-research 和 code-review 交互矩阵；5 个 Search 与 15 个 Fetch worker 均 exact-once，15 个 Fetch URL 全部匹配共享 source rank，且未留下本轮 task/process/tmux 或 Git 副作用。

## 2026-07-24 - v2.1.204 - Workflow/Agent 失败记账、重试恢复与 OpenAI Web Search

### 版本状态

- 准备发布版本：`v2.1.204`。
- 本次发布覆盖 `v2.1.203` tag 之后至 2026-07-24 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.204`。

### 关联提交

- `f9f637a` — 2026-07-21 — `update: README`
- `a9af0b1` — 2026-07-21 — `remove: name incorrect`
- `cc70099` — 2026-07-22 — `test: cover workflow agent failure validation`
- `e4e8130` — 2026-07-22 — `fix workflow agent failure accounting`
- `500103b` — 2026-07-22 — `fix workflow retry identity edge cases`
- `fc1f1cc` — 2026-07-22 — `fix workflow retry and resume consistency`
- `aac126c` — 2026-07-23 — `require runtime interaction in validation skills`
- `44dceca` — 2026-07-23 — `fix workflow agent scheduling consistency`
- `efa2fff` — 2026-07-23 — `update: Chaneglogs`
- `ea2b350` — 2026-07-23 — `update: validate release check example scripts`
- `31a07f1` — 2026-07-24 — `enable OpenAI web search workflows`

### 变更内容

#### Workflow Agent 失败、重试与终态记账

- Agent terminal/API/structured-output 失败不再被当作成功；Local Workflow task 分离 logical Agent 与 physical attempt，并记录连续 retry lineage。
- automatic/manual retry 共用连续 attempt identity；旧 attempt 的迟到结果不能覆盖当前 active attempt。
- Workflow 状态页、详情页和 Coordinator 行按 terminal outcome 计算 completed、failed、skipped 与进度。

#### Resume、identity 与权限边界

- Workflow journal 和 declarative resume 仅复用 `completed` result；非完成 entry 不会污染或遮蔽后续完成 entry。
- resume identity 使用实际生效的 permission mode；Agent label 在整个 Workflow run 内唯一，重复 suffix 分配保持线性。
- Agent 显式 `mode` 进入 worker permission context；子 Agent 只能保持或收紧父会话权限。父会话为 `bypassPermissions` 且子 Agent未显式收紧时默认继承 bypass。
- foreground → background continuation 继续消费原 Agent stream，不重复启动 Agent。

#### Script Workflow 与 deep-research

- 删除 script Workflow 固定的 run-level Agent lifetime hard cap；声明式 spec 的 `defaults.maxAgents` 规划校验保留。`parallel()`/`pipeline()` 继续以最多 16 个活跃槽位执行大规模 fan-out。
- OpenAI/ChatGPT provider 启用 server-side `WebSearch`，将 Anthropic web-search schema、forced `tool_choice`、OpenAI Responses `web_search_call`、URL citations 和 usage 转换为现有 Anthropic-compatible stream 事件。
- bundled deep-research 为 5 个 Search worker 和 15 个 Fetch worker分配确定的一对一职责，避免每个 worker重复整个 phase fan-out；3 个 Verify worker各自产生一票，Verify/Synthesize 仅消费上游证据，不再自行调用本地工具或二次委派。

#### 发布门禁

- release validation 使用 repo 外动态 baseline 绑定当前 HEAD、Git 状态和本轮 `built-claude` metadata，不硬编码旧 commit/hash。
- binary gate 使用隔离副作用目录和正常现有账户认证，清除会覆盖私有 gate auth fixture 的 inherited API/OAuth 环境变量；credential 值不进入 evidence。
- readiness、Search/Fetch transcript tool-use/result 关联、process cleanup 和 forced-termination 判定均 fail-closed；历史 false-pass fixture 必须被拒绝。

### 测试覆盖

- Round 7 Feature tests 通过：AgentTool、WorkflowTool、LocalWorkflowTask、OpenAI compatibility、bundled workflow 和 release driver 相关测试均成功，TypeScript 通过；1001-Agent probe 完成 1001 个 logical/physical executions，最大 physical concurrency 为 8（`<=16`）。
- v2.1.204 发布准备时重跑 `make release-check` 通过：version guard、TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均成功。
- 发布准备时 `make build` 生成 `2.1.204` binary（SHA-256 `0ec7399407c672eb315130110d4d792955739fef2ee8dfeaddfa075beceeeacf`），`./built-claude --version` 输出 `2.1.204 (Claude Code)`；本次相对上一轮仅为 `Makefile` 版本号变更，无运行时逻辑改动。
- 下列 binary-side 交互证据来自同一份源码在上一轮 `2.1.203` 构建下的验收（`31a07f1` 当时为待提交改动，现已提交，源码内容一致）：persisted binary driver 的 readiness、direct/nested Agent、foreground/background continuation、Workflow 内 Agent、`/workflows`、`/deep-research` 和 `/code-review high` 全部通过。
- `/deep-research` 实际完成固定 25 workers：WebSearch `5/5`、WebFetch `15/15`（11 成功、4 个符合契约的外部来源失败）、Verify `3/3`、Synthesize `1/1`；无 retry、替代工具、重复通知或遗留 tmux session。
- Release/docs audit 确认版本、README、CHANGELOG 范围和实现一致，diff/file-list 扫描未发现高置信度敏感信息；其唯一 placeholder finding 已由最终报告刷新关闭。
- 完整结论见 `docs/gate-check/2026-07-23-workflow-agent-release-gate.md`；原始 pane、debug log、Task/Run/Agent ID 和 cleanup evidence 保存在 `/tmp/cc-release-final-20260723/final-round-7/`。

## 2026-07-21 - v2.1.203 - Explore/Plan Agent、Codex Apps 与 Terminal 生命周期修复

### 版本状态

- 准备发布版本：`v2.1.203`。
- 本次发布覆盖 `v2.1.202` tag 之后至 2026-07-21 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本为 `2.1.203`。

### 关联提交

- `eef7e23` — 2026-07-19 — `feat: add hosted Codex Apps MCP skills`
- `c2f2ed1` — 2026-07-19 — `fix: expose supported hidden OpenAI models`
- `8246689` — 2026-07-20 — `fix: harden Codex app and terminal lifecycles`
- `3143e6f` — 2026-07-20 — `fix: deliver terminal completion notifications`
- `0ce3afc` — 2026-07-20 — `release: prepare v2.1.203`
- `49cfc32` — 2026-07-20 — `remove: handoff`（仅删除临时交接文档，无运行时变更）
- `231eead` — 2026-07-20 — `fix: gate ChatGPT status by provider`
- `50988a1` — 2026-07-21 — `docs: complete v2.1.203 commit inventory`
- `2341b70` — 2026-07-21 — `test: isolate OpenAI bootstrap cache`
- `5aaa0e3` — 2026-07-21 — `fix: harden terminal and hosted app lifecycles`
- `cad9f94` — 2026-07-21 — `docs: plan instruction footprint reduction`（仅新增执行计划，无运行时变更）
- `199f088` — 2026-07-21 — `fix: embed platform ripgrep in packaged binaries`
- `e3b64c5` — 2026-07-21 — `merge: integrate origin/master`
- `ce05dff` — 2026-07-21 — `fix: simplify embedded ripgrep validation`
- `b79b677` — 2026-07-21 — `refactor: reduce model instruction overhead`
- `0fa556f` — 2026-07-21 — `update: add feature Explore Agent`
- `3da5846` — 2026-07-21 — `docs: consolidate v2.1.203 changelog`

发布证据整理和本条目维护提交（包括 `5e475c6`、`94d8d58` 及后续同类提交）不改变发布功能范围，因此不重复列入关联提交清单。

### 变更内容

#### Explore 与 Plan 内置 Agent

- 对齐 Claude Code `2.1.201` 的内置 Agent 注册逻辑，默认启用只读代码搜索 `Explore` Agent 和只读方案设计 `Plan` Agent。
- 移除恢复构建专用的 `BUILTIN_EXPLORE_PLAN_AGENTS` 编译期 gate，改用 `tengu_slate_ibis` GrowthBook gate；未取得远端配置时默认启用。
- 支持通过 `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 显式关闭 `Explore` 和 `Plan`。
- 新增内置 Agent 注册回归测试，覆盖默认启用和环境变量关闭路径。

#### Codex Apps hosted MCP skills

- 新增 host-owned `codex_apps_plugins` MCP runtime，通过 `mcp/skill` resources 发现并按需读取 hosted skills，同时保持 Apps tools 与 skills 投影相互独立，避免重复暴露工具。
- 对 hosted skill 的来源、名称、URI、分页、内容大小和缓存进行限制；仅允许可信的 `codex_apps` 与 `codex_apps_plugins` server 进入该加载路径。
- Codex Apps transport 仅向固定 ChatGPT Apps MCP endpoint 注入 OAuth 与 account 信息，并在 `401` 后强制刷新 token 重试一次。
- Host-owned plugin resources 仅用于 hosted skill 发现，不再作为 generic MCP resources 暴露；缓存绑定 client identity 并增加 TTL。
- 修复同名 connector 的 mention 冲突，并改善包含空格或特殊形式的 Codex Apps mention 补全。

#### OpenAI 模型与 ChatGPT 状态

- OpenAI 与 ChatGPT Codex 模型列表不再无条件过滤 `visibility: "hide"` 的模型；名称符合支持范围且 `supported_in_api !== false` 时，可在 Model Picker 中以 `(Hidden)` 标识显示。
- CLI 启动前等待 ChatGPT utilization 预取完成，避免初始 plan/usage 状态竞态；API key 和非 OpenAI provider 不会请求 ChatGPT subscription usage。
- 隔离 OpenAI bootstrap 测试使用的 model options cache，避免组合测试结果依赖执行顺序。

#### Terminal 终态与 PTY 生命周期

- Terminal task 由统一后台 poller 同步状态和 preview；进程自然退出后自动停止轮询、清理 runtime registry、持久化最终输出，并仅发送一次完成通知。
- 根据真实 PTY 状态区分 `completed`、`failed` 与 `killed`，保留 `exitCode`、`signal`、termination reason 和 driver error。
- signal、close 和状态刷新在进程结束后继续 drain 尾部输出；Bun PTY driver 等待真实进程退出后再确认 signal。
- exited、closed 和 failed session 在 TTL 到期后主动 dispose；Background Tasks detail dialog 不再维护重复 polling。

#### 打包与模型指令

- 打包时校验并嵌入当前平台的 ripgrep，运行时提取到本地缓存，避免依赖系统安装。
- 精简模型指令中的重复内容，降低提示开销，同时保持 Agent、工具和交互约束不变。

### 测试覆盖

- Codex Apps、OpenAI model options、provider-gated ChatGPT plan/usage、Terminal lifecycle 与 AgentTool focused tests 通过。
- `make build` 通过；最新 `built-claude` scripted tmux 验收已确认 `v2.1.203` 启动及 Terminal PTY 生命周期。
- 本地 `built-claude` 真实交互成功调用 `subagent_type: "Explore"`；debug log 确认请求精确解析为 `Explore` 并完成前台 Agent 生命周期。
- 使用 dummy OpenAI credential 与受控 Responses SSE 完成相关发布验收，未使用真实 OpenAI/ChatGPT 凭据或外部 endpoint。

## 2026-07-19 - v2.1.202 - Terminal Tool、功能验收 Skill 与 Codex Apps 集成

### 版本状态

- 准备发布版本：`v2.1.202`。
- 本次发布的功能与修复范围从 `master`（`3df519a`）之后开始；下方列出影响运行时、测试、构建与发布工具的关联提交，纯 CHANGELOG 维护提交不重复自引用。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.202`。

### 关联提交

- `375159f` — 2026-07-19 — `feat: add Claude Code feature validation skill`
- `c6e07d4` — 2026-07-19 — `refactor: rename interactive terminal to Terminal`
- `4bb7a73` — 2026-07-19 — `feat: integrate Codex Apps with ChatGPT subscriptions`
- `5f91915` — 2026-07-19 — `release: prepare v1.2.202`（后续修正为 `v2.1.202`）
- `e93a6cd` — 2026-07-19 — `fix: restore OpenAI credential precedence`
- `10fe3f9` — 2026-07-19 — `fix: fix up bug of openai apikey order and usage data`
- `92fdb6c` — 2026-07-19 — `update: bundle test`
- `19f6ae0` — 2026-07-19 — `docs: clarify OpenAI usage authentication states`
- `03af8cc` — 2026-07-19 — `update: release validation tools`
- `16b341b` — 2026-07-19 — `fix: align Codex Apps with active credentials`

### 变更内容

#### InteractiveTerminal 重命名为 Terminal Tool

- 将 `InteractiveTerminal` 工具、task、command、bundled skill 和 UI preview 统一重命名为 `Terminal`，同步更新工具 schema、模型提示、结果格式和后台任务展示。
- 保留并强化持久 PTY session 的 `open`、`write`、`read`、`resize`、`signal`、`status`、`list` 和 `close` 生命周期；补充 shell 解析和 Bun PTY driver 行为。
- 扩展 Terminal Tool、task state、dialog preview、PTY session manager、shell resolution 和 binary integration 测试，移除旧 `InteractiveTerminalTool` 实现与测试路径。

#### Claude Code 功能验收 Skill

- 新增 `claude-code-feature-validation` skill，根据功能类型路由 source tests、构建检查、tmux TUI 验收、official parity 和外部状态验证。
- 补充 validation routing 参考文档与 eval cases，明确何时需要真实 binary、tmux、官方 CLI 对照及证据留存。

#### Codex Apps mention 与补全

- 新增 `@codex-app:{app-name}` mention 语法，仅从当前已发现且已过滤的 `codex_apps` 工具池解析对应 App，不恢复禁用 connector、不授予未发现能力，也不绕过工具权限。
- 将已选择 App 的名称、connector ID 和工具名称作为不可信 metadata 注入模型上下文，并引导 deferred tool 通过 `ToolSearch` 按需加载。
- PromptInput 在裸 `@` 和 `@codex-app:` 前缀下展示真实 Codex Apps 补全；补全项沿用统一 suggestion UI，并与文件、MCP resource 和 agent mention 区分。
- 防止 Codex App mention 被文件或 MCP resource mention 解析器重复处理，并避免 slash command / skill 展开内容误触发。

#### ChatGPT subscription 检测与 Usage UI

- 对齐 Codex 的 OpenAI plan 解析规则，从 ID token 的 `chatgpt_plan_type` claim 识别并规范化 `Plus`、`Pro`、`Team`、`Business`、`Enterprise` 等订阅名称。
- 保持 `OPENAI_AUTH_TOKEN`、`OPENAI_API_KEY`、auth file API key、ChatGPT OAuth 的原始模型 API 凭据优先级，并以当前实际选中的模型凭据统一驱动计费、Usage 与 Codex Apps 状态。
- 当前模型使用 ChatGPT OAuth 时，Usage 请求前主动刷新 token，启动 pane 使用 `/backend-api/wham/usage` 的权威 `plan_type` 显示 ChatGPT plan；使用 API key 或 bearer token 时显示 `API Usage Billing`，不展示 ChatGPT subscription usage。
- OpenAI 模式不再错误回退 Anthropic Usage；`/status` 的 Usage tab 在 ChatGPT OAuth 模式下展示 Codex limits、account、reset time 和 reset credits，在 API credential 模式下显示 OpenAI-specific unavailable 状态。

### 测试覆盖

- Terminal Tool、PTY session manager、shell resolution、Codex App mention、attachment 隔离、PromptInput completion、OpenAI auth 和 ChatGPT Usage focused tests 通过。
- `make release-check` 通过：`package.json` version guard、TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均通过。
- `make build` 通过。
- tmux binary-side 验收确认：启动 pane 显示权威 `ChatGPT Pro`，`/status` Usage 成功加载 limits，`/mcp` 显示 `codex_apps` connected，输入 `@codex-app:` 可列出真实 Apps。

## 2026-07-16 - v2.1.201 - `/cd` 目录补全与 Effort 配置修正

### 版本状态

- 准备发布版本：`v2.1.201`。
- 本次发布覆盖 `v2.1.200` tag（`3fb49ec`）之后至 2026-07-16 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.201`。

### 关联提交

- `39124c5` — 2026-07-16 — `feat: add directory completion for /cd`
- `10ae12c` — 2026-07-16 — `update: effort fix`

### 变更内容

#### `/cd` 目录补全

- 为 `/cd` 命令接入仅包含目录的路径补全，并允许在命令后的路径参数为空时开始提示。
- 保持 `/add-dir` 原有行为：只有用户开始输入路径后才显示目录建议，路径以空白结尾时清除建议。

#### Effort 配置与显示

- 允许 `xhigh`、`max`、`ultra` 和 `ultracode` 写入 settings 并跨会话保留；`none` 与数字 effort 仍不持久化。
- `ultracode` 统一按 `xhigh` 作为 provider 映射输入：支持原生 `xhigh` 的 Anthropic 模型保留 `xhigh`，其他模型按既有能力回退；OpenAI 仍发送 `xhigh`。
- Effort 状态提示和请求后缀显示实际应用值，不再把 `ultra`、`ultracode` 等统一折叠为基础等级；同步修正 `/effort` 帮助、有效选项和 session-only 文案。
- 扩展 settings schema、Model Picker 初始化及 Anthropic/OpenAI effort 回归测试，覆盖新增持久化和映射行为。

### 测试覆盖

- 与 `v2.1.200` 相比共修改 10 个文件，新增 65 行、删除 51 行。
- `git diff --check v2.1.200..HEAD` 通过。

## 2026-07-16 - v2.1.200 - Workflow facade 官方契约与发布验收收束

### 版本状态

- 准备发布版本：`v2.1.200`。
- 本次发布覆盖 `v2.1.178` 后至 2026-07-16 的提交。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.200`。

### 关联提交

- `ac53549` — 2026-07-15 — `feat: enable Codex Apps by default`
- `3272f0b` — 2026-07-15 — `update: add restriction of tmux cli validation and type checks`
- `f48a1d8` — 2026-07-16 — `fix: align inline workflows with official contract`
- `60a8942` — 2026-07-16 — `fix: ignore empty workflow script paths`
- `ac8dbcc` — 2026-07-16 — `docs: update release readiness changelog`
- `a71396f` — 2026-07-16 — `release: prepare v2.1.200`

### 变更内容

#### Workflow facade 官方契约

- 对齐 official Workflow resolver：允许仅通过 `{ script }` 运行 inline workflow；顶层 `name` 保持 saved workflow selector 语义；输入优先级为 `scriptPath > name > script > plan`。
- official-style inline script 的运行名称和持久化文件名来自脚本内 `meta.name`；`{ name, script }` 先解析 saved workflow，再使用传入脚本覆盖执行内容。
- 修复空字符串 `scriptPath` 错误抢占有效 `name` 或 `script` 的问题，并增加输入归一化和权限预览回归测试。
- 更新模型可见工具说明，明确 `{ script }`、`meta.name`、首条未注释 `export const meta` 和参数优先级。

#### Codex Apps 与发布检查

- 默认启用 OAuth-only Codex Apps 集成，并保留 Apps 状态、偏好设置、MCP transport 和工具投影能力。
- 强化 tmux CLI 验收和类型检查约束；`make release-check` 统一执行 package version guard、TypeScript、ESLint、missing imports/assets audit 和 diff whitespace 检查。

### 测试覆盖

- `make release-check` 通过：`package.json` 保持 `0.0.0-dev`，TypeScript、ESLint、missing imports/assets audit 和 `git diff --check` 均通过。
- Workflow facade、DSL、script parser 和 script runtime focused tests 均通过。
- 最新 `built-claude` binary-side 验收确认：inline `{ script }` Workflow `2/2 agents · 28.8k tok done`；单 Agent `3 tool uses · 27.6k tokens` 完成；`/deep-research` `25/25 agents · 790.2k tok done`；`/code-review` `10/45 agents · 415.6k tok done`，且父 CLI 均恢复交互。
- Workflow stop 的自动化 lifecycle tests 已覆盖 killed notification、SDK `stopped` event 和 abort-aware fan-out；binary-side 验收确认同一 Workflow 从 `running` 转为 `killed`、两个子 Agent 同步停止、主 prompt 恢复交互且 Git 工作区无变化。

## 2026-07-15 - Effort 能力、Workflow 生命周期与 Codex Apps 集成

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.178`。
- 本条目覆盖上次 CHANGELOG 更新提交 `a8961db`（2026-07-13）之后至 2026-07-15 的提交。

### 关联提交

- `388cded` — 2026-07-14 — `fix: harden agent workflows and effort handling`
- `7f2f1b6` — 2026-07-15 — `fix: align effort capabilities and workflow lifecycle`
- `1328492` — 2026-07-15 — `feat: add OAuth-only Codex Apps integration`
- `6c14f86` — 2026-07-15 — `fix: clarify inline workflow script contract`

### 变更内容

#### Provider effort 能力与 wire mapping

- 统一 CLI、SDK schema/runtime/generated types 和请求构造中的 effort 能力表达，保留内部 `ultracode` 编排模式，并按 provider/model 暴露实际支持等级。
- OpenAI compatibility 将 `max` 映射为 `ultra`、将 `ultracode` 映射为 `xhigh`；Anthropic 将 `ultra` 和 `ultracode` 映射为 `max`，并仅为支持的模型保留原生 `xhigh`。
- 修复 `CLAUDE_CODE_EFFORT_LEVEL=unset|auto` 仍可能补发默认 effort 的问题，并补齐 `--effort`、`/effort`、SDK capability 与 provider request 测试。

#### Agent 与 Workflow 生命周期可靠性

- 修复 Agent foreground/background continuation、progress/usage 聚合、summarizer ownership 和 terminal notification 顺序，避免重复消费 stream、重复摘要或 post-processing 失败反转已完成状态。
- failed/killed Agent 的 worktree cleanup 失败改为可见 warning，不再吞掉 terminal notification；completed、failed、killed 路径保留最终 usage。
- Workflow failed 路径补发 XML notification，killed 路径补发 SDK `stopped` event，并使并发 semaphore 感知 abort，停止后不再继续启动排队 Agent。
- 补充 inline Workflow facade 的模型可见脚本契约，明确首条语句必须是未注释的 `export const meta`、phase metadata 格式、`parallel()` thunk 用法以及 official-style 与 legacy DSL 的边界。

#### OAuth-only Codex Apps 集成

- 新增 Codex Apps 管理界面、OAuth 登录与偏好设置，支持 Apps 状态查询、信任确认、tool metadata/normalization、tool-set 管理及 MCP transport 配置。
- 将 Codex Apps 投影到现有 plugin/MCP 管理与 merged tools 数据流，补齐连接状态、启停、重连、工具展示和配置持久化。
- 新增 Apps auth、projection、preferences、status、tool normalization 和 tool-set 测试，覆盖 OAuth-only 边界及 MCP 工具转换行为。

### 测试覆盖

- 已运行 effort、OpenAI compatibility、Agent lifecycle、Workflow facade/DSL/parser/runtime focused tests，均通过；已运行 `bun run lint`、`git diff --check` 和 `make build`。
- 最新 `built-claude` binary-side 验收确认：并发 Agent `2/2` 完成；inline Workflow `2/2 agents · 40.4k tok done`；`/code-review` `8/45 agents · 192.2k tok done`；`/deep-research` `25/25 agents · 960.8k tok done`，且父 CLI 均恢复交互。
- Workflow facade 契约修复后的首次 inline 生成及 binary-side stop 验收因 API connectivity error 未进入调度阶段，不计入通过项；自动化 lifecycle tests 已覆盖 failed/killed notification、`stopped` event 与 abort-aware fan-out。

## 2026-07-13 - Agent 状态可靠性、provider effort 路由与文档整理

### 版本状态

- 非发布变更，未新增版本号；`Makefile` 仍保持 `2.1.178`。
- 本条目汇总 `v2.1.178` 后截至 2026-07-13 的提交，包括 Agent async lifecycle 收束与 tmux CLI 验收规范。

### 关联提交

- `e9f92dd` — 2026-07-09 16:38:19 +08:00 — `version update: v2.1.178`
- `13f7cec` — 2026-07-09 16:43:47 +08:00 — `fix: type error`
- `7a2b301` — 2026-07-10 21:43:56 +08:00 — `docs: plan agent progress count fixes`
- `6c2f287` — 2026-07-11 15:08:37 +08:00 — `update: agent token counts`
- `cebda16` — 2026-07-11 23:47:18 +08:00 — `update: fix bug of plugin uninstalled`
- `566b666` — 2026-07-12 01:55:54 +08:00 — `feat: route effort levels by API provider`
- `a4dcff6` — 2026-07-12 15:14:50 +08:00 — `fix: keep agent and UI state aligned with execution`
- `2ddc97f` — 2026-07-12 15:57:10 +08:00 — `update: fix claude openai effort converts`
- `56b91a6` — 2026-07-12 18:14:49 +08:00 — `update: refactor of documents folder`
- `4419da4` — 2026-07-12 20:35:00 +08:00 — `fix: make phase one state updates reliable`
- `27090b9` — 2026-07-13 — `fix: preserve async agent terminal state`
- `8932622` — 2026-07-13 — `docs: add tmux CLI validation skill`
- `de56c0d` — 2026-07-13 — `test: add tmux validation skill evals`

### 变更内容

#### Agent 进度、usage 与异步生命周期

- 重构 Agent progress tracker 和 token/tool-use 聚合，使 foreground、background、resume、nested agent 与 SDK task progress 使用一致的累计口径，并补齐主会话、Coordinator 和 task detail 的展示数据。
- 修复 foreground 转 background 时的执行与 UI 状态衔接，避免 continuation 重复消费 stream、重复启动 summarizer 或提前停止进度摘要；同一 agent stream 现在只启动一次 summarizer，并由最终 terminal path 负责停止。
- 完善 async agent terminal notification：completed、killed 和 failed 路径携带最终 token、tool-use 与 duration usage，notification 仅在成功入队后标记 `notified`，避免瞬时入队失败永久丢失通知。
- 将 agent 已完成后的 handoff classification、worktree cleanup 等 post-processing 失败降级为可见 warning，不再把已经完成的任务反转为 failed，也不向用户泄露内部 worktree 错误路径。

#### Agent、Workflow 与 UI 状态一致性

- 修复 AgentTool foreground/background continuation、nested depth 与 task state 更新顺序，确保实际执行状态、`LocalAgentTask`、任务列表和 Coordinator 展示保持一致。
- 改进 `TaskUpdateTool` phase-one 状态更新的原子性与失败处理，避免局部更新、retry/skip 残留状态或并发更新覆盖。
- 调整 Workflow detail model、snapshot 和 dialog 状态派生，统一 running、completed、failed、skipped 等状态和最近活动展示。
- 修复插件启停失败时的 UI 回滚与 plugin operation 状态更新，避免卸载或 toggle 失败后界面与实际插件状态分裂。

#### Provider effort 路由

- 将 effort 解析按 API provider 分流：Claude 与 OpenAI compatibility 分别执行各自支持的 effort 转换，补齐 `ultra` 等级在 provider 边界的降级与映射。
- 修复 Claude/OpenAI 请求构造中的 effort conversion，避免 OpenAI 专属值进入 Claude 请求，或在兼容转换中丢失用户选择。
- 同步 SDK schema、runtime types、settings types 与测试，使 provider-specific effort 行为在 CLI、SDK 和持久化配置中保持一致。

#### 文档结构与 CLI 验收规范

- 重组 `docs/` 为 `architecture`、`design`、`guides`、`research`、`archive` 等目录，归档历史 implementation records、plans、specs 和 test plans。
- 更新根 `README.md`、`docs/README.md` 及文档内部链接，补充 Agent progress、UI state 和 provider effort 可靠性设计记录。
- 新增 `tmux-cli-workflow-validation` project skill，明确 Agent、Workflow、slash command 与 TUI 必须通过最新 `built-claude`、脚本驱动 tmux、pane/debug log 和独立证据目录完成 binary-side 验收，禁止用 parent-side 同名工具替代证据。

### 测试覆盖

- 新增或更新 `LocalAgentTask.progress.test.ts`、`AgentTool.nesting.test.ts`、`foregroundProgressUpdate.test.ts`、`foregroundBackgroundContinuation.test.ts` 和 `asyncLifecycleOrdering.test.ts`，覆盖进度累计、nested agent、foreground/background handoff、summarizer 生命周期、terminal usage 与 post-processing warning。
- 新增或更新 `TaskUpdateTool.test.ts`、`LocalWorkflowTask.test.ts`、workflow detail snapshot 测试和 Coordinator status 测试，覆盖任务状态原子更新及 UI 派生一致性。
- 新增 `ManagePlugins.toggleFailure.test.tsx`、`pluginOperations.test.ts`，覆盖插件操作失败与 UI 回滚。
- 更新 `claude-effort.test.ts`、`openai-compat.test.ts` 及 effort 相关 schema/type 测试，覆盖 provider-specific effort 转换。
- 新增 `tmux-cli-workflow-validation/evals/evals.json`，覆盖 binary-side 证据边界、并行 slash command 验收和 Workflow→Agent→notification 链路。
- 已运行 `bun test src/tools/AgentTool/asyncLifecycleOrdering.test.ts src/tools/AgentTool/foregroundBackgroundContinuation.test.ts`，两个测试脚本均通过。
- 已运行 `bun run lint`、`git diff --cached --check` 和 `make build`，均通过；构建产物为 `./built-claude`。

## 2026-07-09 - v2.1.178 - Workflow official parity、OpenAI 兼容与发布准备

### 版本状态

- 准备发布版本：`v2.1.178`。
- 当前分支：`workflow-enhancement`。
- 本次发布覆盖 `v2.1.177` 后的提交：`6bee16b`、`0bca872`、`c4b9f7a`、`899769a`、`b5894b0`、`8f8cd56`、`359c7ec`、`0d0866a`、`9d60555`、`d44e93e`、`67640a2`、`c4daef4`、`69358a1`、`fbea91d`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。
- `Makefile` 默认构建版本更新为 `2.1.178`。

### 关联提交

- `6bee16b` — 2026-07-06 01:40:05 +08:00 — `update: add agent no isolation and openai fix`
- `0bca872` — 2026-07-06 20:56:59 +08:00 — `update: improve workflow ultracode UX`
- `c4b9f7a` — 2026-07-07 00:41:43 +08:00 — `update: no pr Claude Code co Author`
- `899769a` — 2026-07-07 09:59:25 +08:00 — `update: align workflow runtime parity`
- `b5894b0` — 2026-07-07 14:38:23 +08:00 — `update workflow runtime resume parity`
- `8f8cd56` — 2026-07-07 16:06:13 +08:00 — `fix: align bundled workflow resume prompts`
- `359c7ec` — 2026-07-07 19:22:25 +08:00 — `fix: resume named workflow plans`
- `0d0866a` — 2026-07-07 20:54:12 +08:00 — `fix: print workflow completion output`
- `9d60555` — 2026-07-08 23:04:30 +08:00 — `update: official workflow impl`
- `d44e93e` — 2026-07-09 01:14:38 +08:00 — `fix: align workflow runtime parity`
- `67640a2` — 2026-07-09 01:17:36 +08:00 — `docs: update changelog since v2.1.177`
- `c4daef4` — 2026-07-09 12:27:02 +08:00 — `fix: keep workflow skip state consistent`
- `69358a1` — 2026-07-09 13:12:21 +08:00 — `docs: design workflow script meta parser parity`
- `fbea91d` — 2026-07-09 13:20:35 +08:00 — `fix: align workflow script meta parser`

### 变更内容

#### OpenAI compatibility 与 Agent/attribution 行为

- 修复 OpenAI compatibility 路径，补充 OpenAI compat 测试覆盖，确保相关请求/兼容处理在 OpenAI provider 下保持正确行为。
- 调整 AgentTool prompt/schema 中 isolation 相关提示，明确不需要隔离时不要传 `isolation`，避免 named agent / teammate routing 被错误导向 worktree subagent。
- 调整 attribution 设置字段与测试，移除 PR 场景中的 Claude Code co-author 相关默认表述。

#### Workflow ultracode UX 与任务状态展示

- 新增 workflow ultracode UX 改进计划文档，并更新既有 ultracode orchestration UX design。
- 改进 prompt input / ultracode orchestration 提示与消息处理，使 workflow/orchestration 模式的执行边界和用户提示更明确。
- 扩展 `LocalWorkflowTask` 与 workflow status formatting，展示 live agent、running/skipped/failed/completed 统计、recent activities 与 concurrency blocked 信息。
- 更新 WorkflowTool / WorkflowFacadeTool 相关测试和行为，配合 ultracode workflow UX 与 task detail 展示。
- 调整 OpenAI compatibility 测试与 ultracode orchestration 测试，覆盖 workflow/ultracode 的 prompt 和 routing 行为。

#### Workflow runtime resume parity

- 新增 workflow runtime parity 设计、规格与测试计划文档，明确 workflow resume cache、journal、session state、task list UI 与 binary-side 行为目标。
- 扩展 `LocalWorkflowTask` 状态模型，记录 workflow run id、script path、run args、events、results、agent controllers、live agent progress、pause/kill/resume 相关状态。
- 引入 workflow journal、resume cache、run sessions 与 feature flags，支持 completed agent 结果恢复、session 进度持久化、paused/killed/imported run 状态读取。
- 扩展 `WorkflowTool` / `WorkflowFacadeTool` 的 run/status/pause/resume 路径，支持 resumeFromRunId、named workflow resume prompt 与 bundled workflow resume prompt。
- 改进 declarative 和 script workflow runtime：记录 agent progress、completion output file、SDK task progress/terminated event、workflow notification，并在 foreground/background 执行路径保持一致。
- 修复 named/bundled workflow pause 后 resume prompt 格式，使 `/workflows` 和 task detail 中展示的恢复调用可直接复用。
- 修复 workflow completion output 打印与 notification，确保完成后输出文件和 inline notification 中包含 workflow result 摘要。
- 调整 WorkflowDetailDialog snapshot、formatWorkflowStatus、task list summary 等 UI 展示，使 running/paused/completed/failed/skipped 状态和 recent activities 更清晰。

#### Workflow official parity 收束

- 新增 official workflow parity 修复计划，整理 workflow script VM、agent resume cache、journal recovery、skip/retry、session persistence、task notification 与 official run import 的兼容修复路径。
- 对齐 workflow script VM 注入方式，使用 null-prototype sandbox 与 `codeGeneration` 限制，并通过显式 global 注入提供 `agent`、`parallel`、`pipeline`、`workflow`、`phase`、`log`、`budget` 和 `args`。
- 引入 script agent chain identity 与 ordered journal cursor，避免重复相同 prompt 或插入新 agent 后错误复用旧缓存。
- 增强 workflow journal JSONL 容错读取，跳过 malformed line，同时保留可恢复的 completed result。
- 对齐 workflow agent skip/retry abort reason，新增 `user-retry` / `user-skip` 常量与脚本 runtime retry/skip 行为。
- 完善 workflow run session persistence、`resumeFromRunId` 传递、official paused/killed 状态导入和 task notification XML escaping/truncation。
- 对齐 declarative workflow plan runtime 的 `user-skip` 行为：用户 skip agent 时不再将 phase/workflow 误判为失败，而是记录 `skipped` result 并允许 workflow 正常完成。
- 修复 `LocalWorkflowTask` skipped/retry 状态记录：`skipWorkflowAgent()` 现在按 logical index 清理旧 failed/result 状态并同步写入 task-level `results`，避免 UI/session 只在 phase 内看到 skipped 状态或 retry 后残留 failed 状态。
- 强化 workflow script VM：main/child official-script runtime 均禁用 string 和 WebAssembly code generation，并在 child runtime 中显式阻断 `eval` / `Function`。
- 强化 workflow script dry-run loader：official-script loader 同步禁用 string/wasm codegen 和 `eval` / `Function`，避免 child workflow 在加载阶段绕过运行时 VM 限制。
- 修复 script result 完成顺序：先序列化/校验 workflow script 返回值，再标记 task/session completed，避免 `BigInt` 等不可序列化结果导致 task completed 但 session failed 的状态分裂。
- 新增 workflow script meta parser 官方兼容性设计与实现计划，明确以 Claude Code `2.1.201` recovered parser 行为为对齐目标。
- 重写 workflow script `meta` 提取逻辑：改为 full-script Acorn module parse，要求首个 AST statement 为 `export const meta = { ... }`，并从完整 export declaration 之后截取 `scriptBody`。
- 对齐官方 `meta` literal 提取与 normalization 规则：仅允许纯 literal AST，拒绝 computed key、spread、sparse array、method/accessor、template interpolation、unary plus 与 reserved keys；`phases` 改为官方 loose filtering，非数组或无效条目会被忽略。

### 测试覆盖

- 新增/更新 `src/services/api/openai-compat.test.ts`，覆盖 OpenAI compatibility 修复。
- 新增/更新 `formatWorkflowStatus.test.ts`、`WorkflowFacadeTool.test.ts`、`WorkflowTool.test.ts`、`workflowScriptRuntime.test.ts`、`ultracodeOrchestration.test.ts`、`attribution.test.ts`、`workflowJournal.test.ts`、`workflowRunSessions.test.ts`、`workflowFeatureFlags.test.ts`、`runWorkflow.test.ts`、`LocalWorkflowTask.test.ts`、`src/tools/WorkflowTool/workflowScriptParser.test.ts` 等 workflow / OpenAI / AgentTool 相关测试。
- `workflowScriptParser.test.ts` 覆盖 official-style first statement 限制、pure literal 规则、scriptBody 截取、top-level await/return 与 loose `phases` normalization。
- `runWorkflow.test.ts` 覆盖 plan runtime `user-skip` 应完成 workflow 并记录 skipped result，以及 failed retry 后 user-skip 不残留 failed 状态。
- `workflowScriptRuntime.test.ts` 覆盖 child workflow VM codegen 限制与不可序列化 script result 的 failed 状态一致性。
- 已运行 focused AgentTool suite、`bun run lint`、`git diff --check`、`make build`，并完成 `built-claude` binary-side TeamCreate / Agent / SendMessage coordination smoke。
- 已运行 `bun test src/tools/WorkflowTool/runWorkflow.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowScriptRuntime.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowScriptParser.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool/workflowDsl.test.ts src/tools/WorkflowTool/workflowScriptRuntime.test.ts src/tools/WorkflowTool/WorkflowTool.test.ts`。
- 已运行 `bun test src/tools/WorkflowTool`，结果 `0 fail`。
- 已运行 `bun test src/tools/WorkflowTool src/tasks/LocalWorkflowTask`，结果 `35 pass, 0 fail`。
- 已运行 `bun test src --isolate --path-ignore-patterns 'dist/**'`，结果 `140 pass, 0 fail`。
- 已运行 `make build` 生成 `./built-claude`，并完成 binary-side 交互验证：`deep-research` 完整完成 `25/25 agents`，`code-review` 在 clean diff 下正常完成并返回 `No changes found to review`。

## 2026-07-05 - v2.1.177 - AgentTool recover parity、goal 恢复与调试能力补齐

### 版本状态

- 准备发布版本：`v2.1.177`。
- 本次发布覆盖 `v2.1.176` 后的提交：`9103c69`、`004684c`、`25a2a25`、`8db03fa`、`d0fd6cf`、`fe737f3`、`0870f3d`、`f278a93`、`14424d7`、`909a5aa`、`af2bd7b`、`e2e22e0`、`4582129`、`1dfa5e3`、`f2b524e`、`ffd28d9`、`e37edc7`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `9103c69` — 2026-07-04 17:03:24 +08:00 — `update: CN claude debug skill`
- `004684c` — 2026-07-04 17:22:55 +08:00 — `update: add feature testing reference`
- `25a2a25` — 2026-07-04 17:23:13 +08:00 — `update: add goal auto-clear support`
- `8db03fa` — 2026-07-04 17:52:56 +08:00 — `update: goal clear problem with prompt  as stop hook type`
- `d0fd6cf` — 2026-07-04 21:13:41 +08:00 — `docs: add agent upgrade design spec`
- `fe737f3` — 2026-07-04 21:31:41 +08:00 — `docs: add agent upgrade integrity gates`
- `0870f3d` — 2026-07-05 01:58:21 +08:00 — `update: cc recovered in 2.1.201`
- `f278a93` — 2026-07-05 13:12:43 +08:00 — `update: Agent tool plans`
- `14424d7` — 2026-07-05 13:45:28 +08:00 — `update: run Agents tools`
- `909a5aa` — 2026-07-05 14:17:18 +08:00 — `update: wrong run teammate mode`
- `af2bd7b` — 2026-07-05 16:38:39 +08:00 — `update: download official`
- `e2e22e0` — 2026-07-05 18:08:16 +08:00 — `update: appState with team`
- `4582129` — 2026-07-05 20:23:15 +08:00 — `update: add spec ultra code`
- `1dfa5e3` — 2026-07-05 22:02:05 +08:00 — `update: more clear spwan`
- `f2b524e` — 2026-07-05 22:20:21 +08:00 — `update: agent tool prompt`
- `ffd28d9` — 2026-07-05 22:40:33 +08:00 — `update: broderTitle uiName change to customed`
- `e37edc7` — 2026-07-05 23:15:56 +08:00 — `update: add uiname test`

### 变更内容

- 补充 Claude 调试技能中文流程与 feature testing 参考，明确 assistant-side / binary-side 分层、交互式验证、非交互式验证和代理流量调试证据要求。
- 新增 `/goal` 自动清理和 compact/session restore 相关恢复逻辑，确保 goal 状态、StopHook 和 slash command 结果在会话压缩、恢复与清理路径中保持一致。
- 引入 Claude Code `2.1.201` recover 产物作为 AgentTool 对齐参考，并补充 Agent upgrade design spec、integrity gates、recover parity 和 runAgent 参数生命周期计划文档。
- 重构 AgentTool agent type 解析、MCP 可用性检查、async lifecycle ordering 和 launch params 处理，补齐相关单元测试，降低 prompt/schema/工具状态变化对 Agent 启动路径的影响。
- 对齐 recover 201 的 AgentTool -> runAgent 参数消费：保留 `name`、`toolUseId`、`spawnDepth` 等 metadata，整理 `mode`/permission 语义、async progress payload 和 debug launch 参数。
- 整理 TeamCreate / Agent / SendMessage 协作路径：区分当前 caller 是否为 teammate 与当前 Agent 调用是否应 spawn teammate，补齐 in-process teammate background 限制和 missing team file 预检。
- 调整 AgentTool prompt/schema 中 `name`、`team_name`、`isolation` 描述，贴近 recover 201 行为，并明确 `isolation: "worktree"` 与 teammate spawn routing 的分支关系。
- 更新 AppState team context、process slash command/session restore 相关链路，为 team context 与 goal restore 协同提供状态承载。
- 调整 LogoV2 `uiName` / border title 展示，并新增 `uiName` 测试覆盖。
- 更新 `Makefile` 默认构建版本到 `2.1.177`。

### 测试覆盖

- 新增或更新 `src/commands/goal.test.ts`，覆盖 goal 自动清理、StopHook 和恢复路径。
- 新增或更新 `src/tools/AgentTool/agentTypeResolver.test.ts`、`agentLaunchParams.test.ts`、`agentProgressPayload.test.ts`、`asyncLifecycleOrdering.test.ts`、`mcpAvailability.test.ts` 和 `AgentTool.nesting.test.ts`，覆盖 AgentTool recover parity、metadata、MCP 可用性、async 生命周期和 teammate 限制。
- 新增 `src/tools/shared/spawnMultiAgent.test.ts`，覆盖 missing team file 在副作用前失败的路径。
- 新增 `src/components/LogoV2/uiName.test.ts`，覆盖自定义 UI 名称展示。
- 已运行 focused AgentTool suite、`bun run lint`、`git diff --check`、`make build`，并完成 `built-claude` binary-side TeamCreate / Agent / SendMessage coordination smoke；binary-side 验证确认当前 named Agent 若带 `isolation:\"worktree\"` 会按 recover 201 语义走普通 worktree subagent 分支而非 teammate spawn。

## 2026-07-02 - v2.1.176 - OpenAI auth 环境变量、发布构建与 npm 包装

### 版本状态

- 准备发布版本：`v2.1.176`。
- 本次发布覆盖 `v2.1.175` 后的提交：`b1203ec`、`f2950bd`、`3731b11`、`7ef23b5`、`bc613db`、`430ff83`、`ce0ac0b`、`33ab36c`、`05ee2e9`、`74525a6`、`93de121`。
- `package.json` 仍保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

### 关联提交

- `b1203ec` — 2026-06-30 12:44:13 +08:00 — `fix: serialize release workflow runs`
- `f2950bd` — 2026-06-30 12:48:12 +08:00 — `Revert "fix: serialize release workflow runs"`
- `3731b11` — 2026-06-30 18:09:19 +08:00 — `update: add create team agent restriction in prompt`
- `7ef23b5` — 2026-06-30 19:46:47 +08:00 — `Revert "update: add create team agent restriction in prompt"`
- `bc613db` — 2026-06-30 23:48:07 +08:00 — `update: remove bun build cache`
- `430ff83` — 2026-07-01 02:02:40 +08:00 — `update: production build`
- `ce0ac0b` — 2026-07-01 16:34:45 +08:00 — `update: test with 666 version`
- `33ab36c` — 2026-07-01 17:20:51 +08:00 — `update: update upstream as @esonhugh/claude-code`
- `05ee2e9` — 2026-07-01 18:11:51 +08:00 — `update: native to npm download`
- `74525a6` — 2026-07-02 00:45:12 +08:00 — `update: add reset button and status line with Openai account`
- `93de121` — 2026-07-02 01:13:34 +08:00 — `update: multi alias about openai api keys`

### 变更内容

- 调整 release workflow：在 tag 发布时执行 source checks、创建 GitHub Release、跨平台构建 binary、上传 release artifact、生成校验和，并准备/发布 binary-only npm package。
- 移除发布流程中的 Bun build cache 依赖，避免缓存状态影响 release 构建可复现性。
- 保持源码 `package.json` 版本为 `0.0.0-dev`，发布版本由 `v2.1.176` tag 注入到 `CLAUDE_CODE_VERSION`。
- 更新包名与 npm 下载链路为 `@esonhugh/claude-code`，并沿用 release workflow 生成平台包与主 launcher 包。
- 增加 OpenAI account status line 信息与 reset 按钮相关 UI 支持，便于查看和重置 OpenAI 登录状态。
- 调整 OpenAI auth 环境变量读取：`OPENAI_AUTH_TOKEN` 作为 auth token 入口，`OPENAI_API_KEY` 可覆盖 `~/.codex/auth.json` 中的 API key，随后再回退到本地 Codex 风格 auth 文件或 ChatGPT OAuth tokens。

### 测试覆盖

- 已运行 `bun src/utils/openai-auth-env.test.ts`，覆盖 `OPENAI_AUTH_TOKEN` 与 `OPENAI_API_KEY` 环境变量优先级。
- 已运行 `bun src/interactiveHelpers.openai-auth.test.ts`、`bun src/services/openai-oauth/refresh.test.ts`、`bun src/services/api/openai-refresh-client.test.ts`、`bun src/services/openai-oauth/storage.test.ts`、`bun src/services/api/openai-missing-auth.test.ts`，覆盖 OpenAI 自动登录、refresh、存储和缺失凭证提示路径。
- 发布前按 `.github/workflows/release.yml` 本地执行 source checks 与当前平台 build/package 验证。

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
- 新增 `claude-debug` skill，将 tmux/InteractiveTerminal、`--print`、`--debug-file`、HTTP_PROXY/HTTPS_PROXY、SSE/WebSocket、透明代理与 MITM/CCH 请求调试流程从 `claude-analysis` 中拆出，明确源码/二进制分析与运行时调试的边界。
- 调整 `buildFetch` 请求处理，使 CCH patch 与 `x-client-request-id` 注入都仅在 first-party provider 路径启用；OpenAI、Bedrock、Vertex、Foundry 等 provider 不发送或修改相关 first-party 请求信息。

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

### 版本状态

- 发布版本：`v2.1.172`。
- `package.json` 保持 `0.0.0-dev`；发布产物版本由 tag/构建流程注入。

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

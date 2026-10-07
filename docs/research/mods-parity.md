当前增量（2026-10-08）：[远程滚动专项](mods-remote-scroll-292-20261008.md) 接通 SDK ui_scroll、无终端作者滚动和 system/ui_scroll；18 类客户端控制中 15 类接通。剩余 ui_focus、ui_prompt_edit、ui_prompt_autocomplete、五类 responder、浏览器 Client 和完整 UI/diff/G5 仍未整体验收。下文有日期的状态属于对应批次，不替代本次验收边界。

# Mods 完整兼容清单

本清单用于持续完成官方 Mods 对齐，当前尚未完成。它与 [mods-test.md](../../mods-test.md) 的逐轮证据一起维护；旧 [claude-mods.md](claude-mods.md) 保留当时的研究结论。

## 2026-10-07 当前复核

- 当前官方对照版本为 **2.1.292**，本地构建版本仍为 **2.1.280（未发布）**。下文的 287/289/290 基线、逐批数字和待办是历史快照，不能覆盖后续专项结论；本次完整范围见[实现审查](mods-implementation-audit-20261007.md)。
- 作者完整声明、内置 diff 原件、模型 complete/classify/fork、原生消息绘制、Agent 路由及远程 UI 已有 292 专项。类型、专项通过和完整生产兼容分别判断，不将旧 C16 成本恢复待办或 U06 全部未挂载的表述直接当作当前状态。
- 当前远程 UI 接通 14/18 类客户端控制。新增 ui_panes、ui_pane_show、ui_pane_focus、ui_close、无终端 Pane 登记与 system/ui_panes 推送，官方 2.1.292 和本批候选的原生回执、观察和推送匹配；工作区与终端相邻流程结果见 [Pane 控制专项](mods-pane-controls-292-20261007.md)。仍开放 ui_prompt_edit、ui_prompt_autocomplete、ui_scroll、ui_focus，五类 responder、其他 system 推送和浏览器 Client 执行生命周期。
- 本次所选七个生命周期/远程 UI 文件为 232 pass / 1 skip / 0 fail；host hooks 文件在干净 `005fae9` 与工作区均为 25 pass / 1 fail，失败是嵌套 stream 取消未保留专用原因。完整官方 API/UI/diff/G5 与全量 WIP 门禁仍未完成。

## 历史清单与逐批记录

目标覆盖函数暴露、类型、参数和回执、上下文、生命周期、作者工具，以及 UI 的布局、交互、焦点、滚动和持久化。用户明确要求保留的 Privacy Mode 等改动属于例外；既有本地差异和 README 的未实现列表不能自动成为豁免。

2026-10-05追加的必要目标：官方 Mods 应能在本运行时直接实现对应的 diff viewer，展示效果、行为与操作流程均与官方一致。检查官方对应模块及调用链，建立函数与定义的对应关系；日志措辞可不同，但来源、事件、状态、失败和生命周期等关键信息须准确。原生 `/diff` smoke 或 Pane 能打开不能替代官方 diff Mod 的真实入口验收。

## 对照来源

- 实测和静态制品基线：官方 Claude Code **2.1.287**，SHA256 `6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea`。完整生成声明 SHA256 `850955da76fbae9d8d546c091fa350dbf6968c661e4f22e45368629cc28380fb`。
- 最新对齐目标：2026-10-05重新核实官方 npm `latest` 为 **2.1.289**。官方 darwin-arm64 发布包的 SHA1 与 SHA512 integrity 已核对；binary SHA256 `03d66745e3bb69ec727d66023696f3820bc0a00a8a5ba725eb6706d0c67cbe69`。静态解包2414个模块、135个zstd内容；内嵌声明586065 bytes，SHA256 `791464683ba02b5905d477fdb2fe9a81a5110c937bc28bae21414657d53a9894`。原件与逐模块来源保存在 `/private/tmp/mods-align-m1scugg4/official-current-20261005/`，尚未把静态提取当作新版运行时通过。
- 在线 [Mods API reference](https://code.claude.com/docs/en/plugins/mods/reference) 于2026-10-05复核明示 **2.1.289**；以安装版本内嵌/生成的声明为权威，GitHub副本可能较旧。[官方更新记录](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) 将 `ui.selection` 列为288新增；287→289声明还新增 `ui.fault`、精确Agent状态和teammate字段。历史287证据继续保留，不能直接升级为289结论。
- 2026-10-06再次核实：[官方 npm latest](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) 与 [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) 均为 **2.1.290**。上述289为本轮固定且实际运行的历史基线，不再称为当前最新。290新增 `turn.step.serverToolUses`、`tool.check.agentId/ceiling`、`ThemeKey/Color` 和 gatingHooks验证输出，并修复worker catch/卸载等流程；新制品/声明/原样diff尚未逐项对照，继续列为必要目标。
- [官方示例](https://github.com/anthropics/claude-code/tree/main/mods) 用于作者用法；代码生成声明和真实 CLI 行为仍需分别验证。
- 本地候选版本保持 **2.1.280**。版本名、方法名和通过几份官方示例均不代表完整兼容。

检查必须区分：声明存在、最小失败回归、源码通过、当前编译制品真实入口通过、同操作官方对照通过。对于 UI，还必须检查逐帧 logical/physical output；最终 pane 文本不能替代。

## 公开方法

官方287核心清单含80个成员，其中 `plugin.name/root` 是身份属性；原12项不包含条件扩展的telemetry。按固定289制品核对，`ui.panes` 与 terminal `ui.copy` 已接通，仍缺以下12个公开方法；远端复制协议另列为未完成入口：

| 命名空间 | 待实现方法 | 必须一起接通的入口 |
| --- | --- | --- |
| ui | notice、ask | 生产通知、问答及相应middleware；已有copy仍需远端clipboard responder协议 |
| audio | play、speak | 实际支持的播放/语音能力、不可用回执、取消和清理 |
| mcp | connect | manifest所属server、实际连接状态、取消及错误 |
| session | compact、send、append | 手动/自动压缩、实际通信、transcript写入前的行处理 |
| command | run | 原生和注册命令调度、参数及最终回执 |
| process | spawn | stream、背压、退出、取消和进程清理 |
| telemetry | log、mark | collector和事件的精确契约；保留Privacy Mode禁止外送的要求 |

`session.compact`、`command.run` 的事件或测试驱动器已存在，也不能代替插件公共方法。其余方法的名称虽然存在，参数、结果和生产调用链仍需完整核对。

## 参数、上下文和生产链

| ID | 已确认差异或待核项 | 当前修复状态 / 验收要求 |
| --- | --- | --- |
| C01 | `session.usage.startedAt` 必需number；官方cost-state.startTime与project.lastStartTime恢复链 | build10实际fresh/resume/continue/clear/branch及cost-state通过；同案project恢复顺序failed已收敛为red并私下修复，待新制品验证；旧optional候选不用。未知历史启动时间按官方活动时钟回退，不能伪称精确历史时间 |
| C02 | `plugin.register.uses` 遗漏已扫描的state reads/writes | red0/2→完整runtime92/0/1skip；已迁入，待真实policy加载前拒绝 |
| C03 | `fs.list` 缺少必需mtimeMs | private red0/6→234相邻通过；源码已补齐mtimeMs，真实制品入口待验证：file同次stat的size/time，dir/link/other为0，不跟随link |
| C04 | `process.run` 缺少isStdoutTruncated/isStderrTruncated | private red0/6→234相邻通过；两pipe独立4MiB标志源码已补，真实制品入口待验证；恰好限值false、超出true、截断多字节字符及真实退出 |
| C05 | `prompt.submit` 的asUser、准入、来历与队列结算 | private源码400/0/3skip；已补asUser/frame、raw receipt、synthetic/drop、附件隔离、UUID与顶层origin。待新制品真实Button/wire/transcript；内部caller history已接入三种队列及真实准入源码，含独立history与公开伪造负例；同源headless batch合并与earlier UUID仍需最新289真实验证 |
| C06 | `prompt.edit` 未注册/触发 | 52路径组合批已CAS迁入ROOT：官方289 DTO/50ms/UTF-16、普通与Vim真实输入producer、同read语义key同步flush、batch/rebase、7种装饰/六主题、live handle与Unicode fill/readback、无guest确认卸载均有源码TDD。官方testing不公开prompt.edit方便方法。初次完整36入口2754pass/11旧skip/3fail保留；两个旧fixture修正后，完整复验2758/11旧skip/0（快照95eb9…），实际Worker普通合批等待失败未复现但根因未确认。之后仅更完整的通知测试回执断言变化，focused132/0、types/lint0（快照b93fa…），生产代码未变；两快照分别记录。新binary/双端native与物理帧未验，不称完整兼容 |
| C07 | `agent.register` 删除permissionMode/hooks/mcpServers、omitClaudeMd未传递、name约束不足 | 待修复：按官方及managed策略处理，不能静默删参数；真实Agent请求核验 |
| C08 | classic声明缺6个事件，多数事件缺生产Mods桥 | 待修复：33个官方事件逐个核对真实触发，原生settings hook和Mods的顺序、结果、阻止与context融合 |
| C09 | 作者测试on过早冻结，缺Registration.catch | 10路径 first-call/catch 批已迁ROOT：普通await/属性读取不冻结，stream首次next才load；kit catch先收集、正式replay才验证，成功body不因单独diagnostic变failed。ROOT聚焦311pass/3原skip/0fail；后续三成员精确testing类型与Worker批迁入后，ROOT完整相关集合2568pass/11原skip/0fail、tsc/lint通过。严格生成类型已验证；完整kit事件映射、CPU相关全部等待类别与native仍待验 |
| C10 | On/Next/EventOf/ResultOf、matcher收窄及surface类型不完整 | ROOT显式映射33个已有事件（含prompt.edit）、testing31个；已补六类会话生命周期及具名context breakdown。各批严格正负比较与实际ROOT检查分别保留；完整50个已有event精确maps、session.append/send、telemetry、matcher和surface类型仍待补齐，不能以测试Proxy或事件驱动器代替生产方法。最新完整source结果及原TS6200报告时间边界见improvment.md当前复核区 |
| C11 | headless ui.open拒绝，官方声明描述-p全部放置 | 静态差异已确认；同一插件在两侧-p实际对照后修复 |
| C12 | telemetry核心、生产事件和wildcard选择不一致 | 待核对并修复API/collector/origin；Privacy Mode的禁止外送须保留 |
| C13 | 命名handler及嵌套tool.call的agent上下文 | 待同操作官方实测，不能仅凭静态推断改行为 |
| C14 | engine.create/provider/consumer闭包与generation | 内部immutable caller history已接值/流dispatch及队列，最后来源按实际tier投影；clock live/expired registration、已启动宿主调用与continuation分离、settle后台追踪及独立engine重绘边界已修复源码。session/agent/turn、完整flush排除与真实制品继续核对，不以源码通过推断全部正确 |
| C15 | 持久fork冻结快照与saved API消息不同 | build-9-r2整案failed保留：live多2个运行时system-reminder；官方oracle未核实，不删除真实上下文或弱化比较 |
| C16 | 官方JSONL成本checkpoint | 本批只读取启动epoch；完整cost totals和checkpoint恢复未据此宣称已实现 |
| C17 | 官方288/289类型和行为增量 | 已迁入 AgentSpec、七态 AgentStatus/AgentInfo、精确 Agent/tool.check hook 和固定父身份保护；actual AgentTool 回执、teammate 构造来源及已有 task 状态/permission 字段有组合源码验证。公开 config.list 来源与独立描述计算已修复。默认 logical ID 生成、registry、实际运行循环和启动回执、活跃消息路由与邮箱失败回执已有 ROOT 源码验证；停止/evicted 后 SendMessage 专用恢复已迁ROOT，保留logical ID/历史UUID链并重验定义与权限；完整历史清洗/hydration、held/finalizing/keepalive 和 classifier/floor carry 仍未完整闭合；ui.selection 基础API、实际 painted-scroll/虚拟行列/边界 scope/输入流程和真实 Worker 已迁ROOT；ui.fault 的七个固定字段、自身通知、一次自动重绘、detached rejection 与实际 watchdog phase 已接线。严格作者类型已有检查，完整624定义、softWrap范围编码、历史卸载身份及终端故障缓存/返回值观察仍待补。全套当前制品/官方 native 未验收，不以消费字段或仅声明认定完整兼容 |
| C18 | plugin validate 注册诊断丢 matcher / helper 来源 | 已迁入独立validation metadata，按注册顺序、regex/list/嵌套、本地primitive const、helper去重排序和direct suppress输出；三原样示例与官方289 native捕获notes匹配。aggregate const sealing、导入helper准入差异、render overlap警告与完整compiled CLI输出仍待核对 |

| C19 | Hooks Worker心跳与取消请求混合、CPU归因及恢复 | r4至r8源码批已迁ROOT：1000ms ping/5000ms未响应、七槽stack/resumed可信归因、abort仅结算所属请求、未知第三次关闭、knownArgs与engine.create声明拒绝门、replacement失败旧代退役及日志来源；Worker公共custom有10s调用方wait拒绝/晚答案忽略，普通hook与engine.create不共用此期限。组合初次完整36入口2754/11旧skip/3fail保留；fixture修正后完整2758/11旧skip/0，后续单个测试类型断言修正再获focused132/0及types/lint0，两个源码快照分别记录。原Worker等待失败根因未确认，不沿用r4的2568/11/0。官方JS也共享Worker；严格b0t的begun/processed marks、完整相邻same-hop合批、所有pending debts与真实nativeHost仍缺。旧1s卸载红保留，修正后有源码TDD；单唯一pending停heartbeat的官方边界、native与physical仍未闭合 |

## UI 对齐

| ID | 差异 | 当前修复状态 / 必需对照 |
| --- | --- | --- |
| U01 | 人工关闭Pane后仍保留asked自动显示资格 | red2fail→完整UI82/0；只在实际person关闭后撤销，拒绝/plugin关闭保留。已迁入，待真实120→143→144列测试 |
| U02 | Button.onPress丢掉最终ui.press参数；variant/role拒绝 | private已修复事件转发、四surface构造验证、strict公共类型、primary suggestion/secondary/plain及hover覆盖；新制品及同操作官方对照待验证。dismiss只是绘制提示 |
| U03 | 跨插件绘制焦点使用Pane owner及裸key | 待修复：以实际绘制plugin和element配对，重复key不能合并，不能误拒外层插件绘制的控件 |
| U04 | AbovePrompt尺寸使用整屏，缺折叠和more提示 | 待修复：底部槽预算、dock下transcript列宽、narrow/fullscreen、增长及折叠逐帧验证 |
| U05 | AbovePrompt焦点/滚动绕过统一事件；blit绕过ui.blit | 待修复：真实键盘及插件调用进入相同middleware，拒绝和rewrite生效 |
| U06 | 多个ui.render组件只有测试mount，没有生产挂载 | 待接线：用户/助手消息、tool各状态、command output、spinner、duration、notice、session mode和prompt hint等13种真实消费者 |
| U07 | Pane asked/dimensions没有完整持久化和resize交互 | 待修复：退出重启、person dismiss、插件更新、resize与布局，不将U01单测当全部通过 |
| U08 | 官方AbovePrompt/Pane/Field输入上下文与按键缺失 | 待修复：官方Ctrl+x组合键、焦点转移、字符/导航/Enter/Escape/wheel/paste唯一owner |
| U09 | fullscreen toast布局、点击/hover和holdToasts排队不同 | 待修复：真实右上堆叠、关闭/过期/恢复，不丢被暂时遮住的通知 |
| U10 | scroll to:end不跟随后续新增内容 | 待修复：内容增长跟随；person滚动打断；resize、close/reopen及异步publish |
| U11 | desktop Client可解析，但后续validator拒绝 | 待核对实际支持的surface和真实消费者后修复，不能只测构造器 |
| U12 | 官方diff Mod与原生/dock UI接管、效果和操作流程 | 已迁入真实builtin/inline身份与live activation接管，canonical/alias、准入拒绝、Worker death、卸载及原生异步轮询fence有源码回归；原样289 diff首编辑/自动打开在真实Worker源码测试执行。普通manifest不能mint身份。生产 diff 已使用 verified289 独立归档，catalog/startup、availability gate、native Fr偏好恢复和实际资源打包控制已有源码验证；新制品 same-input/physical 尚未验收；不以源码接管通过认定效果一致 |
| U13 | /conversation个别Pane输出空白 | build-9-r2 r3/r4的空白pane及正确JSONL保留；需要相同输入、绘制帧和官方对照，暂不定为产品根因 |
| U14 | Image fallback仍报告blit成功、remote bridge缺link.press | 待修复：实际媒体支持/alt fallback/rectangle ownership与远端链接输入，不以validate成功证明呈现成功 |
| U15 | reload不保留open panes、无效constructor输入有静默接受 | 待修复：官方reload生命周期及严格作者错误；不扩张一次close回归范围 |
| U16 | 已入场Pane缩窄再次隐藏；默认dock/body预算错误 | build10官方同序列在144→120保持显示，bodyColumns120=49/144=63；本地旧整案pass基于错误oracle。已保留首次分歧、补sticky/default/requested红回归并修源码及REPL grip；新制品逐帧和官方同序列待验证。U07的chosen及持久化仍未实现 |
| U17 | Pane正文高度、全宽composer、自然内容、边框与关闭mark | 已迁入289增量：无边框outer与bordered inner、独立absolute top0/right inline2或dock1的close、dock始终1行chrome；私有最小red0/2→338相邻源码测试通过，TypeScript/lint通过，待新制品及289同操作physical。287历史判据保持原结论。chosen/kept room、grip drag/lit/tail仍待完成 |
| U18 | 选区在 wheel/page/drag 重复位移、离屏清空及相邻 scope 越界 | 15路径 follow 批已迁ROOT，私有实际Ink/Worker相邻359/0、tsc/lint0；按绘制距离统一移动、保留虚拟行列与离屏文字、还原反滚及word/line/extend输入。修复诊断和跨文件测试隔离后，ROOT新快照完整相关集合2490pass/11原skip/0fail，tsc/lint0；原2453/3fail/1error保留。最新softWrap范围编码、历史卸载身份与native physical仍待闭合 |
| U19 | Client ui.fault事件、阶段与自身通知缺失 | 基础15及phase6路径已迁ROOT；七字段固定、空结果、自身通知与一次自动重绘，detach rejection继续运行，actual draw/timer/key watchdog带render/run与1000ms预算原因。私有完整相邻及严格类型通过；returned Promise/thenable rejection与bare invocation已迁ROOT，实际Worker/runtime→own ui.fault有私有相邻270/0。ROOT修复后的新快照完整相关集合2490pass/11原skip/0fail、tsc/lint0，旧failed记录不升级。terminal cache r2的12路径已迁ROOT，实际React边界、fixed normalized identity及new drawing重试有ROOT聚焦506/0；新完整集合2556pass/11原skip/0fail、tsc/lint0。跨owner/异步resize/全consumer、长链晚warning及完整native仍缺，render Promise仍同步失败 |

| U20 | terminal Client thrown-tree cache、drawing retry 和归一化身份 | r2已按seal逐路径CAS迁入12路径；真实Ink、Worker、runtime及普通guard在ROOT聚焦506/0与完整2556/11原skip/0同snapshot通过，类型/lint0。相同handed props值/全局三维保持failed，改变输入后仅fresh host.drawn重建；region-only不重试。cross-owner共享、异步Worker resize时刻、所有consumer及native physical仍未闭合 |
| U21 | 公开 ui.invalidate 返回 Promise、middleware/core 等待绘制 | 三生产路径及三测试路径已CAS迁入：公开同步void、七项InvalidatableEventName、原始/改写校验、宿主后台排队及owner/operation警告；内部绘制等待保留。ROOT8文件366/1原skip/0、组合回归55/0、全局types/lint0，同源15efbe7c…；旧RED及343/1/4 fixture失败保留，181行原expect不变。EventOf/ResultOf/testing精度、独立nativeHost、React/physical及完整集合仍待验，详见mods-test.md本批记录 |
| PL1-A20 | GC 名称、年龄、安装记录、marker 与容器边界 | A分支已迁ROOT，先前原业务20/0/88、P7业务13/0/63及types/lint/changelog通过；原3/17及两项oracle纠正记录保留。B发布、C .in_use生命周期、存储格式及Windows/WSL/native仍未闭合，详见mods-test.md |

## 分批修复与提交边界

每批保留最小失败、实现和相邻测试、当前制品验证及对应README/CHANGELOG。不要把同一文件整体提交当作功能划分；共有声明和文档按批内实际变化拆分。当前不自动创建提交，先保护并发Claude的现有变更和根binary。

| 批次 | 功能与相关代码 | 独立验收 |
| --- | --- | --- |
| A1 | 会话epoch：bootstrap/state、sessionUsage、cost-tracker、config、sessionStorage/Restore、setup/main/REPL/branch/recovery及声明 | fresh/resume/continue/clear/branch、旧官方记录、异步快照、禁用持久化、不同session |
| A2 | 宿主数据回执与准入：hostOperations、runtime admission、声明 | fs时间、process两pipe边界、state能力在实际加载前可见且可拒绝 |
| B | prompt.submit asUser与prompt.edit：runtime/Worker、promptAdapter、processUserInput及PromptInput | origin与SDK wire、键盘burst/paste、取消、预算和catch |
| C | session.compact/send/append、command.run | 实际压缩、注册与原生命令、transport结果、transcript写入顺序和identity |
| D | mcp.connect/process.spawn/audio | 实际服务、stream背压、错误/取消/清理；按surface分别验收 |
| E1 | Pane人工close、Button及焦点：ui/uiRealm、ModsPane、声明 | 官方相同UI序列、跨plugin identity、拒绝、resize及逐帧输出 |
| E2 | UI消费者、AbovePrompt、滚动、toast、键盘与持久化 | 全部自然入口、布局预算、批输入唯一owner、增长/异步/close-reopen |
| F | 作者runner、命名handler、精确公共类型及agent.register | 原样官方作者示例、严格正负类型、真实plugin validate/test/Agent |
| G | classic真实事件、telemetry策略与版本增量 | 官方33事件完整生产操作；Privacy下API与policy兼容；287/289分版本 |
| H | 验证脚本和完整发布矩阵 | 全25个required targets、不缩减、不拼接失败；独立同轮门禁 |

## G5 与完整门禁

G5是**Gap 5**：`/plugin-authoring` 的session授权、取消、turn结束后加载、同session恢复及clear/fork不继承。现有六个安全语义场景曾同轮通过；G5不是第5个发布gate，也不是所有Mods/API/UI测试。

G5仍缺逐帧logical/physical验证。验证脚本须为每次CLI启动单独保存frame文件（resume不能覆盖前一进程证据），记录输入chunk、session/plugin身份与语义断言，独立回放每个terminal output transaction并逐cell核对。完整required matrix必须保留25项，旧runner隔离尚未完成时应如实返回blocked。

当前全兼容和release结论均未通过。静态清单、单测、一次build或最终pane输出都不能关闭上述缺口；每批源码修复后需新构建与同轮真实验证。


### 2026-10-05：已有事件映射与 caller transport 增量

ROOT 已迁入26个已有事件的显式 Args/EventOf/ResultOf/On 定义，testing 映射其中25个（官方 ui.resolve/prompt.edit 不列入）。专项102/0、完整tsc/lint0；Frozen数组modifier与官方一致，严格四引用正反例及真实raw author25case保留。生产便利方法与事件调用参数分开；session生命周期、command.exitCode和其他unknown残差仍待后批处理。

C19 caller r6 已迁ROOT五路径，真实2/7/8层custom链、consumer→UI及custom→UI、同步return/throw恢复、settled serving和伪造props IDs验证279pass/1原skip/0fail，完整tsc/lint0。官方Cas9/current/resumed及7caller槽、MBt/lBt私有callee ledger已逐完整源核对；第一known caller先于leaf VM，祖先不借叶request写日志。本批10s ledger失效不能代称MBt公共Promise10s reject；b0t、unknown/nativeHost与reload持久门仍保留。精确迁入与检查目录见 mods-test.md。C06仍私有组合，native、全量、物理帧与release未完成。

六类会话生命周期三路径随后迁入ROOT，显式事件现为32个、testing31个，补齐完整SessionStart/Compact/Attach/Detach/Measure/End输入及回执。具名ContextBreakdown原始数组可变，hook经Frozen递归只读；旧UsageBreakdown/SessionUsage别名的其他残差仍保留。官方289与本地同代码完整四引用strict正例和20负例一致，ROOT九入口205pass/0skip/0fail、tsc/lint0。上段26/25计数为历史阶段，不改写旧证据；此批没有新增生产方法，append/send/telemetry及其他精确类型、native与新完整集合仍待验证。


### 2026-10-05：初始Pane焦点、重复注册与附件校核

UI1/RT7十二路径迁入时，src/types/scripts/assets为2851文件、canonical `2b92e0f7…`，与该轮验证副本逐SHA一致。UI1只覆盖非Client可见Pane已持有键盘时的初始协商、真实落点、否决/改写、普通重绘与卸载；完整焦点身份、Band/Client、AF05–11/13及native仍开放。RT7只覆盖同一注册环境的raw-pattern约束，跨入口的官方环境分组仍待核对。原34/0/60证据保留，本批没有把源码检查称为完整官方行为通过。

本批十项分次业务检查271/0/1624expect，含原样官方289 diff startup23/0及render/testLab38/0；最终全局types和12路径lint通过。原INK14fail和runtime2fail经原生产基线及真实宿主对照后，只修夹具回执及注册方式，失败日志不删除。T1三个声明路径realpath及T2真实重绘观察已迁入；ui.invalidate事件输入/包装结果和testing EventCalls已补齐，其他Op映射与native仍缺。response/improvment原快照不能作为当前全量结论；NEW1/2/3、EX1/2及其他缺口继续保留。详情与迁入前像见mods-test.md最新记录。

### 2026-10-05：附件 NEW1/NEW2 源码修复

terminalClient 的 NEW1 已迁入：同 key 换 module 时，销毁旧实例可能删除最后一个 owner registry；新实例必须重新取得当前 registry，回收时也只删除当前表中的自身条目。真实 Worker 回归原1/2→3/0，保留失效重挂后的新状态和 sibling。底层 numeric Worker reconcile 本来可停止实例，不能把逻辑 registry 泄漏泛化为所有关闭路径都泄漏 Worker。

NEW2 也已迁入：发布流程本来会重绘所有独立 site，实际失败是自动恢复继承的 uiContext 已 active=false，却仍选用已卸载的旧 snapshot/table。仅让新 draw 忽略明确失效的上下文，保留有效/候选上下文。session.start/tool.call 两项真实 CPU 故障回归原0/2→2/0，直接观察 AbovePrompt consumer，没有额外输入或 invalidate。

NEW1/NEW2迁入时源码2853文件、canonical `526419754491806e21da5dfb2d2dfe1e0e0f121bfbaaa2a8cf60b2c65b6f5bac`，与该轮验证副本相同。七项分次业务检查141/0/991expect，完整types和四路径lint通过；日志、23次自有进程审计与四路径分两次迁入记录见mods-test.md。该轮NEW3、UI16、EX1/2、14个公开方法及完整native/官方diff效果仍开放；不由这两项源码修复认定RT1全部完成。

### 2026-10-05：NEW3 插件刷新恢复回执

固定289提取源码中的MD/DU/J0t/sBt与QO/v9调用链确认：显式批量reload重新尝试culprit，Worker死亡会交给已排队的恢复，提示具体插件卸载。ROOT已迁入Error身份与恢复Promise的关联；公开reconcile在队列外等待实际恢复，避免队列自等待。generation变化保留真实故障Error；真正恢复失败仍reject，普通加载失败不匹配此关联。session不再对所有刷新失败声称旧runtime保留。有transcript sink时发送卸载及已发布withholdings提示，完整终端文案/样式与时序仍需native对照。

三项真实回归原0/3→3/0，含显式refreshPluginRuntimes等待健康session.start、culprit实际第二次执行、恢复paint失败及未知Worker exit。相邻分次169/0/1048expect；NEW3三案和Worker27的较早快照仅有无关session.test旧夹具不同，两生产文件均与最终一致，其余四选择器及types/lint是最终源码。原session.end重复unmatched夹具经原生产对照后增加空matcher，原错误断言保留。固定官方模块配置后diff的37案实际0skip；原缺env的13skip与示例manifest遗漏失败均保留。源码2854文件/canonical `9a5a05de9821510847ea32bdf8579df5ae9b034bcc59e3b171e867de7d77c2f6`，与迁入副本相同。NEW3只关闭源码刷新回执，完整命令/native、RT1其他分支、UI16、EX1/2及14个公开方法仍待完成。


## 2026-10-06：Pane 目录、模块重载和实际 Worker 边界

`ui.panes` 已接通公开方法、host dispatch、loader/Worker 注册及精确 `UiPane`、NoArgs、OpEventOf/OpValueOf/包装回执。实际官方core冻结返回对象，但经过官方Worker后的数组和五字段记录是可变副本；本地保留host冻结并在该公开方法边界提供独立副本。源码与严格作者类型10/0、完整UI94/0、runtime UI39/0；实际ROOT组合143/0及types/lint通过。重载候选继承本插件Pane，保留全局位置，更换绘制owner/句柄；旧焦点flight取消而新Pane持键不被清空。明确关闭、卸载、候选释放的负例原断言保留；原把reload当关闭的oracle按固定官方eNo/b源码及真实reload证据更正。

官方 `/private/tmp/mp289-o-a5` 与本地 `/private/tmp/mp289-l-a5` 的原插件文件、输入字节、160×40和归一化dummy环境相同，均正常exit0。重载前按钮、重载激活/查询、重载后按钮、持键重开及关闭的七个稳定阶段公开返回一致。首次open立即读的focus值不同，完整生成作者声明及tsconfig副作用也不同；这些差异保留在 `/private/tmp/mods-align-m1scugg4/ui-panes-289-r1/native-pair-comparison.json`，不能据此关闭完整Pane/UI兼容。其他13个公开方法、完整操作映射、native所有帧和既有diff差异继续开放。官方CHANGELOG于本轮再次核对，最新条目仍为2.1.289。


### 2026-10-06：持久 status 通知

提交679f27b实现独立pinned状态、稳定优先级排序和输入框下方通知样式。准确提交副本的新制品5397b15c…与固定官方289的五阶段status行（文本/ANSI/顺序/相对位置）一致，双方exit0；不能代替全physical帧。真实hook/Ink 7/0，相邻候选139/0，完整staged types/lint/release-check/build通过。旧HEAD的两项无key取消失败保留。public ui.status仍Promise/官方void，String/null转换及错误报告、名称清洗、其他13方法、完整类型/UI/diff/G5继续。[本批证据](/private/tmp/mods-align-m1scugg4/ui-notifications-289-r1/review.md)。


## 2026-10-06：response复核与通知公开契约

原response SHA2ef2250d…未更新，仍是旧146/155、9失败。本轮最终ROOT在同一2869文件core13b3e684…上逐文件串行复跑原9项，全部exit0；OpenAI/build-isolated执行顶层assert并有完成标记，Bun注册case为0单列。初次九文件并发中的prompt.edit超时与parent-abort消息undefined保留，未据串行通过宣布并发稳定或完整changed-file/full-suite门禁通过。

官方yw/zer/wrapMethod与作者声明确认ui.log/status/toast同步void；Worker边界实现String/null转换、限定option getter及async丢弃诊断。canonical操作输入/void回执和导出的UiLogSink/UiLogOptions/ToastOptions补齐。真正host callback是testing事件接口，保持异步回执。两个旧await抛错oracle经原件源码及native确认后更正，valid sink、激活缓冲、失败前完成log与toast throttle断言保留，后台观察改真实settle屏障。

初始真实Worker0/6→6/0、严格类型0/2→2/0；真实原件发现invalid log sink本地仍进入middleware，新增case6/1→7/0，原始sink校验移到dispatch前。最终ROOT新两文件9/0/46expect，相邻四文件100/0/400expect，调用链/注册/heartbeat55/0/151expect；完整ROOT release-check38.467秒exit0。所有最终结果、Makefile build和version都对应core13b3e684…，不混算原510f的155全绿。

新最终制品aa800c7a…/101621858B/2.1.280，与固定官方289在mv289-o-a2 / mv289-l-a3、相同插件/输入/160×40/dummy配置中完成五阶段，18条op/input/origin及顺序完全一致；基本void、coerce getter、deny false与recover回执相同，双方exit0。此前a1/a2多出invalid log事件的RED保留。null toast options的同步错误name均TypeError且instanceof Error，但official instanceof TypeError=false/local=true，仍为明确差异；完整帧、toast pointer/timer和diff流程未因此验收。五次自有native的10个PID均已不存在，其他Claude未查找或处理。

README/CHANGELOG更新调用方法和边界。原response、fix-instructions、improvment正文、旧ROOT binary和固定官方binary/dTS未覆盖。HEAD仍679f27b，第八批已提交，本批index空、未新增commit、无push。七代码/测试路径包含既有未提交runtime/declaration基础，继续构造HEAD最小提交副本并验证依赖后按功能提交；已有用户授权无需重复确认。剩余13方法、完整类型/API/UI/G5/官方diff、最新全套门禁仍开放。证据 [review.md](/private/tmp/mods-align-m1scugg4/ui-void-289-r1/review.md)。


## 2026-10-06：通知公开契约与第九批签名提交

第九批 `d03d3be` 仅11文件，357新增/11删除；完整暂存树 `b8b613a7287f2c96fb8e5ec059f1ad4ff38bdccf` 与准确HEAD+补丁源码一致，正常GPG签名有效，index空、无push。public log/status/toast同步void、String/option getter、原始sink准入与后台所属插件/操作/原因日志；必要的capability生命周期保留正常返回后的在途工作，真实取消/throw/timeout仍取消，catch独立恢复。声明只提交公开options及三方法，canonical操作映射留给后续批次。

准确副本新测试9/0、相邻75/0、dispatch/生命周期61/0，types/lint/release-check及隔离Makefile新构建通过。最小副本初次held middleware及相邻两失败完整保留，补生命周期后通过；没有借用完整脏工作区的依赖。新制品5f66e42c…/101357666B/2.1.280，与固定原件289在mn289-o-s9a1/mn289-l-s9a1完成相同五阶段，18条操作DTO/origin/order一致且双方exit0。null options错误原型、生成作者文件布局及完整UI/diff/G5仍有差异/未覆盖。

ROOT只新增两份回归文件，11/0/61expect和完整类型通过；其余core与本轮前像完全相同，2871文件SHA `aaf97305816681207897531dee19fd306f114a396e1b785c04d853812596fcee`。原response仍是旧146/155、9失败，原9的串行GREEN属于13b3e684快照；初次并发失败保留，当前完整changed-file/full-suite门禁未完成。原response/fix指令/improvment正文/旧制品未覆盖，其他Claude进程未操作。详见[完整证据](/private/tmp/mods-align-m1scugg4/staged-notification-contract-289-r1/review.md)。


## 2026-10-06：response当前复核与copy对齐

原response保持SHA `2ef2250d26c206e40c52bc35a900c0115d9820360b26d0d90fb491d73ff2f001`，仍写旧00:31快照146/155与9失败。本次在实际ROOT、隔离HOME/config/tmp、不继承API key或OAuth凭据，串行复跑旧9项：ModsEdit17/0、keyWorkerBatch4/0、toolAdapter50/0、compact30/0、model合同64/0加包装1/0、teammate和SendMessage各包装1/0；OpenAI与build-isolated为顶层assert脚本，Bun注册0case但退出0且完成标记存在，不计成新增通过用例。九案都对应core `aaf97305816681207897531dee19fd306f114a396e1b785c04d853812596fcee`，每案前后未变。首次driver缺runs父目录、未启动Bun的错误保留；修正目录后才执行九案。完整表与原输出见 [response当前复核](/private/tmp/mods-align-m1scugg4/response-recheck-20261006-r1/review.md)。这不是全部changed-file/full-suite门禁，也不证明同进程或并发稳定。

随后对固定官方289作者声明、yw及Jko/Qko/fko源码补齐ui.copy：公开仅读取text/surface，getter同步抛错，不做String转换；先补默认surface再进入冻结作者事件，middleware可改写文本/目标或拒绝。无attached目标no-surface、无设施no-clipboard；terminal复用既有clipboard与OSC52，单次写入最多1048576字符，原path成功语义保留。generic value/deny envelope不额外收窄未类型化作者的值；真实官方custom情景返回opaque值后增加Worker回归，严格类型仍拒绝非法UiCopyResult。debug仅记录plugin、字符数、path/写入/结果，不记录文本。

候选原缺API/类型1pass9fail；实现中的错误debug import、private attachment夹具、把可信embedding当作冻结作者边界以及Worker事件准入表遗漏均保留对应失败。最终用真实ui.mount连接与真实policy Worker验证冻结输入、origin及改写，11/0/39expect；terminal2/0覆盖UTF-8原样和恰好1MiB/超界写入，相邻UI53/0/257expect。完整候选release-check38.482秒、隔离Makefile构建和version2.1.280均exit0。实际ROOT六文件组合66/0/308expect，迁入只涉及9路径，其他core按前像逐路径不变；2875文件canonical SHA `1ed3b2d905f6c42719b19bb50dd257d407bda0bca554c74435cb65a62ecbf3b3`。旧ROOT/官方制品、声明及原报告未覆盖，其他Claude进程未操作。

本轮官方mc289-o-a1和新本地mc289-l-a1在相同owned插件、8组精确输入、160×40、dummy配置、禁止TCP/Keychain且SSH fixture的独立tmux中完成basic、rewrite、unattached、refuse、deny、invalid、getters、custom与正常exit0。相同6条ui.copy DTO/origin/order、8组回执及两次自有tmux buffer文本；完整raw PTY/pane/debug/driver与生成文件保留。制品ffbe72719074ca4b538a84fe8c84e5ba524c1dd5e81d24d4e6c37dd13b67401c、101621858B；native之后只加1项测试，binary对应的生产源码相同。未访问系统剪贴板；远端answers能力广告、第一responder、5秒期限和关联reply协议尚未实现，不能将host provider桩当作生产远端接通。generated作者文件布局和内容仍不同；未比较完整logical/physical UI帧。README和CHANGELOG补使用/边界，公开方法缺失13→12，已有同名方法与全类型仍需逐项检查。

完整作者模块checker清单：官方289核心81成员/本地70（包含身份属性），缺12方法，另有本地多出的公开turn.step；官方claude-code导出554名字/本地354，其中缺246个官方名字。EventOf/ResultOf138vs73，OpEventOf/OpValueOf61vs6，EventCalls11vs10；两边strict声明本身无diagnostic，并不代表映射已兼容。旧624为其他module/内部声明的不同口径，不能和554混算。官方原样diff未调用ui.copy，本项不会替代diff验收。

在线重新核对发现官方npm latest/CHANGELOG已为2.1.290；289继续作为本轮固定且实际运行的历史基线。290的serverToolUses、tool.check agentId/ceiling、ThemeKey/Color、gatingHooks以及Worker catch/卸载等修复必须继续核对，不复用289结果宣布最新兼容。官网Mods reference仍标as of289并要求信任安装版本生成声明。完整API/UI/diff/G5和最新changed-file/full-suite门禁继续开放。HEAD仍第九批d03d3be，index空、无push；新复制API依赖未提交runtime/类型基础，不能直接混入所有脏文件。完整本轮证据见 [ui-copy review](/private/tmp/mods-align-m1scugg4/ui-copy-289-r1/review.md)。

本批最终ROOT release-check exit0（39.198秒），当前1ed3b2d9…上旧response原9项再次逐文件串行全部exit0，见 response-recheck-20261006-r1/after-copy-summary.json。两次当前ROOT复核不同快照分别保留，不以aaf的结果代替新core。完整门禁仍未完成。

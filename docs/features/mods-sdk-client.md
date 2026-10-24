# Mods 远程客户端（stream-json）

> 英文名：`mods-sdk-client` · 领域：插件与扩展 · [返回功能索引](README.md)

## 作用与效果

外部 Client 通过 stream-json 连接 CLI：首条 `initialize` 配合 `--await-initialize` 在发现前登记插件路径；Client 可请求绘制、查询自己的 pane、控制焦点、滚动、草稿编辑与补全。协议类型来自 `src/entrypoints/sdk/controlTypes.ts`。

## 配置

| 配置项 | 位置 | 说明 |
| --- | --- | --- |
| `--await-initialize` | CLI（需 `--input-format=stream-json`） | 从首条 initialize 读取本次插件 |
| `--input-format stream-json --output-format stream-json` | CLI | stream-json 会话 |

## 效果

协议交互的验收记录见下方详细说明与 [`mods-test.md`](../../mods-test.md)；基础 stream-json 会话见 [agent-sdk.md](agent-sdk.md)。

## 详细说明

以下内容自原 README 迁入，保持原文。

### Mods 远程客户端连接（stream-json）

### 启动时传入插件

由 SDK 父进程在启动时写入首条 `initialize` 请求，并启用 `--await-initialize`，即可在命令、Mods 和 MCP 发现之前登记本次会话的插件路径：

```bash
printf '%s\n' '{"type":"control_request","request_id":"init","request":{"subtype":"initialize","plugins":[{"type":"local","path":"/absolute/path/to/plugin","skipMcpDiscovery":true}]}}' |
  ./built-claude -p --verbose --input-format=stream-json --output-format=stream-json --await-initialize
```

将示例路径替换为已有插件目录、父目录或 ZIP。每项必须为 `{type:"local", path:string, skipMcpDiscovery?:boolean}`；相对路径按启动工作目录解析。`skipMcpDiscovery:true` 跳过 `.mcp.json`、manifest 及 MCPB 的 MCP 发现，保留插件的其他内容。`--plugin-dir` 与初始化目录合并；同一路径同时以普通和跳过 MCP 的方式登记时，普通加载仍会发现 MCP。

调用方已管理 MCP 连接时，也可用隐藏选项 `--plugin-dir-no-mcp <path>` 登记跳过 MCP 的会话来源；重复参数可登记多个路径，无需 `--await-initialize`。它与初始化请求中的跳过 MCP 来源合并。解析后相同的 `CLAUDE_CODE_PLUGIN_DIRS` 来源会被排除；显式普通 `--plugin-dir` 或 SDK 普通来源仍会发现 MCP。管理员的 `disableSideloadFlags` 同样拒绝此选项。

会话路径支持单个插件目录、父目录和 ZIP（扩展名忽略大小写）。父目录按名称展开具有 `.claude-plugin/plugin.json` 的非隐藏直接子目录；根目录自身构成插件时优先加载该插件。ZIP 可包含一层包装目录，包装判断忽略 `__MACOSX` 和 `.DS_Store`。归档从本次会话的临时缓存加载，退出时清理；内容变化时整体替换，损坏或越界归档不会覆盖已有缓存。预览归档更新时使用独立目录，不替换运行中的版本。

首条非空白行必须是完整的 initialize JSON，并以换行结束；其内容及后续输入会继续交给 SDK 处理。EOF 前没有换行时，不应用其中的启动插件，initialize 请求本身仍会被处理。此开关仅用于本地非 TTY 的 `stream-json` 输入，不用于远程 `--sdk-url` 传输。

initialize 成功回执中的 `plugins_applied` 表示所列路径是否全部属于对应类别的启动来源；它不保证目录存在、插件有效或 MCP 握手成功。未列出插件或空数组时省略此字段。不启用开关时，`initialize.plugins` 不加载插件；重复 initialize 也只返回此状态，不会追加新插件。管理员的 `disableSideloadFlags` 策略同样拒绝这个启动入口。

本项按固定官方 2.1.292 的本地 stdio 行为验收；完整 SDK 初始化字段、远程传输及 MCP 故障恢复生命周期继续单独验收。

将以下 JSON 行保存为 `requests.jsonl`；每条请求的 `request_id` 应唯一：

```json
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}
{"type":"control_request","request_id":"attach-1","request":{"subtype":"ui_attach","surface":"desktop","client_id":"desktop-main","viewport":{"columns":90,"rows":30,"isFullscreen":true}}}
{"type":"control_request","request_id":"detach-1","request":{"subtype":"ui_detach","client_id":"desktop-main"}}
```

使用 stdin 管道启动（EOF 会结束会话并移除剩余连接）：

```bash
cat requests.jsonl | claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir /path/to/plugin
```

远程 surface 为 `desktop`、`mobile` 或 `vscode`；客户端 ID 限 1–64 个 ASCII 字母、数字、`.`、`_`、`-`，冒号保留给引擎。viewport 的列、行须为正整数。attach 回执为 `{surfaces:[...]}`，detach 回执为 `{detached:boolean,surfaces:[...]}`。重复 attach 不重复通知 hook；未知客户端的 detach 返回 `detached:false`。显式连接独立于单个绘制站点，结束时自动移除。

`session.attach` 和 `session.detach` 是观察事件：调用 `$.session.surfaces()` 已能看到更新后的 roster，`next(e)` 不负责提交连接，返回伪造 clientId、抛错或取消通知也不会回滚传输状态。终端 binding 不发 attach；session.end 的 detach 使用 `reason:'end'`。调试日志可查找 `[ModsUIClient]`。

当前入口接通全部18类客户端控制，包括连接、绘制、回调、Client 模块、Pane、滚动、焦点及 prompt 控制。五类远程 responder 和完整 UI/diff 继续实现与验收；已接通控制的有限对跑见下文专项。`answers` 只接受官方声明的五类 responder 名称，数组最多 5 项（重复值仍合法），不能据此认为 responder 已实现。实际 SDK 协议对照与限制见 [远程连接专项](../../docs/research/mods-remote-roster-292-20261007.md)，作者事件定义见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

### SDK 远程绘制与 Client 模块

在已初始化的 stream-json 会话中发送绘制请求，读取对应 request_id 的 control_response：

```jsonl
{"type":"control_request","request_id":"draw-1","request":{"subtype":"ui_render","surface":"desktop","component":"ToolUse","instance_id":"tool-1","props":{"input":{"command":"pwd"}},"on_screen":null}}
```

`props.tool_use_id` 缺失或不是字符串时由 instance_id 补齐；transcript 组件的 onScreen 只来自 on_screen。output 超过 65536 个 UTF-16 单元时截断，避免切开代理对。`hooked` 表示该组件存在 hook，surface 没命中仍可为 true。`rewritten` 来自返回树选中的第一个非零 engine ref，因此 `next(e)` 也返回 true。

Button / Input / Select 回执的 press 含 plugin 和 opaque handle。将它们原样用于 ui_press，或带 kind/value 的 ui_input、带 value 的 ui_select；key 可选。替换绘制树后旧 handle 返回 handled:false。control_cancel_request 只抑制同 request_id 的绘制回包，不终止 hook；EOF 等待运行收尾并释放绘制 lease。

桌面 Client 节点通过 client.plugin 标识所有者，client_modules 给出插件到模块包 hash 的映射。用 ui_client_module 查询 {plugin,hash,modules,runtime,limits,files}。宿主从已准入的源快照编译和重写 import，模块由外部 surface 执行；不得将包中的源代码当成宿主 hook 运行。随包返回官方 2.1.292 的固定 surface runtime/types 数据，hash 包含文件、模块清单和 limits。

调试日志 `[ModsUIRemote]` 记录 surface/component/instance/drawing、hooked 和 rewritten，不新增 props 正文日志。实际三方回执、来源和边界见 [远程绘制专项](../../docs/research/mods-render-bridge-292-20261007.md)。客户端浏览器挂载、focus 及五类 responder 仍需独立完成和验收；Pane/scroll 见后续专项，Client 交互、消息和故障见后续专项。


### 外部 Client 的交互与消息

拿到 desktop `ui_render` 的 Client 树后，使用回包中 `client.plugin`、`props.key` 和 `props.module`，加上渲染的 `component` / `instance_id` 构造地址；模块名已规范化，不要使用作者传给 `ui.Client` 的相对拼写。

```json
{"type":"control_request","request_id":"client-click-1","request":{"subtype":"ui_client_press","plugin":"example","component":"Pane","instance_id":"pane-1","client":"view","module":"hooks/view.ts","element":"save","event":{"type":"press"}}}
```

`event` 还可为 `{"type":"input","kind":"change","value":"draft"}`、submit 或 select。`handled:true` 表示地址可达；只有回包含 `reached` 时，外部 Client 才对该最终输入调用自己的回调，Mods 可以重写或拦截。服务端不执行 Client 源码。

将同一地址放进 `ui_message`，附 `data`（必填，允许 null），会只触发所属插件的 `ui.message`。`next.origin` 为 client；回包可带替换 `props`。消息有 100000 字符、20000 值和 32 层深度限制；过期地址返回 `handled:false`。input、select、message 各自按插件排队，press 独立执行。

运行专项回归：

```bash
bun test --no-env-file ./src/services/mods/remoteUiClient.test.ts ./src/services/mods/remoteUiRender.test.ts
```

真实官方/候选/完整工作区的验证和未完成范围见 [Client 交互验收](../../docs/research/mods-client-events-292-20261007.md)。当前接通 18 类客户端控制和 ui_invalidate/ui_panes/ui_scroll/ui_focus；有限官方对跑及验收边界见[远程编辑与焦点专项](../../docs/research/mods-remote-composer-292-20261008.md)。五类 responder、完整浏览器 Client 和官方 diff viewer 流程继续闭合。


### 外部 Client 故障与恢复

外部 surface 在模块加载、组件绘制或回调运行失败时，以当前 Client 的地址发送 `ui_client_fault`，phase 分别为 load、render、run，reason 最多 200 个 UTF-16 单元：

```json
{"type":"control_request","request_id":"client-fault-1","request":{"subtype":"ui_client_fault","plugin":"example","component":"Pane","instance_id":"pane-1","client":"view","module":"hooks/view.ts","phase":"render","reason":"View failed"}}
```

地址存在时回包为 `{"handled":true}`，失效时为 false。只有所属插件收到 `ui.fault`，next.origin 为 engine/core；surface、component、requestId、element、module、phase、reason 都只读，`next({})` 恢复原输入。作者可以 `on('ui.fault', ...)` 观察故障，返回空结果；没有 `$.ui.fault()` 调用。

当非空实例仍在绘制且所属插件监听此故障时，服务端发送以下推送（实际包含 uuid / session_id）。客户端据此重新发送 ui_render；服务端不会自动执行远程 Client 模块或重复执行绘制 hook。

```json
{"type":"system","subtype":"ui_invalidate","event":"ui.render","instances":[{"surface":"desktop","component":"Pane","instance_id":"pane-1"}]}
```

省略 instances 表示全局绘制失效；有 instances 时只重绘对应实例。同一故障代次的重复错误、相同请求及 props 变化不会持续触发恢复；绘制依赖再次失效后才允许新一轮恢复。故障控制没有可取消任务；control_cancel_request 不影响观察 hook、恢复通知或故障回包。`[ModsUIRemote]` 日志包含归属、规范模块、实例、来源 surface、故障 phase 和完成耗时。

```bash
bun test --no-env-file ./src/services/mods/remoteUiFault.test.ts ./src/services/mods/remoteUiFaultTypes.test.ts
make check-mods-control-types
```

原生回执、故障文本、恢复次数与取消顺序的证据见 [Client 故障验收](../../docs/research/mods-client-fault-292-20261007.md)。此项不替代完整浏览器 Client、终端内部故障、官方 diff viewer 或全部 Mods 兼容验收。

官方作者说明见 [Anthropic Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview) 与 [Mods 接口参考](https://code.claude.com/docs/en/plugins/mods/reference)。接口参考将 ui.fault 定义为 Client 加载、绘制或运行失败的观察事件；本项目的具体类型与传输行为以固定官方版本的声明和专项验收为依据。


### 查询 Mods 自己的 pane

`await $.ui.panes()` 返回本插件登记在引擎中的 pane，包括暂未放置的记录。每项只有 `id`、`title`、`isShown`、`isFocused` 和 `isPlaced`。列表按打开顺序排列，已放置的记录在前；`isShown` 表示当前显示，`isFocused` 表示持有键盘，两者分别读取。

```js
on('session.start', async ($, e, next) => {
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === 'clock')) {
    await $.ui.open({id: 'clock', title: 'Clock'})
  }
  return next(e)
})
```

重载后的模块能查询仍在引擎中的自有 pane。准备阶段的开关操作在新代次发布时生效，旧绘制回调随后失效。`ui.panes` hook 收到冻结的空参数，可返回 `{value: panes}` 或 `{deny: 'reason'}`。TypeScript 方法无参数，返回 `Promise<readonly UiPane[]>`；Worker 中的结果是独立副本，修改它不会改变引擎状态。JavaScript 的额外便捷调用参数会被忽略。

无终端 SDK 会话也支持 pane 登记与查询，外部客户端另行请求 ui_render 绘制内容。作者接口见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)，精确验证结果见[自有 pane 查询专项](../../docs/research/mods-pane-list-292-20261007.md)。


### SDK Pane 控制

在 `--input-format stream-json --output-format stream-json --verbose` 会话中，客户端可发送以下请求。每个请求使用独立的 `request_id`，通过同 ID 的 `control_response` 读取结果。

```json
{"type":"control_request","request_id":"panes-1","request":{"subtype":"ui_panes"}}
{"type":"control_request","request_id":"show-1","request":{"subtype":"ui_pane_show","id":"clock"}}
{"type":"control_request","request_id":"focus-1","request":{"subtype":"ui_pane_focus","id":"clock","surface":"desktop"}}
{"type":"control_request","request_id":"blur-1","request":{"subtype":"ui_pane_focus","id":null}}
{"type":"control_request","request_id":"close-1","request":{"subtype":"ui_close","id":"clock"}}
```

`ui_panes` 返回已放置记录的 `panes` 和 `shown_id`、`focused_id`、`focus_requested_id`，空值为 `null`。打开时的 `focus:true` 提出焦点请求；客户端确认焦点后以 `ui_pane_focus` 更新实际状态。未放置项不会因此获得焦点。切换显示项时，已有键盘焦点随显示项移动。状态变化另以带 `uuid` 和 `session_id` 的 `system/ui_panes` 推送；客户端应更新自己的视图，这些消息不进入模型对话。

远程 `ui_attach` 的 viewport 若带布尔 `isFullscreen`，表明该 surface 可以放置 pane，值为 `false` 也有效。只有不支持放置的已测量 viewport 时，新 pane 等待；可放置 surface 接入或这些客户端全部离开后，等待项转为已放置，已放置项不会因 detach 被撤回。没有已测量 viewport 的无终端会话可登记 pane，但登记本身不调用终端绘制。

`ui_close` 以 person 来源经过 `ui.close` hooks，回复 `{closed:true|false}`；拒绝关闭或重复关闭仍在处理的 pane 时为 `false`。不存在的 ID 返回 `true`。已关闭 pane 的外部回调与 Client 地址随后失效。同 ID 更新保留最初的插件归属，并替换可选标题、行列和行为属性；跨插件更新不让调用者在 `$.ui.panes()` 中取得该记录。

作者接口和安装版本声明的取用规则见 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。本批对照与边界见 [SDK Pane 专项](../../docs/research/mods-pane-controls-292-20261007.md)；远程 focus、prompt edit/autocomplete 见后续用法；五类 responder 和完整 UI/diff 流程仍需独立验收。


### SDK 远程滚动与插件定位

已接通 `ui_scroll`，当前 18 类客户端控制均有运行入口。渲染 Pane 或 AbovePrompt 后，用非负整数表示窗口行数和位置，用整数 `by` 表示滚动增量：

```jsonl
{"type":"control_request","request_id":"scroll-1","request":{"subtype":"ui_scroll","client_id":"reader","component":"Pane","instance_id":"pane-1","offset":0,"by":3,"body_rows":20,"content_rows":100}}
```

Pane 必须已经登记且处于可放置状态；AbovePrompt 的 `instance_id` 固定为 `above-prompt`。尚未绘制时，已连接客户端也可以提交报告。布局客户端 attach 的回执后会补发当前 `ui_panes`，若放置变化已经发过清单则不会再补发。服务器沿用同一站点的缓存位置，首次未绘制报告从 0 开始；后续 `offset` 不覆盖缓存。回执为 `{moved,offset,deny?,follow_end?}`，合法请求被拒绝仍返回成功的控制响应，格式非法则返回错误。

无终端会话中的插件 `$.ui.scroll({to:"end",in:"pane-1"})`、`to:"start"` 或 `to:{key:"item"}` 共用这份状态；控件定位只查找所属插件的 `keyed` 行，支持 `block:"nearest"|"start"|"center"|"end"`。外部界面收到 `system/ui_scroll` 后应用该位置，`follow_end:true` 表示继续跟随末尾。人的滚动报告不会生成同名推送。插件在报告处理期间移动窗口后，原报告会以 `the window moved meanwhile` 拒绝，避免覆盖新位置；排队的普通报告合并增量，控制取消仍保留回执。

`[ModsUIRemote] ui.scroll` 调试日志记录站点、客户端、来源、增量、结果位置与拒绝原因。运行 `bun test --no-env-file ./src/services/mods/remoteUiScroll.test.ts`，完整证据见[滚动专项](../../docs/research/mods-remote-scroll-292-20261008.md)。`ui_focus` 和 prompt edit/autocomplete 的用法与对跑见后续章节；五类 responder、浏览器 Client 和完整官方 diff viewer 继续闭合验收；终端滚动继续走既有宿主路径。作者契约参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。


### SDK 远程草稿编辑与补全

客户端在 stream-json 会话中以自己的 `client_id` 维护草稿。`by:"app"` 同步应用草稿；省略 by 或 `by:"person"` 经过 `prompt.edit`。cursor 和 decorations 使用 UTF-16 位置，cursor 超过文本末尾会 clamp。

```jsonl
{"type":"control_request","request_id":"draft-1","request":{"subtype":"ui_prompt_edit","client_id":"editor","by":"app","text":"ask #12","cursor":7}}
{"type":"control_request","request_id":"edit-2","request":{"subtype":"ui_prompt_edit","client_id":"editor","text":"ask #123","cursor":8}}
{"type":"control_request","request_id":"complete-3","request":{"subtype":"ui_prompt_autocomplete","client_id":"editor","text":"ask #123","cursor":8}}
```

编辑回包为 text/cursor，可带 decorations。补全回包为 suggestions，可带 start。重叠输入会合并或撤销旧请求，旧回包可能带 `superseded:true`；客户端应以最新草稿处理回包，不把被替代建议覆盖回编辑器。

作者可注册补全事件；没有 `$.prompt.edit()` 或 `$.prompt.autocomplete()` 便捷方法。

```js
on('prompt.autocomplete', async ($, e, next) => {
  if (!e.token.startsWith('#')) return next(e)
  return {suggestions: [{text: '#123', label: 'Issue 123', description: 'Open issue'}]}
})
```

text/cursor/token/start 是只读事实；`next({})` 恢复省略字段，不能改写它们。原始候选 text 必须非空，label/description 若存在必须是字符串。通过契约检查后再清理 Unicode，清理后空候选移除，label 合并空白并省略空值。空 token 不触发 hook。输入、取消和排队会经过实际 Worker 与 runtime。

### SDK 远程元素焦点

Pane 或 AbovePrompt 绘制后，客户端报告键盘归属及实际元素；element 取自当前绘制中的 Button/Input/Select，保留 plugin 与 key。

```jsonl
{"type":"control_request","request_id":"element-1","request":{"subtype":"ui_focus","client_id":"editor","component":"Pane","instance_id":"clock","is_held":true,"element":{"plugin":"example","key":"save"},"by":"person"}}
{"type":"control_request","request_id":"release-2","request":{"subtype":"ui_focus","client_id":"editor","component":"Pane","instance_id":"clock","is_held":false}}
```

回包提供 moved、当前 element（无 holder 为 null）与可选 deny。失去键盘时省略 element；is_held=true 且省略 element 只报告键盘状态，不发起移动，element=null 则明确移动到站点本身。等待队列合并状态报告时会保留最近显式指定的落点及其 by。AbovePrompt 的 instance_id 固定为 `above-prompt`。渲染请求的 isFocused 会在 hook 运行前同步归属，移除控件后旧 holder 失效；Client 节点自身不进入这组可聚焦控件。

作者 `$.ui.focus()` 经相同归属与绘制校验，在远程站点成功移动时另推送 `system/ui_focus`，带 client_id/component/instance_id/plugin/key、uuid 和 session_id，客户端据此更新视图。该推送不进入模型历史。component/requestId/plugin/origin 只读；hook 可改写已有 element 的 key，不能添加或删去 element。拒绝原因必须非空，已执行成功的 next 不能再被迟到 deny 撤销。

```bash
bun test --no-env-file ./src/services/mods/remoteUiPrompt.test.ts ./src/services/mods/remoteUiFocus.test.ts
make check-mods-control-types
```

`--debug --debug-file /absolute/path/debug.log` 的 `[ModsRemotePrompt]` 与 `[ModsUIRemote]` 记录客户端、站点、来源、长度/位置和拒绝原因。宿主 capability 异常的 Proxy/getter 安全提取见[异常边界专项](../../docs/research/mods-capability-error-audit-20261008.md)。本批真实原生对跑与完整发布门禁分别记录在[编辑和焦点专项](../../docs/research/mods-remote-composer-292-20261008.md)；完整 terminal/diff/浏览器生命周期仍需闭合。作者接口参考 [Anthropic Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)。

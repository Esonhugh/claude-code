# Claude Mods 研究报告

- 报告日期：2026-09-16；资料采集：2026-09-15 至 2026-09-16。
- 研究对象：Claude Code 的 **Claude Mods / Function Hooks**。
- 研究方式：官方公开资料、固定提交的官方示例源码、官方发行二进制静态提取、本地 Worker/VM 契约测试，以及编译产物与官方 `2.1.272` 的 scripted tmux 对照。
- 结论等级：已交付受限兼容切片，并获得部分双端 runtime 证据；存在明确差异与未覆盖项。**不等于完整官方 runtime parity，也不是安全沙箱证明**。实施与验证状态见第 14 节。

## 1. 结论摘要

**Claude Mods 是真实存在的新扩展机制，不是 mode、model 或 permission mode 的简称。**

官方定义为：

> “A mod is a Claude Code plugin whose behaviour lives in a hooks module.”

产品名称是 **Claude Mods**，底层技术名称是 **Function Hooks**。它不是替换 Plugins 的新包管理体系，而是让现有 Plugin 能用 TypeScript/JavaScript 中间件参与 Claude Code 引擎的事件处理、工具执行、提示词构造、会话生命周期和界面渲染。[S1][S2]

核心模型可以概括为：

```text
Plugin = 安装、配置、依赖和分发单位
Mod = 使用 Function Hooks 的 Plugin
Function Hook = ($, e, next) 形式的引擎事件中间件
$ = 引擎提供的能力接口
```

本轮最重要的发现：

1. **已经不是纸面提案。** 官方仓库公开了 `diff`、`sec-default`、`telemetry` 三个内置 Mod 的源码；官方 `2.1.272` 二进制包含模块配置 schema、加载 gate、开发说明和完整类型契约。
2. **仍然是 Early Access，不是稳定公共 API。** 官方 README 和二进制类型声明均明确允许跨版本无通知变更。9 月 9 日讨论更新开放了实验启用方式，但不能据此承诺 GA 日期或所有账户默认可用。[S1][S2]
3. **它扩展的是 harness，而不只是提示词。** Mod 可以注册工具、修改工具结果、参与模型请求与流式输出、构建 UI、运行定时任务，甚至通过 `engine.create` 向 `$` 添加新能力接口。
4. **组合顺序和失败恢复是核心语义。** 五层中间件链具有不同权限；普通 hook 失败默认跳过，不天然等于拒绝操作；`next(e)` 可能实际执行副作用。
5. **研究基线不能加载 Mod；本轮已实现受限兼容切片。** 原先的 schema 和传统 hooks 路径不足以兼容。现在已补模块声明、扫描、Worker/VM、普通分派与 activation 生命周期，接入 CLI 与完整工具管线，并完成本地编译产物的启停/clear/退出序列验收；不能据此声称任意官方 Mod 可运行。
6. **开发必须跟随实际二进制生成类型。** 公开仓库文档和 `2.1.272` 二进制中的 `/plugin-types` 行为已有差异，不宜复制早期讨论示例后直接用于当前版本。
7. **深入核查发现不能省略的实现细节。** 加载有扫描、宿主复核和准入；外部模块默认共享 Worker、各有 VM 环境；热更区分保留旧版与策略拒绝；流式 catch 不完全等同于非流式 replay。第 13 节给出代码证据、本地接入面和后续测试矩阵。

## 2. Scope 与证据边界

### 2.1 版本与来源

| 对象 | 本轮确认值 | 说明 |
| --- | --- | --- |
| 本地研究基线 HEAD | `d7a939cb6348c3e5061c6a9007c6428839883ff3` | 改动前源码定位；本轮实现尚未提交 |
| 本地 Makefile 构建版本 | `2.1.219` | `Makefile:2`，不是官方最新版本 |
| 项目内 `official-claude` | `2.1.263` | 来自提取入口，不是根据文件名推断 |
| 官方包仓库 `latest` / `next` | `2.1.272` | 本轮查询快照；标签以后会变化 |
| 官方包仓库 `stable` | `2.1.236` | 不应把 latest 当作 stable |
| `2.1.272` 包发布时间 | `2026-09-14T23:34:13.565Z` | 官方包索引的 `time` 字段 |
| `2.1.272` 二进制构建时间 | `2026-09-14T22:54:44Z` | 二进制入口常量 |
| `2.1.272` 二进制内部 commit | `013cad548b76e5d315ae72da82dce47cd7c99678` | 与公开仓库 commit 是不同标识 |
| 官方公开源码研究 commit | `f96c3b49c4c8721685206aaab23609b2d399df4e` | 固定此提交的 `mods/`，不引用浮动 main 的行号 |

授权范围为本地项目、用户要求研究的官方公开源码和官方发行产物。静态研究阶段只下载到本地临时目录；后续批准实施及验证后，在隔离配置下使用官方已公开的 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 运行自写 fixture。没有安装新版 CLI、执行安装脚本、修改官方二进制、绕过账户/组织 gating 或上传提取物。

### 2.2 Evidence 标签

- **Source-confirmed**：已阅读的官方公开源码、声明文件或本地项目源码直接支持。
- **Binary-observed**：官方发行产物静态提取所得的代码、schema、类型与内嵌说明支持；不等同于实际执行成功。
- **Runtime-observed（本地）**：实际 Bun Worker/VM 契约测试及本轮构建的 CLI；不能外推为官方运行结果。
- **Runtime-observed（官方）**：官方 `2.1.272` 在隔离配置、loopback API fixture 下的实际模块行为；不是外网真实模型、账户资格或全部官方 Mods 验证。
- **Inference / needs verification**：工程判断、潜在风险、运行效果及未公开的稳定承诺。

讨论帖用作设计背景和发布状态证据，优先级低于匹配版本的实际代码与契约。`anthropics/claude-code#91870` 作者 `poteat` 的 API 标记为 `CONTRIBUTOR`；报告不把这一标签本身当作员工身份认证，也不把讨论中的计划当成稳定承诺。

## 3. 发布时间线与可用状态

### 3.1 时间线

- **2026-09-03**：讨论帖提出 TypeScript Function Hooks、中间件组合、受控副作用和 UI 扩展设计。[S2]
- **2026-09-06**：本地官方 `2.1.263` 对应的包已发布。其二进制包含 Function Hooks 相关代码，说明只搜索 `mod` 文案不足以发现功能。
- **2026-09-09**：原帖更新，将产品命名为 Claude Mods，明确“a mod is just a plugin that uses function hooks”，公开三个内置 Mod 源码，并允许实验用户启用 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`；参考资料面向当时的 v267/v268。[S2]
- **本轮研究时**：官方包仓库 latest 为 `2.1.272`；公开 Mods README 和该二进制仍明确标记 Early Access。[S1][B2]

### 3.2 可以说什么，不能说什么

可以确认：

- 官方已经公开定义、示例和类型契约。
- 当前发行产物具有相应实现与显式实验启用路径。
- 内置功能向 Mod 迁移是官方讨论与源码说明中的方向。

不能确认：

- 已对所有用户默认开放。
- API、插件排序细节、UI 能力具备长期兼容保证。
- 三个内置 Mod 都可以作为独立 Marketplace 插件安装。
- 正式 GA 日期或全部终端、Desktop、Mobile 的行为一致性。

尤其要区分：**内置 Mod 随二进制分发**，不等于**外部 Mod 开发接口已经稳定发布**。

## 4. 核心架构：可组合的引擎中间件

### 4.1 注册与执行分离

模块导出：

```ts
register(on, options)
```

注册 hook：

```ts
on(event, matcher?, ($, e, next) => result)
```

含义：

- `on`：注册器；注册发生在 `$` 完成构造之前。
- `options`：插件 `userConfig` 对应配置；当前激活期间固定，修改配置触发重新加载。
- `$`：引擎能力接口，供 hook 调用外部能力。
- `e`：事件输入；哪些字段可以重写由具体事件契约决定。
- `next(e)`：运行后续 hook 和最终 core 实现。

这不是只能执行“前置/后置通知”的观察者模式，而是可修改输入、包装结果或直接回答的中间件模型。[S3][B2]

```text
输入向内传递
  A.before -> B.before -> core
  A.after  <- B.after  <- result
输出向外返回
```

四种常见模式：

| 模式 | 形态 | 语义 |
| --- | --- | --- |
| 观察 | `return next(e)` | 保留默认行为 |
| 改写输入 | `return next({ ...e, ...changes })` | 下游看到改写后的允许字段 |
| 包装结果 | `const r = await next(e); return transform(r)` | 下游已执行后，再调整结果 |
| 提前回答 | 不调用 `next`，直接返回有效结果 | 下游不执行；具体返回格式依事件而异 |

**关键细节：**普通 hook 每次调用 `next(e)` 都可能重新运行下游及 core。对 `tool.call` 做重试时，不能默认操作幂等。先调用 `next` 再返回 `{ deny }` 也不能撤销已经发生的文件写入或进程执行。

### 4.2 五层执行链

匹配版本类型契约给出的顺序为：

```text
prepend -> user -> append -> builtin -> core
```

- `prepend`：管理员放在用户插件外侧的插件。
- `user`：用户安装或显式加载的插件。
- `append`：管理员放在用户插件内侧的插件。
- `builtin`：随二进制分发的插件。
- `core`：引擎最终实现。

**实现补充**：上述为组织托管场景的概念模型，不宜把 `prepend` / `append` 标签本身当作组织身份凭证。`2.1.272` 在没有 managed settings 的情况下，还会读取 user settings 的同名排序项，为个人自己的插件安排层级；有 managed settings 时，两项由 policy 控制，忽略用户对应值，并限制用户项不能安排 managed 插件。来源、tier 与内容可信性应分别判断。见 `chunk-qzd0dzjf.pretty.js:88`、`chunk-ppqxmmyr.pretty.js:829`、`chunk-s5nh835p.pretty.js:235261`。[B11]

管理员可以在最外侧检查最终结果，也可以在用户插件内侧先处理原始输出。两者用途不同：外侧审计不能阻止内侧用户插件先读取原始数据；内侧脱敏又不代表阻止了用户插件通过其他能力重新读取数据。

`next.to(e, tier)` 提供受限的跨层 continuation：

- `prepend` 可指定 `append`、`builtin`、`core`。
- `append` 可指定 `core`。
- 用户插件不能借此跳过组织层。
- 不等价于随意跳到链中某个插件；仍须遵守同层执行和目标层限制，跳过记录进入 trace。[S3][B3]

讨论中还提出用户层依赖关系影响排序，但具体排序算法仍在演进。可以依赖已确认的五层模型理解系统，不应把讨论中的拓扑排序描述扩展成稳定的所有冲突处理规则。

### 4.3 `$` 是能力接口，也是观察副作用的入口

`2.1.272` 的核心接口包含下列能力组，具体方法以生成类型为准：

| 能力组 | 典型用途 |
| --- | --- |
| `tool`、`command`、`agent`、`mcp` | 注册/调用工具或命令，接入代理和 MCP |
| `prompt`、`model`、`session` | 提示词、模型、会话信息与生命周期 |
| `ui` | pane、绘制、状态、toast、交互 |
| `fs`、`http`、`process` | 文件、网络和宿主命令 |
| `store`、`clock` | 跨会话状态、计时和后台任务 |
| `settings`、`env` | 配置与显式环境变量访问 |

运行环境不直接提供 DOM/Node 能力，外部操作通过 `$` 暴露。公开讨论描述了 Worker 与 VM 隔离；本轮二进制也观察到插件环境创建时禁用字符串/wasm 动态代码生成的 VM 配置，但**没有进行逃逸测试，不据此宣称安全沙箱已验证**。[S2][B2][B7]

这套设计的目标不是默认禁止所有高风险能力，而是让插件访问能力可以被注册检查、上层 hook 和组织策略观察与约束。

### 4.4 `engine.create`：插件可以增加能力接口

`engine.create` 是构造 `$` 的特殊折叠过程。hook 此时拿到的 `$` 为空，必须通过 `await next(e)` 获取下层已构造的接口。

一个 step 可以：

- 添加新的能力组，例如 `telemetry`。
- 隐藏某个已有能力组。
- 不能替换其他 step 已添加的能力组；冲突导致该 step 失败并卸载插件、重新构造 `$`。

官方 telemetry Mod 的实现可概括为：

```ts
on('engine.create', async ($, e, next) => {
  const beneath = await next(e)
  const telemetry = /* 基于 beneath 提供的能力构造 */
  return { ...beneath, telemetry }
})
```

以上是结构示意，不是完整可运行代码。实际实现见 [S6]。

由此可见，Mods 不仅扩展 Claude Code，也允许插件之间通过声明合并共享带类型的能力接口。

## 5. 功能面与实际边界

### 5.1 工具与模型

事件覆盖 `tool.call`、工具描述/注册、命令、skills、agents、模型回合等。

- 工具调用输入、结果可以在契约允许范围内被转换。
- `tool.call` 可以返回 `{ result, context? }` 或 `{ deny }`。
- `tool`、`tool_use_id`、`agentId` 等保留字段不能随意重写。
- `$.tool.register` 注册工具后，以 `mcp__<plugin>__<name>` 命名对模型暴露，再通过 `tool.call` hook 提供实现。[B2][B3]

**版本陷阱：**早期讨论示例常用 `e.input.command`，而 `2.1.272` 的 `ToolCallInput` 把工具参数铺在顶层，Bash 使用 `e.command`。不应混用两代 API。

`turn.step` 是特殊的流式事件：hook 必须是 async generator，`yield* next(e)` 转发下游流，或者逐块转换后 yield。已经输出的 chunk 不能回收；流中途失败的恢复不能被理解为“撤销之前所有输出”。[B2][B3]

### 5.2 UI：不是任意 React 注入

`ui.render` 接收组件、surface、props 和 viewport 等信息，返回 plain-data 渲染树。

元素构造器来自：

```ts
const { Box, Text } = $.ui.resolve(e)
```

支持组件级包装、props 调整、pane、按钮和其他交互；但有两个重要限制：

1. **元素和 props 按 surface 约束。** Terminal、Desktop、Mobile 并非拥有相同组件；例如 terminal 有 `Raster`，没有 `Svg`。无效树会被拒绝并回退到引擎绘制，同时记录错误。
2. **权限批准对话框由引擎独占绘制。** 不能把能包装 `AskUserQuestion` 推导成能接管权限审批；可通过 `$.ui.notice` 在相关对话框下增加信息。[S3][B2][B3]

因此，Mods 更接近“被显式开放的 UI 扩展点”，而不是允许插件拿到整棵内部 React 树。

### 5.3 后台工作、状态与生命周期

- `session.start` 在会话准备好后触发，首轮 prompt 前会等待相关启动处理。
- `$.clock.after/every` 支持超出单次 dispatch 生命周期的任务。
- `$.prompt.submit` 可在会话空闲时提交 prompt。
- `$.store` 保存跨会话 JSON 状态。
- 开发模式保存文件会热重载，`register` 在新环境重跑，旧环境计时器被清理。
- `next.signal` 表示当前 dispatch 已被放弃或取消；相关请求和任务应跟随停止，但不能把 AbortSignal 当作已发生副作用的回滚机制。[B2][B3]

## 6. 三个官方内置 Mod 说明了什么

### 6.1 `diff`：完整交互功能可以迁移到 Mod

它实现 `/diff` 的差异 pane/dialog，包括：

- 文件列表与 hunks、比较基线和历史回合视图。
- 编辑、shell 命令、回合完成后的刷新。
- 首次成功编辑时按终端宽度和用户选择自动打开。
- 滚动、焦点和按键交互。
- 将某个文件的 hunks 一次性附加到下一条 prompt。

涉及 `session.start`、`ui.render`、`command.run`、`tool.call`、`turn.complete`、`prompt.submit` 等，证明其用途不止简单 hook。[S4]

注意：源码说明如果会话已存在其他 `/diff` 命令，该插件可能保持 idle；不能仅凭执行了加载命令就断定 UI 已由此 Mod 接管。

### 6.2 `sec-default`：保留组织原有控制边界

这个 Mod 不是新安全策略集合，而是防止用户 Mod 改写组织原本掌握的配置和策略：

- 传统 hooks。
- 托管提示词与规则相关事件。
- settings 读取。
- 托管工具、命令、agent 的描述和提供来源。
- 已配置 MCP allowlist 时，用户层新增工具的行为。

实现主要是跨过 user 层、按调用来源拒绝或正常继续。

默认出现在有 managed settings 或 Team/Enterprise 组织的环境外层；如果管理员显式配置 `prependPlugins`，该列表成为完整 prepend 层，需要自己决定是否包含 `sec-default@builtin`。把它用 `--plugin-dir` 作为用户插件加载，不会得到托管层的 `next.to` 权限。[S5]

它并不默认禁止所有 `fs/http/process/ui` 操作，也不应被描述为通用 DLP 或所有插件行为的自动合规保证。

### 6.3 `telemetry`：通过 Mod 增加公共能力接口

它在 `engine.create` 增加 `$.telemetry.log/mark`，基于下层 `session`、`http` 和 `env` 实现。

具体限制：

- 尊重禁用 telemetry/nonessential traffic/do-not-track 等开关。
- 第三方 provider、自定义 OAuth 环境等条件下不发送。
- 每次调用重新检查环境和授权。
- 不接受任意自由文本属性；属性值受约束。
- README 说明其仅在相应内部构建和 analytics 环境自动就位，**不是供用户用 `--plugin-dir` 独立安装的插件**。[S6]

这说明“源码目录结构是完整 plugin”不等于“在任何用户会话都具备所需底层能力”。

## 7. 开发入口与最小结构

### 7.1 实验启用

讨论中公开的方式是：

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

加载正在开发的 Mod：

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /absolute/path/to/my-mod
```

这些是**官方 CLI 的实验开发方式**，本轮没有执行，也不能直接套用于当前本地 `built-claude`。

`2.1.272` 的 user hooks module gate 还会检查：

- 远程开关 `tengu_plugin_hooks_modules`，默认 false；环境变量显式值优先。
- managed `disableAllHooks`。
- `allowManagedHooksOnly` 和用户侧禁用 hooks。
- `--bare` / `CLAUDE_CODE_SIMPLE`。
- `--safe-mode` / `CLAUDE_CODE_SAFE_MODE`。

因此环境变量不是绕过组织策略的万能开关。这里核查的是用户模块加载条件，不代表托管/内置模块的完整准入条件也相同。[B1]

### 7.2 文件结构

```text
my-mod/
├── .claude-plugin/
│   └── plugin.json
└── hooks/
    ├── hooks.json
    └── register.ts
```

`plugin.json` 示例：

```json
{
  "name": "my-mod",
  "version": "0.1.0",
  "description": "A function-hooks development example"
}
```

`hooks/hooks.json`：

```json
{
  "modules": ["./register.ts"]
}
```

路径相对 `hooks.json`。**目标官方 schema 每个 plugin 最多允许一个 hooks module**，不是任意长度的模块数组；模块内部可以按允许的导入规则组织多个源码文件。传统 `hooks` 与 `modules` 可以同时存在。[B4] 本地切片会合并声明文件中的多个入口，不声称这一更宽的入口数量限制与官方一致；可移植插件应使用单入口。

### 7.3 最小示例

下面只演示对 Bash 工具调用的确定性拒绝，以及 hook 失败时的显式回答：

```ts
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  on('tool.call', { tool: 'Bash' }, () => ({
    deny: 'This plugin disables Bash tool calls.',
  })).catch(() => ({
    deny: 'The Bash policy hook failed.',
  }))
}
```

**验证结果：**此示例已使用 `2.1.272` 二进制内嵌类型通过 TypeScript `noEmit` 检查。未运行 `claude plugin validate` 或实际加载。

**边界：**这不是完整命令执行禁令。它不自动覆盖 PowerShell、其他插件的 `$.process.run`、MCP 提供的远程执行或用户直接启动程序。`.catch` 也不保证插件未加载或 catch 自身失效时仍能阻断操作。

### 7.4 推荐开发闭环

在匹配版本的官方 CLI 中：

1. 启用实验功能，使用 `--plugin-dir` 加载可信源码。
2. 执行 `/plugin-types`，从正在运行的版本生成类型。
3. 运行 `claude plugin validate <path>`，检查 manifest、源码可分析性和声明的调用。
4. 用生成类型做静态类型检查。
5. 使用 `claude plugin test <path>` 跑隔离的插件测试。
6. 在测试项目做真实交互，检查 transcript 和 `--debug` 日志。

`validate`、类型检查、插件测试、实际 CLI 行为是四类证据，不能互相替代。

### 7.5 文档与产物存在实际差异

固定公开提交的 `mods/README.md:108` 仍说，外部插件依赖其他 Mod 的能力类型时，需要手工把对方 `types/` 纳入 tsconfig；将来 `/plugin-types` 才会复制这些契约。

而 `2.1.272` 的内嵌说明已经描述：

- `plugin.json` 通过 `"types": "./types/index.d.ts"` 声明契约。
- `/plugin-types` 生成核心、MCP、插件契约三个类型入口。
- 复制已启用插件的契约到 `claude-code-plugins/`。[B2][B3]

这不是运行时已验证的差异，但足以表明**公开仓库快照不必与同版本发行物中的开发说明完全同步**。运行时生成的类型应作为开发基线，升级后重新生成。

## 8. 故障、可观测性与安全判断

### 8.1 默认失败处理不是自动拒绝

当前契约和内嵌开发说明描述：

- hook 抛错、超时或返回无效结构时，默认把该 hook 视为缺席。
- `on(...).catch(handler)` 可以在额外 grace budget 内回答。
- catch 自身失败或超时，hook 仍可能被跳过。
- `engine.create` 失败属于加载失败，不能使用同一 `.catch` 注册方式。
- 流式 hook 的已输出部分不会被撤销。[B2][B3]

这里应区分两类目的：

- **UI/便捷功能：**跳过失败插件可保护 harness 可用性。
- **组织强制策略：**不能只依赖“某个 hook 理论上会拒绝”；必须覆盖准入失败、hook 被跳过、取消和自身依赖失败等情形，并验证托管部署。

这是一项可用性与强约束之间的实质权衡，而不是可以简单贴上全系统 fail-open/fail-closed 标签。

### 8.2 避免重复副作用

**非流式事件**的普通 `next(e)` 每次重新运行下游；而 `.catch` 获得的 `next` 复用执行：

- 原 hook 已调用 next 时，catch 的 next 复用最后启动的下游 Promise，包含成功或失败，不再次执行。
- 尚未调用时，第一次执行一次，后续复用结果。
- 默认失败回退也使用 `inFlight ?? runBelow(originalInput)`；不是 hook 在 next 后抛错就自动再执行 core。

`next.called` 只表示是否发起过下游，不能证明操作完成；`next.error` 提供失败信息，不能替代副作用状态检查。[B3][B13]

**流式例外**：`turn.step` 的 catch 复用仍可继续读取的流，但最后一个下游流已经 reject 时，实现存在重新打开下游流的路径，即便 `called === true`。不能把非流式 replay-safe 描述直接外推为“所有 catch 永不重试下游”。见第 13.5 节。[B13]

对有写入副作用的 hook，仍须明确操作是否执行、是否完成、能否重试；不要把“不重复 next”扩大理解为对插件自行发起的所有副作用提供事务语义。

### 8.3 准入分析与身份边界

`plugin.register` 提供插件的 `tier`、`uses`、名称、版本和来源等信息，允许上层决定是否准入。

当前契约明确区分：

- `tier`、扫描出的 `uses` 是 host 观察结果。
- 名称、版本、路径和 provenance 不是内容可信性的密码学证明；仅按自报名称放行可能被改名绕过。
- `uses` 包含事件模式、`noun.method` 调用列表和环境变量读写名称。
- 静态扫描要求 `on`、`$`、`$.env` 等写法可分析；验证通过不等于业务逻辑或安全策略正确。[B3]

合理的威胁模型是：防止不可信用户层 Mod 干预组织配置或越过组织明确限制的能力。它不能替代操作系统权限、受管部署和插件供应链治理。

### 8.4 可观测性

- transcript 对失败给出一次简短提示，含插件、事件和原因。
- debug log 记录每次发生及拒绝的结构。
- `next.origin` 由 host 标记调用插件和 tier。
- `next.trace` 提供下游链路的时序、输入/输出和状态快照。
- `$.ui.status/log/toast` 可在不发起模型回合的情况下显示状态。[B2][B3]

trace 能帮助定位组合顺序问题，也可能包含敏感输入输出；审计日志不能因为“来自安全插件”就默认适合外传。脱敏应覆盖真实数据流，而不是只隐藏屏幕上某个组件。

## 9. 与已有扩展机制的区别

| 机制 | 主要角色 | 与 Mods 的关系 |
| --- | --- | --- |
| Skills | 给模型的指令、知识和工作流程 | 可与 Mod 一起打包；不等同于引擎中间件 |
| Plugins | 安装、版本、配置、资源和分发容器 | Mod 仍是 Plugin |
| 传统 Hooks | 特定生命周期的外部处理器 | 可继续存在；Function Hooks 可通过 `classic.*` 包装相关路径 |
| MCP | 外部工具/资源协议 | Mod 可接入工具调用；不是另一个 MCP 协议 |
| Agents / Workflows | 委派与任务执行 | Mod 可在相关事件和能力接口参与，但不是执行工作流的别名 |
| Modes | 权限或运行模式选择 | 与 Mod 是不同概念 |
| 修改 CLI 源码 | 改动内部实现 | Mods 用公开扩展点覆盖部分需求，不能保证替代所有源码修改 |

**工程判断：**Mods 的价值在于把部分目前需要 fork 的行为定制，迁移为可分发、可检查、可组合的插件代码。代价是 hook 顺序、版本契约、生命周期和失败处理成为插件作者必须掌握的内容。

## 10. 对当前项目的影响

### 10.1 本地状态

当前项目的 plugin hooks schema：

- `src/utils/plugins/schemas.ts:335`：只声明传统 `hooks`，且为必填。
- `src/commands.ts:271`：内置命令列表包含 plugin/skills 等，没有对应的 `/plugin-types` 入口。
- `src/commands/plugin/index.tsx:3`：现有 `/plugin` 只是既有插件管理入口。

因此官方 Mod 的仅含 `modules` 的 `hooks.json`，**不满足当前 schema**。即使额外补上空 `hooks`，也不代表会发现或执行 TypeScript 模块。

本地 `src/utils/hooks.ts` 虽有名为 `functionHooks` 的局部分组，不能据变量名推导其已经具备本报告中的 Function Hooks engine。

### 10.2 如未来要兼容，应如何划分工作

以下是研究后的工作边界建议，**不是本轮实施计划，也没有修改实现**：

1. 先锁定官方目标版本与生成类型。
2. 完成模块 schema、源码扫描、加载隔离、注册生命周期和诊断。
3. 实现事件 dispatcher、五层链、`next`/`next.to`/trace/catch/cancel 语义。
4. 沿现有 tool、prompt、session、UI 路径逐个接入，并验证权限边界。
5. 最后补齐作者工具和官方示例需要的接口。

优先用一个最小 tool hook 证明加载和分派，再使用 `diff` 这类完整 Mod 验证 UI 和生命周期；`sec-default` 需要单独的托管策略验证，不能用 UI 示例成功替代。

不建议为了追逐早期 API 直接把整个官方 Mod 引擎作为黑盒塞入当前项目，也不建议只添加开关后宣称兼容。

## 11. 静态研究阶段的验证记录

本节保留实施前的证据范围；后续代码、构建与双端交互结果见第 14 节，不能把本节历史状态视为当前完成情况。

### 当时已完成

- 核对官方讨论、固定提交的 Mods 源码/README/类型。
- 核对官方包索引的版本与发布时间。
- `2.1.272` 包 SHA-1 和 SHA-512 integrity 校验通过。
- 提取并检查 `2.1.263` 与 `2.1.272` 的全部 Bun module records，含压缩文本资源。
- 从 `2.1.272` 确认模块 schema、启用 gate、开发说明和类型契约。
- 报告中的最小 hook 示例通过匹配类型的 TypeScript 检查。
- 检查当前项目 schema 和入口差距。
- 追加核查扫描、初次准入、宿主能力检查、reload、普通/流式恢复和工具适配的静态控制流；第 13 节中的测试矩阵仍未执行。

### 当时未执行的验证

- 未实际启用或加载 Mods。
- 未执行官方 `plugin validate` / `plugin test`。
- 未做 tmux、Desktop 或 Mobile 真实交互验证。
- 未测 hook 时延、并发、超时、热更新或恢复行为。
- 未验证 VM/Worker 安全性、逃逸防护或组织策略不可绕过性。
- 未确认 GA 日期、账号开放范围和最终 API 兼容策略。

该阶段没有修改生产代码或执行 `make build`，类型检查仅针对报告示例。后续经批准完成了受限实现、项目类型检查、聚焦测试、正式构建与 tmux 对照，见第 14 节；未执行全仓所有测试。

## 12. Commands / artifacts

### 12.1 本地证据目录

```text
/tmp/claude-mod-research-20260915.mxLjUo/
```

包含官方包元数据、讨论快照、固定提交的公开文件、官方下载产物、提取模块、格式化结果和示例类型检查输入。该目录是临时证据，可能随系统清理而失效；报告中的官方固定链接与哈希用于重建证据。

提取范围：

| 二进制 | 格式 | Module records | JavaScript | 文本/文件资源 | N-API |
| --- | --- | --- | --- | --- | --- |
| `2.1.263` | Mach-O arm64-darwin | 1837 | 1650 | 182 | 5 |
| `2.1.272` | Mach-O arm64-darwin | 1928 | 1736 | 189 | 3 |

项目原始提取器只保存入口 JS 与 N-API；新二进制按 chunk 拆分，因此在临时目录复制提取器，补充 JS、文本和 zstd 资源提取。**没有修改仓库提取脚本**，没有执行提取出的业务 JavaScript。

SHA-256：

```text
本地 official-claude / 2.1.263
 ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9

临时下载的 official-2.1.272
 195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75
```

主要命令类型：

```sh
git rev-parse HEAD
file ./official-claude
bun .claude/skills/claude-source-binary-analysis/scripts/native-extra.mjs \
  ./official-claude <temporary-output>

# 只读访问；GitHub 请求使用本地代理
# gh api repos/anthropics/claude-code/issues/91870
# gh api repos/anthropics/claude-code/contents/mods/README.md?ref=<fixed-commit>

# 报告示例的实际类型检查命令
bun node_modules/typescript/bin/tsc \
  -p /tmp/claude-mod-research-20260915.mxLjUo/example-tsconfig.json \
  --pretty false
```

下载使用 HTTPS `curl` 读取官方 registry 的 `dist.tarball`，随后校验 registry 提供的完整性字段；未运行包管理器安装命令。

### 12.2 Binary-observed 证据索引

下列路径均相对上述临时证据目录：

- **[B1] gate**：`complete-2.1.272/chunk-kyh0ykge.pretty.js:27`；策略调用者 `chunk-5jymzgaf.pretty.js:61`、`chunk-r330g9v1.pretty.js:52`、`chunk-kygdrhbv.pretty.js:120`。
- **[B2] 内嵌开发说明**：`complete-2.1.272/SKILL-25610363.md:13`（模块），`:38`（类型），`:60`（开发/诊断），`:75`（UI），`:103`（后台任务），`:118`（工具注册）。其为产物内文档，不单独证明实现已运行。
- **[B3] 匹配二进制的类型**：`complete-2.1.272/claude-code.d.ts-21b4def3.txt:1`；`:704`（catch/replay），`:1823`（UI），`:5083`（准入），`:7833`（tiers），`:7877`（工具参数），`:7922`（工具结果）。
- **[B4] 模块 schema**：`complete-2.1.272/chunk-hcammc73.pretty.js:4860`。
- **[B5] 新版构建标识**：`complete-2.1.272/cli.pretty.js:115`。
- **[B6] 旧版标识**：`complete-2.1.263/cli.original.js:10`。
- **[B7] 插件环境静态实现**：`complete-2.1.272/chunk-8xczzfk0.pretty.js:6350`、`:6377`。没有验证其安全性。
- **[B8] 源码图与扫描器**：`complete-2.1.272/chunk-ppqxmmyr.pretty.js:169`（转译）、`:227`（真实路径）、`:838`（next.to）、`:920`（事件）、`:964`（env）、`:1836`（导入图限制）、`:1925`（加载声明）。
- **[B9] 宿主加载与准入**：`complete-2.1.272/chunk-s5nh835p.pretty.js:83278`（声明）、`:229123`（模块环境）、`:231913`（能力调用复核）、`:232613`（准入）、`:232995`（初次加载）、`:233192`（reload）、`:234271`（宿主复用）、`:235478`（信任检查）。
- **[B10] 注册期与卸载**：`complete-2.1.272/chunk-8xczzfk0.pretty.js:5838`（catch 注册限制）、`:5861`（on 注册限制）、`:5888`（激活）、`:6213`、`:6255`（释放环境与 timers）。
- **[B11] 层级来源与默认保护模块**：`complete-2.1.272/chunk-qzd0dzjf.pretty.js:23`、`:88`；`chunk-ppqxmmyr.pretty.js:829`；`chunk-s5nh835p.pretty.js:235261`。
- **[B12] 工具执行适配**：`complete-2.1.272/chunk-s5nh835p.pretty.js:96203`、`:97154`（core / managed adapter）、`:97357`（结果转换）、`:194491`（分派入口）、`:195048`（权限）、`:195348`（实际执行）。
- **[B13] 分派与恢复**：`complete-2.1.272/chunk-8xczzfk0.pretty.js:655`（trace）、`:716`、`:844`（预算）、`:887`（next/replay）、`:3392`、`:3539`（catch/回退）、`:3931`、`:4027`（流式）、`:4881`（观察式 create）；`chunk-s5nh835p.pretty.js:46438`（重入）、`:232798`、`:232908`（create 重建）。

## 13. 深入实现核查：加载、准入与恢复

本节为 2026-09-16 实施前的追加静态研究，复用同一份 `2.1.272` 发行物与固定源码证据，不重新查询 registry，也不把前文版本快照更新为新的实时结论。以下仅依据当时仓库与提取代码；后续运行官方原版 CLI 的证据见第 14 节，没有单独执行提取出的业务 JavaScript。

研究结束时仓库 HEAD 已由其他工作推进到 `39a9abd94e33ad2568a3ab916d1dbeacf8b7e4af`；核对与前文 HEAD 的差异仅涉及 `CHANGELOG.md`、`README.md`，本节引用的 `src/`、`Makefile`、`package.json` 未变化。本研究未创建提交。

### 13.1 模块加载不是直接 import 后调用 register

**Binary-observed**：初次加载的关键路径可以简化为：

```text
plugin 发现 / hooks.json / 模式、策略与工作区信任检查
  -> vSn：读取 options、确定 tier、扫描源码与导入图
  -> BAt：建立环境、运行 register、核对实际注册与 scan
  -> Hoe：折叠 engine.create，构造能力接口
  -> OMt / vPr：plugin.register 准入裁决
  -> 发布 admitted 集合、刷新相关缓存
```

证据：`chunk-s5nh835p.pretty.js:83278`、`:229123`、`:232995`、`:235478`。这里的文件路径均相对 `complete-2.1.272/`。[B8][B9]

一个容易误解的顺序是：**初次加载时，模块求值、register 和 engine.create 可以发生在最终准入裁决之前**，不能把 `plugin.register` 描述成“任何插件代码执行前的审批”。实现会先记录 `unadmitted` 环境，宿主能力调用检查调用者及其调用链中是否仍有未准入环境；该检查对 clock 能力有显式例外。重新加载则先用现有可裁决模块检查新声明，再建立新环境。[B9]

源码扫描是运行模型的一部分，而不只是作者命令的 lint：

| 边界 | `2.1.272` 静态实现 |
| --- | --- |
| 导入 | 普通外部模块只允许插件目录内的相对导入，以及空的运行时 `claude-code` 模块；不是任意 npm/Node 包执行环境 |
| 路径 | 既检查相对路径是否出界，也对 `realpath` 结果检查插件目录归属与普通文件类型 |
| 静态导入图资源 | 单文件最多 1 MiB、最多 512 文件、总计最多 8 MiB；这些是该版本内部常量，不是长期兼容承诺 |
| TypeScript / JSX | 经 `Bun.Transpiler` 转换后分析；被入口导入的文件含 top-level await 时有显式拒绝路径 |
| 注册和能力调用 | 事件名、`next.to` 目标层、环境变量名称要求可静态识别；`$` 的 computed/optional member access 等形态会被拒绝 |
| 运行时复核 | 实际注册事件要落在 scan 内；宿主操作必须属于 `scan.calls`，并继续检查 env 名称、被隐藏能力、准入状态和操作参数 |

证据：`chunk-ppqxmmyr.pretty.js:169`、`:189`、`:227`、`:838`、`:920`、`:964`、`:1836`、`:1925`；宿主检查 `chunk-s5nh835p.pretty.js:83061`、`:231913`。[B8][B9]

作者侧还有一个具体限制：不能假设把整个 `$` 传给任意跨文件 helper 都能通过扫描。扫描器对这种传参只跟踪同一文件顶层声明的函数；导入的 helper 接收整个 `$` 时有显式拒绝信息。业务计算可以拆文件，但能力调用边界需要保持可分析，不能仅凭 TypeScript 编译成功推断插件可加载。见 `chunk-ppqxmmyr.pretty.js:1370`。[B8]

**边界**：本轮核查的是上述静态导入图与宿主检查路径。加载器另有动态导入处理，不据此宣称所有动态加载、文件竞态或扫描完整性已经验证；路径检查也不等于已经完成文件系统竞态安全测试。

### 13.2 外部模块与内置模块并非同一执行路径

**Binary-observed**：普通外部模块默认使用共享的 hooks Worker 宿主，每个模块有独立的 environment ID 与 VM context；不是每个插件独占一个 OS 进程。宿主实例保存在 `state.environmentHost`，各次模块加载复用它。二进制携带、能由内置注册表解析的模块还有 native 路径；不能只凭插件自报名称或 tier 推导可以进入 native 路径。[B9]

这给兼容性研究带来两个判断：

1. 内置 `diff` 成功不自动证明外部 `--plugin-dir` 路径成功，需要分别验证扫描、VM 边界与消息传输。
2. 独立 VM 可以分开模块的运行环境，但共享 Worker 仍具有共同的故障域。进程级 CPU/内存故障影响及恢复效果尚未实测。

重新加载也不是简单“先卸载旧版，再 import 新版”：

- 新版本构建失败的部分路径会恢复旧声明和能力隐藏记录，旧版继续加载；错误信息明确包含 `the previous version stays loaded`。
- 新版本被准入策略明确拒绝时，已有版本会被卸载，不沿用上述保留旧版的策略。
- 成功后替换活动集合，旧版进入 `retiring`；通过 enter/leave 计数等待在途调用结束，之后才 unload。卸载时清理旧环境的 timers。
- reload 通过宿主队列串行化，不能用一次裸 `import()` 的缓存失效替代这一生命周期。

证据：`chunk-s5nh835p.pretty.js:228978`、`:229123`、`:234271`、`:233192`、`:233278`；timer 清理 `chunk-8xczzfk0.pretty.js:5929`、`:6213`、`:6255`。[B9][B10]

### 13.3 普通 hook 失败、准入拒绝与保护模块加载失败须分开

前文“hook 失败默认跳过”指普通事件处理失败，**不能扩大为所有加载和组织保护失败都继续放行**。

**Binary-observed**：代码另有 `fSn` / `FMt` 路径。被 `Nx().outermost` 标识的保护模块在声明解析或模块加载阶段失败，会设置用户层暂停标记，后续 user tier 模块不加载，并记录：

```text
hooks module <name> did not load and it guards the user tier:
no user plugin's hooks module loads this session
```

该条件不是“任意 prepend 插件失败”：常规配置计算中 `outermost` 对应被安排就位的 `sec-default@builtin`；也不能外推到所有故障阶段。证据：`chunk-qzd0dzjf.pretty.js:17`、`:23`；`chunk-s5nh835p.pretty.js:82997`、`:232949`、`:233004`、`:233070`、`:233088`。[B9][B11]

`plugin.register` 拒绝也有专门恢复路径：已参与 `engine.create` 的模块若随后被拒绝，会重新构建集合，不继续使用包含其能力扩展的旧结果。宿主还会在实际能力调用时检查能力是否被 withholding，避免只从当前 `$` 对象移除属性、却遗漏先前捕获的接口路径。[B9]

**Inference / needs verification**：最合理的验收单位不是“fail-open 或 fail-closed”标签，而是故障矩阵：普通 hook、catch、加载、准入、能力构建、reload、Worker 故障分别测试，并检查副作用是否已发生、旧版本是否继续服务、用户层是否暂停和日志是否可解释。

### 13.4 tool.call 包裹的是执行管线，不只是 Tool.call 方法

**Binary-observed**：官方工具入口 `tPs` 先构造顶层参数事件，再通过 `wCn(...).tool.call` 分派；其 core 最终回到原工具执行管线。核心路径仍包含 schema、`validateInput`、传统 `PreToolUse`、权限判定、批准后参数检查和实际 `Tool.call`，并非在完成权限审批后才让 Mod 任意替换输入。[B12]

```text
tPs -> function-hooks tool.call
          -> managed adapter / core adapter
          -> oPs：输入校验、传统 hook、权限、实际工具执行
       <- 结果校验、传统 managed PostToolUse 协调、模型消息转换
```

这里还有专门的 `managedPass` 与执行记录：用于传递已运行的托管前置处理、关联实际 core 结果和消息，在 Mod 提前回答、转换结果或已经执行后再返回 deny 时选择对应的输出路径。`nxn` 会区分原工具结果与 Mod 合成结果，并在需要重新构造结果消息的路径上应用工具的 `outputSchema`（若存在）。因此，“接管工具结果”也不是随意把任意 JSON 塞回模型。[B12]

关键位置：

- `chunk-s5nh835p.pretty.js:194491`：工具事件适配入口。
- `:96203`、`:97154`：core 与 managed adapter。
- `:194790`、`:194873`、`:195048`、`:195226`、`:195348`：校验、传统 hooks、权限、批准后参数校验与执行。
- `:97357`：结果与消息的协调。

**Inference / needs verification**：本地如果只包装 `Tool.call()`，Mod 改写输入时权限判定可能已经针对旧输入完成；如果把整条管线放到 next 下，却忽略 managed adapter 与结果协调，又可能改变传统托管 hooks 的顺序或运行次数。最小兼容实验必须把这些作为明确的未兼容项或实现范围，不能把“一个 Bash deny 示例成功”作为工具权限兼容验收。

### 13.5 分派与恢复的几个非显然细节

以下为 **Binary-observed**，不是实测结果。[B13]

| 问题 | 静态控制流给出的答案 |
| --- | --- |
| 普通 next 是否 memoize | 否；每次新建下游调用。默认回退与 catch 才复用最后启动的 `inFlight` |
| 下游错误是否当作本 hook 失败后跳过 | 非超时情况下会记录 `belowRejected`；没有有效 catch 回答时传播记录的下游错误，不盲目重新运行。并发 next 下该状态随完成回调变化，不能当作完整错误来源历史 |
| 10 秒 budget 是否等于整个 dispatch 最多 10 秒 | 否；默认 hook budget 为 10,000 ms，下游执行期间暂停自身计时；catch 默认 1,000 ms grace，等待已有下游 settle 发生在其 grace timer 创建之前 |
| 超时是否杀掉原 Promise | 否；先 abort hook signal，另有 overrun/取消宽限处理，不能由 timeout 推导副作用已停止或回滚 |
| 流式 catch 是否绝不重开下游 | 否；`P()` 不选择已经抛错的最后一个流，catch 使用 `P() ?? ce(...)`，其中 `ce` 新建下游流。已 yield 的 chunks 不撤回 |
| next.to 是否跳过同层后续 hooks | 否；只排除起止 tier 严格之间的层，同层剩余 hooks 和目标层仍参与；沿当前 descent 累计跳层限制 |
| trace 是否是所有 next 的完整历史 | 否；指向最后启动的下游分支，收集已完成链节。host 侧 received/returned 可为引用，进入 VM 时另有复制；浅冻结不等于全量深拷贝快照 |
| 重入是否禁止全部嵌套事件 | 否；按 origin 排除插件或具体 registration，其他匹配 hook 仍可执行 |

关键实现：`chunk-8xczzfk0.pretty.js:887`（普通调用/replay）、`:3392`（catch）、`:3539`（失败回退）、`:4008`（流状态/catch）、`:655`（trace）、`:686`（层级跳过）；宿主重入过滤 `chunk-s5nh835p.pretty.js:46438`。

`engine.create` 另有整组 fold 重跑：失败插件被移除后，幸存模块的 create hooks 可能再次执行，这与普通事件失败后保留下游 Promise 不是同一机制。观察式 glob hook 还有只记录失败并传递下层接口的例外。另发现一个待验证疑点：拒绝 `engine.create.catch` 的内嵌文案称该事件“无 budget”，但已读分派路径未找到明确预算豁免；不据文案宣称其永不超时。见 `chunk-s5nh835p.pretty.js:232798`、`:232908`，`chunk-8xczzfk0.pretty.js:4881`、`:5853`。[B13]

### 13.6 当前项目的真实接入面

以下为 **Source-confirmed（改动前基线）**，行号用于解释原始接入面；本轮实施状态另见第 14 节：

| 路径 | 当前行为与研究结论 |
| --- | --- |
| `src/utils/plugins/pluginLoader.ts:1224` | hooks JSON 校验后只返回 `.hooks`；除了 schema，还需建立模块描述的数据传递路径。补空 hooks 不会加载 module |
| `src/utils/plugins/loadPluginHooks.ts:91` | 启用插件被转换为传统 matcher，最后替换全局传统 hooks；现有缓存和 policy 热更新不等于模块源码热重载 |
| `src/utils/plugins/refresh.ts:74`、`:153` | refresh 已有清缓存、更新 AppState、重装传统 hooks 的流程，可作为独立 Mods 生命周期的衔接点 |
| `src/services/tools/toolExecution.ts:601` | 工具主管线：schema `:617` → validateInput `:685` → PreToolUse `:802` → permission `:926` → 最终输入 → call `:1212` |
| `src/Tool.ts:366`、`:424` | 本地工具返回以 `data` 为核心的 `ToolResult`，不能把官方 `{result}` 原样强转；必须经过现有结果映射、截断与消息归属流程 |
| `src/services/tools/toolOrchestration.ts:91`、`src/services/tools/StreamingToolExecutor.ts:76` | 两种 scheduler 都在 hooks 执行前根据原工具/输入决定并发性；Mod 改输入或自行发起副作用后，原判断未必仍成立 |
| `src/utils/sessionStart.ts:35` | 可复用会话准备流程，但新 module 求值/注册前就需处理策略与 workspace trust，不应等事件发出后才检查 |
| `src/utils/gracefulShutdown.ts:510`、`:536` | 退出先 cleanup 再 SessionEnd，而 clear 路径有不同顺序；不能假定统一的“SessionEnd 后销毁”生命周期 |

**工程取舍**：有两条不同路线，不应混称兼容。

1. **受限实验**：在 `tool.call()` 周围加一个只能原样 next / deny 的受信任模块试验，禁止输入改写，不覆盖完整分派语义。代码改动较少，但审批时机、提前回答、重复 next 和托管适配与官方不同，只能证明局部可接入；本轮不建议把它作为对外兼容接口。
2. **目标版本兼容切片**：先完成模块描述、扫描/隔离/准入生命周期和普通 dispatcher，再围绕整个工具执行管线提供官方事件适配，保留实际输入校验、权限、传统 managed hooks 和结果协调。首阶段只交付明确列出的工具事件，不承诺 UI、模型流或全部官方 Mods 可运行。这条路线更符合当前“研究是否可兼容”的目的，但边界必须由真实测试确认。

不建议为了减少接入工作，偷偷把普通 next 改成只执行一次、把所有失败改成拒绝、允许权限后任意改写参数，或向模块暴露原始 `Tool.call` 和可修改的权限上下文。这些都会改变契约或原有执行边界。

### 13.7 后续验收应覆盖什么

以下是研究阶段提出的 **建议测试矩阵**。用户随后批准生命周期与普通工具切片实施；矩阵包含不在首批范围内的模型流，已运行和未覆盖项须以第 14 节记录为准：

| 类别 | 最低证据 |
| --- | --- |
| 发现与准入 | modules-only、传统 hooks-only、共存；未信任/禁用时不得求值外部模块；扫描拒绝、准入拒绝和默认保护模块加载失败各有诊断 |
| 普通分派 | 两次主动 next 的 core 计数为两次；一次 next 后 hook 抛错，自动回退不增加计数；catch 前后、无效输出与保留字段改写分别覆盖 |
| 权限 | 改写后的实际执行参数仍经原权限路径；deny/ask/取消不被短路伪造批准；区分 Mod 合成结果与真正执行工具，保留 managed hooks 顺序与结果校验 |
| 并发 | 两种 scheduler、输入改变后并发分类、额外副作用、乱序完成、取消和执行中 reload；结果不能串 tool_use_id 或跨 generation |
| 生命周期 | 重复初始化、成功热更、构建失败保留旧版、准入拒绝卸载旧版、clear/resume/退出；旧在途调用与 timer 清理有证据 |
| 模型流 | 首 chunk 前/后失败、下游 reject 后 catch 重开、取消与流结束；同时记录 chunk 序列和实际模型请求次数 |
| 可观测性 | transcript、debug、trace 能区分未执行、执行中、已执行但包装失败、旧版继续服务、用户层暂停；避免将 trace 原始数据外传 |

现有 `src/utils/plugins/refresh.test.ts`、`src/query.test.ts`、`src/utils/hooks/execPromptHook.test.ts` 可作回归底座，但其中部分路径 mock 了 hooks 或没有真正成功调用工具，不能单独证明 Mods 兼容。后续单测使用 `bun test <相关测试文件>`；`Makefile:21` 的 `make test` 实际是启动交互 CLI，不是单测命令。涉及实现后还需 `make build`，以及匹配版本官方/本地运行验证。

## 14. 生命周期、能力注入与兼容切片实施

### 14.1 官方契约与本地所有权模型

**Binary-observed**：目标 `2.1.272` 的 `claude-code.d.ts-21b4def3.txt:3083` 将 `session.start` 定义为进程内每 activation 一次，首次 prompt 前等待，明确 **Not `/clear`**；`:5869` 规定等待异步 register、丢弃其返回值。不得据此发明 register-return disposer 或 `session.end` 作者协议。

`chunk-s5nh835p.pretty.js:229123` 的 enter/leave 引用计数区分 retiring 与 unloaded；`:233188` 的单模块 reload 区分技术失败留旧与准入拒绝卸旧。**不能将单模块结论推广到 `/reload-plugins` 全量路径**：本轮真实对照观察到官方显式 reload 在源码无效时移除了旧 activation，watcher 路径则保留旧版（见 14.6）。能力 fold 的 add/withhold/not-replace 约束见目标类型 `:2790–2814`、`:3172–3177`。

本地按四类真实所有者实现，不将 runtime 或 RPC 句柄放进 AppState/LoadedPlugin：

| 所有者 | 资源与结束条件 |
| --- | --- |
| host runtime | Worker、串行 reconcile、活动集合与能力表；宿主退出后释放 |
| activation | 固定声明/options、VM、注册、provider 方法、timer/waits；退休且引用归零后释放 |
| dispatch / batch snapshot | 固定 generation；调用完成或 batch release 后释放 |
| conversation binding | cwd、surface、interactive、sessionId；clear/resume 更新绑定，不重新 register/start |

初载路径为声明/扫描 → VM register → engine.create → 准入 → 发布 → session.start barrier。reload 构建错误重建旧能力表，不仅恢复旧 hooks；拒绝、禁用与移除则撤去旧 activation。`src/services/mods/runtime.ts` 和真实 Worker 测试实现上述本地契约。

### 14.2 在途能力与解除的关键区别

不能仅删除 `$` 属性撤权，也不能用“owner 仍 active”判断旧引用是否合法：consumer 可能没有换代，但 provider 已换代。

本地为每次 hook 注入能力记录执行租约；已进入调用继续使用固定能力表，已结束调用留下的旧能力则与当前表复核。timer callback 通过 Worker→host→Worker 的 callback handle 进入宿主引用计数，并持有全部 provider generation，直到异步 continuation 完成。`session.start` 虽只选择新 activation 的 hooks，其能力 snapshot 仍必须包含全部 admitted providers。

真实回归测试分别覆盖：自身 reload 中的 next；未换代 consumer 调用旧 provider；已结束 consumer 捕获引用在 provider 移除后报 withdrawn；timer 已进入后移除自身；session.start timer 在 provider reload 后继续旧方法。仅覆盖 timer wait 而没有覆盖 callback 的 await 链，会在这些情况下过早卸载环境。

本地退休边界是停止未来 after/every tick，保留已进入的 continuation/sleep；不无限接受退休 activation 的新 timer。**该精确 timer 边界仍是本地设计，不是已经完成官方动态对照的事实。**

### 14.3 首批接口及明确限制

已实现基础层：

- `hooks/hooks.json` 的 modules-only、hooks-only、共存和入口描述传递。
- TS/JS 静态相对导入、空 `claude-code` 运行时模块、异步 register、固定 options。
- exact `engine.create`、`plugin.register`、`session.start`、普通 `tool.call`、clock 事件；字面量 primitive equality matcher。
- ordinary next/catch、预算暂停、取消、保留字段、受限 next.to、exact next.is。
- core clock 的 add/withhold/not-replace fold、跨 VM callable noun；新 noun 的第一个 object 参数即事件 input，改写值传给 provider，结果通过 `{ value } | { deny }`。
- generation snapshot、技术失败留旧、拒绝卸旧、in-flight retire、Worker 死亡不重放 core、一次自动重建及失败后的手动 reload。
- 信任后懒加载、首次 prompt barrier、配置/模块依赖热更、显式刷新、clear/resume 绑定轮换、退出时先关闭 watcher 再释放运行环境。
- `tool.call` 在完整权限主管线外接入；两套 scheduler 固定批次 generation，存在 Mod 工具 hook 时保守串行，无 Mod 时保留原并发判断，不使用跨 Agent 的全局锁。

本地可从上文单入口布局开始，用 `./built-claude --dangerously-skip-permissions --plugin-dir /absolute/path/to/my-mod` 加载**可信**插件（沿用本项目交互验证约定，该 flag 跳过普通权限审批）。本地切片不要求官方实验环境变量，也未实现官方 `plugin test` / `/plugin-types` 的完整开发工具链；不要把官方开发闭环描述当成本地已支持命令。

明确不支持或不宣称 parity：UI/render、turn.step/模型流、远端 surface、完整官方测试 CLI、全部内置 Mods；`$.tool.call/register`、动态 command、fs/http/process/env；动态或 npm/native 导入；glob/复杂 matcher；通用 capability alias；noun 多参数或 scalar 首参数；敏感 userConfig 存储；完整官方 trace 字段和 registration 级重入过滤。

扫描的受限语法会明确拒绝，不用不安全主线程 import 兜底。声明按真实文件快照执行，验证 realpath/lexical root、普通文件以及 1 MiB/file、512 files、8 MiB graph。Worker/VM **不是 OS 安全沙箱**；Bun 1.3.14 裸 VM 的 ShadowRealm 可触发 native crash，按官方边界移除非契约 globals 后可行性实验通过，不能据此证明不可逃逸。

### 14.4 Managed tool adapter 的兼容阻塞

目标适配顺序不仅是“Mod 包住工具”：managed-only PreToolUse → 普通 Mod → next 内的 non-managed Pre/permission/tool/non-managed Post → managed-only Post 对最终结果和 context 分别处理。Mod 合成结果仍要经过 managed policy，主动 N 次 next 不应把外层 managed pass 也重复 N 次。

**Source-confirmed（本地缺口）**：`src/utils/hooks.ts` 与 `src/services/tools/toolHooks.ts` 只暴露合并后的 hooks 路径，没有每调用 managed-only / managed-excluded；`src/types/hooks.ts` 仍只有 MCP 专用 output rewrite。仅修改普通 adapter 会重复 policy hooks，或让合成结果跳过 policy。

因此首批不能宣称 managed adapter parity；有相关托管策略但无法运行目标保护链时，应明确阻止不受支持的外部 Mod 组合，保持原传统工具/hook 管线，而不是悄悄弱化保护。目标证据：`chunk-s5nh835p.pretty.js:91503–91505`、`:96923–97435`、`:195657–195681`、`:270994–271017`。

### 14.5 验证进度与证据边界

本地验证已完成：

| 检查 | 实际结果 |
| --- | --- |
| `bun test src/services/mods src/services/tools/toolExecution.test.ts src/services/tools/toolOrchestration.test.ts src/utils/plugins/pluginModules.test.ts src/utils/plugins/refresh.test.ts` | **203 pass / 0 fail / 433 assertions，11 files** |
| query、传统 prompt hooks、SSH shutdown、agent listing 四个回归文件 | **41 pass / 0 fail / 119 assertions** |
| `bun node_modules/typescript/bin/tsc --noEmit --pretty false` | exit 0，无错误 |
| Mods 目录、两个构建脚本与改动的既有集成文件 ESLint | exit 0；既有集成文件 16 warnings，与 HEAD 对照一致，未新增 |
| `bun src/services/plugins/pluginOperations.test.ts` | passed；保留原卸载错误及资源清理回归 |
| `git diff --check` | exit 0 |
| `make build` | 成功生成 `built-claude`，版本仍为 Makefile 的 `2.1.219` |

最终复核日志位于 `/tmp/bun-worker-vm-gate.OrDUk6/`：`mods-final-focused.log`、`mods-final-regression.log`、`mods-final-typecheck.log`、`mods-final-eslint.log`。`mods-final-eslint-comparison.json` 逐条比对 HEAD 的规则、级别和警告文本，确认 16 项均为既有警告。最终构建日志为 `mods-toggle-build.log`；后续验收复用本任务该次构建，未重复构建或覆盖制品。

工具测试包含真实 Worker 输入改写再进入权限路径、schema/mapper、提前合成、执行后 deny、progress、contextModifier、UUID、大结果持久化和两套 scheduler 的固定 generation。测试中使用受控工具/权限函数不能替代真实 CLI 的 ask 交互，也不能证明复杂 Agent/Workflow 全部组合兼容。

Worker 额外使用事件循环 ping/pong watchdog：未响应约 5 秒时终止整个共享 Worker，但不会因为正常异步 Promise 很长就终止。同步死循环失败测试和自动恢复失败后手动 reload 测试均已通过。这是本地可解释的运行边界，不宣称其时限与官方一致。

可行性实验位于 `/tmp/bun-worker-vm-gate.OrDUk6/`：独立 compiled Worker 双入口在移走源码、cwd=/ 后成功加载。正式 CLI 另用下述 tmux 证据验证，不以临时 gate 替代。

### 14.6 真实编译产物与官方对照

首轮合格证据根目录：`/tmp/claude-mods-validation-20260916.x9hE98/`。完整结果在 `report.txt`、`assertions-final.json`；以下相对证据路径均相对此根目录。

| 运行对象 | 实际产物及身份 |
| --- | --- |
| 本地 | 项目 `built-claude`，`2.1.219`；SHA-256 `30ea4e1e668397fbacf6e90bdb326cfd9d03267350ba9abf2c48039bb5878a13` |
| 官方 | `/tmp/claude-mod-research-20260915.mxLjUo/official-2.1.272`，`2.1.272`；SHA-256 `195e24e8e1f9bf46f1eaee72d434a33e18f9f5796f29a6348a00d16c5f8aee75` |
| 本地 tmux | `cc-mods-local-qualified-20260916-x9hE98:0.0`，pane `%692`，exit 0 |
| 官方 tmux | `cc-mods-official-qualified-20260916-x9hE98:0.0`，pane `%693`，exit 0 |

两侧终端均为 160×50，以 `--dangerously-skip-permissions --plugin-dir … --model claude-sonnet-4-6` 运行；完整 argv/environment 位于每侧 `command.json`。独立 HOME/config/XDG，`env -i`，只复制二进制与自写模块 fixture；sandbox 明确拒读仓库，拒绝非 loopback 网络，两项拒绝的实际探针见每侧 `sandbox-probe.json`。API 为仅监听 `127.0.0.1` 的确定性 fixture，没有真实凭据、外网模型或组织配置。

| Assertion | 本地 / 官方 verdict | 同次运行证据 |
| --- | --- | --- |
| 外部 modules、静态 helper 导入、异步 register、真实 Worker | passed / passed | 每侧 `debug-marker-search.txt`、`02-first-terminal-pane.txt` |
| 首 prompt 在 start 的 4 秒 sleep 结束前提交，工具直到 start 完成才执行；clock.after tick=1 | passed / passed | 每侧 `barrier-precondition.json`、`02-first-terminal-pane.txt`；elapsed 4004/4001ms |
| `/clear` 不重新启动 activation，starts 仍为 1 | passed / passed | 每侧 `05-after-clear-terminal-pane.txt` |
| 仅修改 helper，自动创建 V2 activation，starts=1 | passed / passed | 每侧 `08-after-hot-reload-terminal-pane.txt` |
| watcher 遇到无效源码继续旧 V2 | passed / passed | 每侧 `11-watch-error-terminal-pane.txt` |
| 同样无效源码上显式 `/reload-plugins` 仍保留旧 V2 | passed / failed（行为差异） | 每侧 `14-explicit-error-terminal-pane.txt`；官方实际返回 CORE_FIXTURE |
| `/plugin disable mods-slice-fixture` 移除 activation | failed（已定位并修复，见下） / passed | 每侧 `19-disable-menu-pane.txt`、`20-after-disable-terminal-pane.txt` |
| `disableAllHooks=true` 移除 activation | passed / not covered | `local-qualified/23-disable-all-terminal-pane.txt`；不替代 inline disable 失败 |

首轮本地禁用失败的根因是 loader 将 inline 强制设为 enabled，命令却只检查 editable scopes，导致“already disabled”与运行状态矛盾。已修正 `src/utils/plugins/pluginLoader.ts`、`src/services/plugins/pluginOperations.ts`；`@inline` 的 true/false 不再误走 marketplace。新增隔离真实设置/loader/操作测试覆盖默认启用、裸名与完整 ID、禁用/恢复、local scope override、移除 `--plugin-dir`。修复后的 build SHA-256 为 `946c4c933c9b1ed053bf303149326e6c13351843bf8391ff601f83889366bbfa`，构建日志为 `/tmp/bun-worker-vm-gate.OrDUk6/mods-toggle-build.log`。该制品已通过下述独立本地完整启停序列；不回写首轮失败为通过。

**保留的差异**：本地两种技术 reload 失败均留旧，不为复制官方显式全量 reload 的卸载行为而破坏恢复。官方将部分 start/reload 诊断直接写入对话，本地主要经 stderr/debug 与 Plugins Errors 展示；不宣称 UI parity。

**首轮质量边界**：早期 `local/official/*-barrier` 运行的 sandbox 规则过宽，已排除；`local-strict` readiness 未完成，已排除。官方 qualified 有一次 FINAL pane 计数误超时，未重复提交，通过同次唯一 tool_use_id、debug、terminal pane 确认实际已完成，说明在 `official-qualified/driver-timeout-explanation.txt`。两侧退出后保留 tmux pane，自建 API 服务已停止。首轮文件 hash 对照中，主线程同期更新的本报告是唯一变化，不能声称当时全仓内容完全不变，详见该根目录 `git-final-comparison.json`。

#### 修复后本地完整序列

证据根目录：`/tmp/claude-mods-sequence-20260916.gbTo2l/`。本小节所有相对路径均相对此根目录；`report.txt`、`assertions-final.json`、`result-final.json` 为结果入口。

- 原件与临时副本均为上述 `946c4c93…` 制品；只复制编译二进制，没有项目源码或独立 worker 文件。
- session/pane：`cc-mods-toggle-strict-20260916-gbTo2l:0.0`，pane `%0`，160×50；private socket 为根目录 `tmux.sock`。
- 隔离 HOME/config/XDG、fake key 和 loopback API；仓库拒读、非 loopback 网络拒绝实测通过。真实 `/usr/bin/security` 禁执行，临时 `bin/security` 返回 44 模拟空 Keychain，未读真实凭据。见 `sandbox-probe.json`、`security-stub.json`。
- 启动前完成脚本编译、27 项 preflight 检查和 hash 锁定；8 个输入各一次，单 CLI PID `64219`、单 API PID `64203`，没有重启、补跑、Escape 或手动 reload。见 `preflight-result.json`、`script-lock.json`、`inputs.json`、`lifecycle-summary.json`。

| Assertion | Verdict | 实际结果与证据 |
| --- | --- | --- |
| baseline 真实 Bash | passed | `02-baseline-tool-evidence.json`：starts=1、finished=true、activation=1789504749240、elapsed=1204 |
| disable 写设置并解除新调用链 | passed | `03-disable-settings.json`：`@inline=false`；`04-disabled-tool-evidence.json`：`CORE_FIXTURE` |
| enable 创建新 activation | passed | `05-enable-settings.json`：`@inline=true`；`06-enabled-tool-evidence.json`：starts=1、finished=true、activation=1789504751746、elapsed=1201 |
| enable 后首工具的已观测时序 | passed | `enable-observed-order-timing.json`：start 完成后 309.305ms 才签发工具；**仅为时序观察，不是因果 barrier 证明** |
| `/clear` 不重发 start | passed | `08-cleared-tool-evidence.json` 的 marker 字段与 enabled 完全相同；`enabled-start-events.json`、`cleared-start-events.json` 完全相同 |
| 正常退出及无中断全序列 | passed | `10-terminal-process.txt`：dead=1、exit=0；`lifecycle-summary.json`：全部 8 输入一次且按序 |
| API 在 CLI 退出后停止 | passed | `cleanup.json`：没有额外 CLI 清理动作；API exit=0，原端口 55607 无 listener |
| Git 可见状态与制品身份不变 | passed | `git-hash-comparison.json` 各字段为 true；不覆盖所有 ignored 文件；本报告收尾写入发生于验收之后 |
| enable 时 start 尚未完成便提交输入，证明其被阻塞 | not covered | 未主动制造这一重叠前提；`validation-scope.json` 明确排除，不能用上一行已观测时序替代 |

四个工具 ID 为 `toolu_toggle_gbTo2l_local_{baseline,disabled,enabled,cleared}`，每个均关联同次 API `tool-issued`、真实非错误 `tool_result`、`end_turn`、增量 debug completion、terminal 空 prompt 和进程身份，而不是按 pane 的 FINAL 字样计数。本地 debug 没有假设中的 toolUseId dispatch marker，不将现有组合证据冒称完整内部 trace。

**此轮结论仅为启停/clear/退出完整序列 passed**：范围内 19 条断言 passed，另有 1 条 enable-overlap barrier 为 not covered，不是全 Mods 验收 passed。fixture 在 `clock.sleep(1200)` 后故意抛出 start 诊断，因此也覆盖了受控 hook 失败恢复路径，不能代表所有无异常 start 行为。默认 Esonhugh-Marketplace clone 被隔离网络阻断的噪声与 inline lookup 错误分开记录，见 `noise-classification.json`。

#### 保留的尝试与官方启用观察

旧报告原样保留，不拼接为最终完整序列：

| 证据目录（各目录 `report.txt`） | 资格与原因 |
| --- | --- |
| `/tmp/claude-mods-toggle-20260916.HLcKV7/` | 本地有完整功能结果，但驱动误认菜单、API 停止后续跑；双端未严格串行结束。不是无中断合格整轮，不用于替代上述新序列 |
| `/tmp/claude-mods-toggle-strict-20260916.0ZI8dN/` | harness 禁止真实 security 执行却没有空桩，启动 `posix_spawn 'security'` EPERM、exit=1；零输入/工具。是准备错误，不是 Mods 启停缺陷 |
| `/tmp/claude-mods-toggle-final-20260916.SGI4I0/` | 启停已完成，但断言错误要求 `tool_issued < start_complete`；实际 enable 成功 prompt 出现前 start 已结束。原报告仍 failed，clear 未覆盖；后续只在新根改为准确的时序断言，并单列重叠场景未覆盖 |

**Runtime-observed（官方，受中断实验限制）**：HLcKV7 的官方 `2.1.272` 在 enable 后首工具返回 `starts=1_finished=false_elapsed=0`，随后才记录 start 完成（`official/06-enabled-tool-evidence.json:15`、`official/debug.log:733`）。这是该次菜单关闭触发刷新路径的实际观察，不推广到所有启用/重载路径，也不称合格全流程 parity。官方 enable 删除 `@inline=false` 恢复默认启用，本地写 true；这是存储表示差异，不是 enable 失败。官方菜单关闭自行注入 `/reload-plugins`，本地直接显示成功且 Mod 已生效；两者 UI 仍有差异。

**not covered**：重新启用阶段的重叠输入因果 barrier、真实 CLI ask 审批、managed Pre/Post policy 组合、真实账户和外网模型、复杂 Agent/Workflow、全部官方 Mods/UI/stream、官方精确 timer retire 与能力租约。首轮的首次 prompt barrier、本地自动测试与本轮启停运行是不同证据，不能互相替代。

## Sources

- **[S1] 官方 Mods README，固定提交**：[定义、测试与 Early Access](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/README.md)
- **[S2] 官方仓库设计讨论**：[anthropics/claude-code#91870 — Mods: make Claude 10x more extensible](https://github.com/anthropics/claude-code/issues/91870)
- **[S3] 官方公开类型契约，固定提交**：[mods/types/claude-code.d.ts](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/types/claude-code.d.ts)
- **[S4] diff Mod，固定提交**：[README](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/diff/README.md)；[register.ts](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/diff/hooks/register.ts)
- **[S5] sec-default Mod，固定提交**：[README](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/sec-default/README.md)；[register.ts](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/sec-default/hooks/register.ts)
- **[S6] telemetry Mod，固定提交**：[README](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/telemetry/README.md)；[register.ts](https://github.com/anthropics/claude-code/blob/f96c3b49c4c8721685206aaab23609b2d399df4e/mods/telemetry/hooks/register.ts)
- **[S7] 官方发布包索引**：[@anthropic-ai/claude-code](https://registry.npmjs.org/@anthropic-ai%2fclaude-code)
- **[S8] 本轮下载产物的固定元数据**：[@anthropic-ai/claude-code-darwin-arm64/2.1.272](https://registry.npmjs.org/@anthropic-ai%2fclaude-code-darwin-arm64/2.1.272)

第三方介绍仅用于发现讨论入口，未用作核心结论依据。报告未把讨论中的性能目标、未来计划或社区 bug 报告当作当前版本已验证事实。

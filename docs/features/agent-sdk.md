# Agent SDK 与 stream-json 控制协议

> 英文名：`agent-sdk` · 领域：插件与扩展 · [返回功能索引](README.md)

## 这是什么

[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 让你在自己的 TypeScript / Python 程序里使用 Claude Code：发一个任务，逐条收到 Claude 的思考、工具调用、工具结果和最终结果。SDK 在底层启动 `claude` 进程，用 **stream-json**（一行一个 JSON）和它通信。

本 fork 的 CLI 可以直接作为 SDK 的执行程序，只要把 `pathToClaudeCodeExecutable` 指过来。已用官方 TS SDK 0.3.303 和 Python SDK 验证，并补齐了 SDK 会发的几个控制请求（见下方「和官方的区别」）。

## 快速上手（TypeScript）

```js
import { query } from '@anthropic-ai/claude-agent-sdk'

const run = query({
  prompt: 'List the files here.',
  options: {
    pathToClaudeCodeExecutable: '/path/to/built-claude',
    allowedTools: ['Bash(ls)'],
  },
})
for await (const message of run) {
  if (message.type === 'system') console.log('system', message.subtype, 'model=' + message.model)
  if (message.type === 'assistant')
    for (const block of message.message.content)
      console.log('assistant', block.type, block.type === 'text' ? block.text : `${block.name} ${JSON.stringify(block.input)}`)
  if (message.type === 'user') console.log('tool_result', JSON.stringify(message.message.content[0]?.content).slice(0, 60))
  if (message.type === 'result') console.log('result', message.subtype, `$${message.total_cost_usd.toFixed(4)}`, message.result)
}
```

实际运行输出（本 fork 的 binary，测试用假 API）：

```text
system init model=claude-opus-5-5
assistant tool_use Bash {"command":"ls","description":"list files"}
tool_result "api\nbuild\nnotes.md\nt.txt\ntodo.md\nu.txt\nv.txt\nweb"
assistant text FAKE_DONE
result success $0.0003 FAKE_DONE
```

消息依次是：会话初始化（`system/init`）→ Claude 决定调用工具（`assistant` 里的 `tool_use`）→ 工具结果（`user` 里的 `tool_result`）→ Claude 的回复 → 最终 `result`（含费用）。

## 为什么没有单独的 fork SDK

本 fork 不发布自己的 SDK 包，直接用官方的 `@anthropic-ai/claude-agent-sdk`（TS）和 `claude-agent-sdk`（Python）。原因：

- 官方 SDK 只是启动 CLI 并收发 stream-json。把 `pathToClaudeCodeExecutable`（Python 是 `cli_path`）指向本 fork 的 binary，消息、工具、权限回调、会话管理就都能用。
- fork 独有的功能要么靠设置或环境变量打开，要么是会话里模型自己调用的工具。官方 SDK 已有的 `env`、`settings`、`plugins`、`extraArgs` 选项足以把它们传进去，不需要新的 API。
- 官方 SDK 的许可是 Anthropic 的商业条款（`© Anthropic PBC. All rights reserved`），fork 它的代码再发布有风险，还要一直跟进官方版本。

只有一种情况值得另做一个包：你要在自己的前端渲染 Mods 界面，需要 `ui_*` 控制请求的客户端。协议见 [mods-sdk-client.md](mods-sdk-client.md)。

## 用官方 SDK 打开 fork 功能

| fork 功能 | SDK 选项（TS / Python） | 写法 |
| --- | --- | --- |
| OpenAI / ChatGPT provider | `env` / `env` | `CLAUDE_CODE_USE_OPENAI: '1'`，再加 `OPENAI_API_KEY` 或 `OPENAI_AUTH_TOKEN`，可选 `OPENAI_BASE_URL`。也可以不传凭据，复用 `~/.codex/auth.json`（先在终端 `CLAUDE_CODE_USE_OPENAI=1 claude` 里 `/login` 一次，ChatGPT 账号也行） |
| Daybreak 网络安全档位 | `settings` / `settings`（JSON 字符串） | `{ daybreak: 'blue' }`，可选 `blue` / `red` / `off` |
| SQLite FTS5 记忆检索 | `settings` | `{ memory: { sqlite: { enabled: true } } }`，会话多出 `SearchMemory` 工具 |
| Dynamic Workflow | `settings` | `{ enableWorkflows: true, workflowSizeGuideline: 'small' }`，关闭用 `enableWorkflows: false` |
| Mods | `plugins` / `plugins` | `[{ type: 'local', path: '/abs/path/to/mod' }]` |
| 独立会话通信 | `extraArgs` / `extra_args` | `{ name: 'sdk-worker' }`，其他会话可以用这个名字找到它 |

注意：TS SDK 的 `env` 会**整个替换**子进程环境，要写成 `{ ...process.env, CLAUDE_CODE_USE_OPENAI: '1' }`；Python SDK 的 `env` 是合并到当前环境上。

可运行的示例在 [`examples/agent-sdk/`](../../examples/agent-sdk/)，都通过环境变量 `CLAUDE_FORK_BIN` 找到 binary：

```sh
cd examples/agent-sdk
bun add @anthropic-ai/claude-agent-sdk
CLAUDE_FORK_BIN=/path/to/built-claude bun openai-provider.mjs
```

| 文件 | 演示 |
| --- | --- |
| `basic.mjs` | 最小用法 |
| `openai-provider.mjs` / `openai_provider.py` | OpenAI provider + Daybreak blue |
| `fork-settings.mjs` | 用 `settings` 打开 SQLite 记忆和 Workflow，从 `system/init` 的工具列表确认 |
| `mods-plugin.mjs` + `hello-mod/` | 用 `plugins` 加载一个 Mod，它拒绝 Claude 读取 `.env` |

实际运行输出（官方 TS SDK 0.3.310 / Python SDK 0.2.165，本 fork 重新构建的 binary，测试用假 API）：

```text
$ bun openai-provider.mjs          # OPENAI_BASE_URL 指向假 Responses API
init model=gpt-5.6-sol
result success FAKE_OPENAI_DONE
# 假 API 收到的请求：{"model":"gpt-5.6-sol","access_programs":{"cyber":"daybreak_blue"}}

$ python3 openai_provider.py       # 同上，Python SDK
init model=gpt-5.6-sol
result success FAKE_OPENAI_DONE

$ bun fork-settings.mjs
tools SearchMemory,Workflow        # 去掉 settings 时只有 Workflow

$ bun mods-plugin.mjs
plugins hello-mod,agents-md
tool_result "<tool_use_error>hello-mod: .env files are off limits</tool_use_error>"
result success FAKE_DONE           # 不加载 Mod 时，Read 会返回 .env 的内容
```

用 `extraArgs: { name: 'sdk-worker' }` 启动后，`~/.claude/sessions/<pid>.json` 里有 `"name":"sdk-worker"`、`"entrypoint":"sdk-ts"`，同机其他会话可以按这个名字给它发消息。

## 不用 SDK，直接用 stream-json

任何语言都可以自己启动 CLI 并读写 JSON 行：

```sh
claude -p --input-format stream-json --output-format stream-json --verbose
```

stdin 里除了用户消息，还可以发**控制请求**（`control_request`），例如初始化、切换模型、切换权限模式。依次发送 `initialize`、`reload_skills`、一个非法的 `set_permission_mode` 和一条用户消息，收到的回执：

```text
{"request_id": "r1", "subtype": "success", "keys": ["capabilities", "commands", "agents", "output_style", "available_output_styles", "models", "account", "pid"]}
{"request_id": "r2", "subtype": "success", "keys": ["skills"]}
{"request_id": "r3", "subtype": "error", "error": "Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan"}
result success FAKE_DONE
```

想让工具权限请求交给你的程序决定（SDK 的 `canUseTool`），加 `--permission-prompt-tool stdio`。

## 和官方的区别

- 补齐 SDK 0.3 会调用的控制请求：`reload_skills`、`reload_output_styles`、`read_file`（按 Read 工具的权限判断）、`update_settings`（只接受官方白名单内的设置）、`mcp_read_resource`（只读 `ui://`）。
- 接受 `string[]` 形式的 `systemPrompt`（TS SDK 默认发送 `[""]`）。
- `set_model`、`set_permission_mode` 对非法值返回错误码，而不是静默接受。
- VS Code 插件面板用到的控制请求（`get_status`、`get_usage`、`background_tasks` 等）见 [vscode-extension.md](vscode-extension.md)。
- 接受 SDK 0.3.303 会传的四个隐藏参数（之前会以 `error: unknown option` 退出）：
  - `--session-mirror`（SDK 的 `sessionStore`）：每次写入本地 transcript 后输出一行 `{"type":"transcript_mirror","filePath":...,"entries":[...]}`。
  - `--resume-drops-turn <prompt uuid>`（SDK 的 `resumeDropsTurn`）：配合 `--resume-session-at` 截断恢复时，检查被丢弃的部分只属于这一轮；混入了别的用户消息、排队消息或压缩摘要时，返回 `error_during_execution`，错误以 `Resume rejected by --resume-drops-turn:` 开头。
  - `--managed-settings <json>`（SDK 的 `managedSettings`）：作为 policy 层，只保留限制型设置（`permissions.deny` / `ask`、各类 deny 列表、`allowedMcpServers` 等允许清单、`allowManaged*Only` 等锁）；`model`、`env`、`permissions.allow` 之类会被丢弃。本机已有管理员的 managed settings 时默认忽略它，除非管理员设置 `parentSettingsBehavior: "merge"`。
  - `--project-config-root <绝对路径>`（SDK 的 `projectConfigRoot`）：项目设置、`.mcp.json`、`.claude` 下的 commands / agents / skills / workflows / output-styles 和 hooks 的 `CLAUDE_PROJECT_DIR` 都从这个目录读，而不是工作目录；此时不能改 project 范围的 MCP 配置。
- `tools: ['Read', 'Glob']` 这类限定工具清单会被严格遵守，不再多出 `ListAgents`、`SendMessage`。
- 后台子代理（Agent 工具）的消息会实时流给 SDK，带 `parent_tool_use_id`；同时输出 `task_updated`（任务状态、结束时间等变化）和 `background_tasks_changed`（后台任务清单变化），`task_started` 也带 `subagent_type`、`is_backgrounded`。
- `task_started` / `task_updated` / `task_progress` / `task_notification` 和 `background_tasks_changed` 的每项都带 `run_id`（同一任务 id 重新运行会换新值），`task_started` 也带 `spawn_depth`。
- 后台子代理还在跑时，原回合的 `result` 先暂存，等子代理的 `task_notification` 发出后再输出；之后处理通知的回合再输出第二个 `result`，和官方一致。
- `stop_task` 对不存在或已结束的任务回成功（和官方一致），`task_id` 不是字符串时回错误。
- 尚未实现：`set_mcp_permission_mode_override`。另外后台子代理结束时，本 fork 的 `background_tasks_changed`（空清单）比 `task_notification` 早一条，官方是之后；两者内容相同，只是先后不同。

想把 [Mods](mods.md) 的界面画到自己的前端，见 [mods-sdk-client.md](mods-sdk-client.md)。

## 说明

输出来自实际运行（官方 `@anthropic-ai/claude-agent-sdk` 驱动本 fork 的 binary，模型回复由测试用假 API 生成）。下方「详细说明」保留各控制请求的字段规则、边界与验收记录。

## 详细说明

以下内容自原 README 迁入，保持原文。

### SDK 远程 UI 协议类型与校验

开发客户端协议时，从 `src/entrypoints/sdk/controlTypes.ts` 使用有限的 `SDKControlUIRequest`，并用 `SDKControlUIResponseFor<Request>` 关联回执。18 类客户端请求与 5 类引擎发给客户端的 responder 请求分别为 `SDKControlUIClientRequest` / `SDKControlUILoopRequest`。同名 Zod schema 从 `controlSchemas.ts` 导出；这些是仓库内部协议定义，不是额外的作者 `$` capability。

下面的代码只构造并校验协议数据：

```ts
import type { SDKControlUIRenderRequest, SDKControlUIResponseFor } from './src/entrypoints/sdk/controlTypes.js'
import { SDKControlUIRenderRequestSchema } from './src/entrypoints/sdk/controlSchemas.js'

const request: SDKControlUIRenderRequest = {
  subtype: 'ui_render', surface: 'desktop', component: 'ToolUse',
  instance_id: 'tool-1', props: { input: { command: 'pwd' } }, on_screen: null,
}
const parsed = SDKControlUIRenderRequestSchema().parse(request)
type RenderResponse = SDKControlUIResponseFor<typeof request>
```

绘制回执含 `tree`、`props`、`rewritten` 和 `hooked`，可带插件到 hash 的 `client_modules` 及 `bench`；客户端模块回执另含 entry、runtime、limits 和 files。树通过 handle 传递回调，通过路径传递 Client 模块。pane roster 的三个 nullable ID 和 focus 的 nullable element 都是必填字段；`ui_message.data` 必须存在，`null` 合法。输入校验与绘制、客户端资源及 hook 的运行时语义分别验收。

执行 `make check-mods-control-types` 做独立严格类型检查；`make release-check` 已包含此项。协议回归：

```bash
bun test --no-env-file ./src/entrypoints/sdk/controlSchemas.mods.test.ts ./src/entrypoints/sdk/controlSchemas.ssh.test.ts ./src/services/mods/remoteUiControl.test.ts
```

协议定义覆盖其余远程控制及 system pane/scroll/focus 消息，当前 CLI 接通 `ui_attach` / `ui_detach` / `ui_render` / `ui_press` / `ui_input` / `ui_select` / `ui_client_module` / `ui_client_press` / `ui_message` / `ui_client_fault` 及 `ui_invalidate` 推送；Pane/scroll 的控制与推送见下文专项；元素 focus、prompt 控制和 focus 推送见下文新专项。18类客户端控制有运行入口，五类 responder 尚待完成；23类协议定义不代表23类功能均已验收。完整 UI/diff 继续单独验收。官方原生回执、字段限制与验证范围见[SDK UI 协议专项](../../docs/research/mods-sdk-ui-protocol-292-20261007.md)。


### SDK 动态 MCP stdio 参数

`mcp_set_servers` 中的 stdio 配置应显式填写 `args`；没有命令行参数时也写 `[]`：

```jsonl
{"type":"control_request","request_id":"mcp-1","request":{"subtype":"mcp_set_servers","servers":{"example":{"type":"stdio","command":"node","args":["/absolute/path/server.mjs"]}}}}
{"type":"control_request","request_id":"mcp-remove-1","request":{"subtype":"mcp_set_servers","servers":{}}}
```

省略 `args` 时，在创建连接前返回 `errors.example: "Spread syntax requires ...iterable not be null or undefined"`，与固定官方 2.1.292 一致。控制请求本身仍返回成功回执，并将服务器名称列入 `added`；调用方必须检查 `errors`。失败配置可通过后续空 `servers` 请求移除，移除回执的 `removed` 包含该名称。

本项验收覆盖不存在和存在的命令省略 `args`、完整控制回执、移除及退出。缺失可执行文件的系统错误路径文案仍与官方有差异；完整 MCP、Mods 及 SDK 生命周期继续单独验收。

### SDK MCP 定义来源

查询当前服务器时发送：

```jsonl
{"type":"control_request","request_id":"mcp-status-1","request":{"subtype":"mcp_status"}}
```

`mcpServers[].source` 是可选字符串，表示服务器定义来自何处：SDK 宿主注册的服务器为 `sdk`，插件提供的服务器为 `plugin`，普通配置返回其配置范围（如 `user`、`project`、`local`、`dynamic`）。`scope` 与 `source` 分开：插件和 SDK 服务器可以同属 `dynamic` 范围。读取来源应使用 `source`；服务器名称只是配置键，不能据其名称判定来源。兼容旧 CLI 未返回该字段的状态对象。

SDK 服务器连接成功后，`serverInfo` 来自 MCP initialize 响应的服务器实现信息，包含名称和版本；等待握手完成后再读取。`source: "sdk"` 表示定义来源，连接是否成功仍以 `status` 和实际握手结果为准。

MCP 服务器可在 initialize 响应的 `result.instructions` 中返回使用工具和资源的可选字符串。SDK 宿主也通过同一握手返回；等待连接完成后发送用户请求。非空指令通过 `system-reminder` 消息进入当前模型请求，SDK 与普通连接使用同一路径。字段位置见 MCP 的[初始化规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。

指令默认最多保留 2048 个 UTF-16 单元。`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` 可设置正整数上限，支持前后空格和正号；非法值回退默认值。超长时附加 `… [truncated]`，截断不会留下半个 Unicode 代理对。`--debug-file` 中会记录服务器名称、原始长度和上限。

这条上下文路径按固定官方 2.1.292 对照了 9 个 SDK、3 个 stdio 场景，包括缺省、空、超长、Unicode 边界及有效／无效上限；实际模型请求中的完整指令段和消息位置、状态／移除／结束回执及退出结果一致。本地 stream-json 的磁盘 transcript 仍会过滤此 attachment，恢复后的上下文尚未与官方对齐；上述对照只覆盖新会话的当前请求。磁盘持久化、恢复、重连后的指令变化及完整 MCP/Mods/UI 生命周期继续单独验收。

固定官方 2.1.292 的对照覆盖用户、动态和插件连接失败，以及 SDK 基本和完整 Implementation 元数据的成功握手；这些场景的完整状态、移除和退出回执相同。运行时 mod 注册服务器及完整 MCP/SDK 生命周期继续单独验收。

### SDK 模型切换校验

在 stream-json 会话中发送 `set_model`，并等待相同 `request_id` 的 `control_response`：

```jsonl
{"type":"control_request","request_id":"model-1","request":{"subtype":"set_model","model":"claude-sonnet-4-6"}}
```

自定义模型先用最小 API 请求验证；验证成功才修改会话模型，同一进程的成功结果可复用。验证失败保留原模型，返回具体错误及可选 `error_code`：模型不在 `availableModels` 允许列表为 `restricted_by_org`，网络／可重试服务器失败为 `check_failed`，认证失败为 `auth_failed`，模型不存在为 `catalog_unknown`。`PreModelSwitch` hook 拒绝或要求确认时也会返回不带错误码的失败。普通 API 拒绝可以不带错误码，调用方应始终读取 `error`。错误码在类型定义和 schema 解析中保留。

API 验证的期限为 5 秒，超时会取消请求并返回 `check_failed`；晚到结果不会进入成功缓存。模型切换按接收顺序处理，等待验证期间仍可处理 `interrupt` 等控制消息。紧随 `set_model` 的用户消息在队列中等待验证完成，再使用实际生效的模型；未显式配置 effort 时使用该模型的默认值。验证失败时继续使用原模型。空模型名被拒绝；`default` 使用当前默认模型。通用配置见 Anthropic 的[模型配置文档](https://code.claude.com/docs/en/model-config)。

本项按固定官方 2.1.292 验收受控 API、缓存、错误回执、失败不改模型及等待期间的 `interrupt` 顺序。延迟校验后立即发消息的模型与 effort 已完成三方对照；普通 Sonnet 请求仍省略官方显式发送的 `high`，保留为请求形状差异。成功切换后的压缩状态来源见下节；远程 Mods 提示仍与官方不同。组织目录／授权覆盖、模型切换 Hook、`system_prompt` 和完整 SDK 生命周期仍需独立对齐与验收。

### SDK 权限模式切换

在 stream-json 会话中发送 `set_permission_mode`：

```jsonl
{"type":"control_request","request_id":"mode-1","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
```

切换与 Shift+Tab、`/yolo` 走同一闸门（bypass 策略与可用性、auto 闸门、plan 可用性）。失败时保留原模式，返回错误及 `error_code`，例如未知模式为 `invalid_mode`，bypass 被策略停用为 `bypass_disabled`，未以 bypass 启动为 `bypass_not_launched`，auto 设置不允许为 `auto_mode_settings`；完整取值见 `src/entrypoints/sdk/controlTypes.ts`。

`canUseTool` 回调返回 allow 时可省略 `updatedInput`，此时使用原始输入；格式错误的结果以说明预期格式的消息拒绝。

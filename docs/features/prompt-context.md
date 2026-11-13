# Prompt context 与 Tool search

<!-- lang: zh-Hans -->

> 英文名：`prompt-context` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 这是什么

每次 Claude 回答你，发给模型的不只是你那句话，还有一大段「背景」：系统提示词、所有工具的说明、可用的子代理和 skill 列表、MCP 工具列表、项目指令等。这些背景越大，**每次请求越贵、越慢**，长会话也越早触发压缩。

本 fork 在这几处做了优化，你不需要配置，开箱即生效：

1. **提示词分层**：把很少变化的部分（核心说明）放前面，经常变的部分（当前任务相关）放后面，这样前面那段能被模型的缓存（prompt cache）反复命中，只付一次全价。
2. **工具按需加载（tool search）**：MCP 工具不再一开始就把完整说明全部塞进请求，只告诉模型「有这些工具」，真要用时再通过 `ToolSearch` 加载说明。
3. **同类工具汇总**：同一个 MCP server 有 4 个以上待加载的工具时，只发一行汇总而不是逐个列名字。实测 26 个同前缀工具的列表从约 935 token 降到约 64 token。
4. **子代理列表增量发送**：可用 agent 的列表只在变化时补发差异，不每轮重发。

<details lang="en"><summary>English</summary>

> Name: `prompt-context` · Area: Context and memory · [Back to index](README.md)

## What it is

Each time Claude answers, the model receives more than your message: a large block of background with the system prompt, descriptions of every tool, the available subagents and skills, MCP tools, project instructions and so on. The bigger that background, **the slower and more expensive every request**, and the sooner a long session hits compaction.

This fork optimises several of these; nothing to configure, it works out of the box:

1. **Layered prompt**: the parts that rarely change (core instructions) go first and the parts that change often (task-specific) go last, so the front stays in the model's prompt cache and is paid at full price only once.
2. **Tools loaded on demand (tool search)**: MCP tools no longer send their full descriptions up front; the model is only told the tools exist and loads the details through `ToolSearch` when it needs them.
3. **Summaries for tool families**: when one MCP server has 4 or more tools waiting to load, one summary line is sent instead of each name. In testing, a list of 26 tools with the same prefix went from about 935 tokens to about 64.
4. **Incremental subagent list**: the list of available agents is re-sent only as a diff when it changes, not every turn.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`prompt-context` · 領域：上下文與記憶 · [返回功能索引](README.md)

## 這是什麼

每次 Claude 回答你，發給模型的不只是你那句話，還有一大段「背景」：系統提示詞、所有工具的說明、可用的子代理和 skill 列表、MCP 工具列表、專案指令等。這些背景越大，**每次請求越貴、越慢**，長會話也越早觸發壓縮。

本 fork 在這幾處做了最佳化，你不需要配置，開箱即生效：

1. **提示詞分層**：把很少變化的部分（核心說明）放前面，經常變的部分（當前任務相關）放後面，這樣前面那段能被模型的快取（prompt cache）反覆命中，只付一次全價。
2. **工具按需載入（tool search）**：MCP 工具不再一開始就把完整說明全部塞進請求，只告訴模型「有這些工具」，真要用時再通過 `ToolSearch` 載入說明。
3. **同類工具彙總**：同一個 MCP server 有 4 個以上待載入的工具時，只發一行彙總而不是逐個列名字。實測 26 個同字首工具的列表從約 935 token 降到約 64 token。
4. **子代理列表增量傳送**：可用 agent 的列表只在變化時補發差異，不每輪重發。

</details>

## 看看效果

接一个提供 40 个工具的 MCP server，然后运行 `/context`：MCP 工具一栏标着 `loaded on-demand`，它们**不占用上下文**（上方各类别里没有 MCP 这一项），只有用到时才计入：

![MCP 工具按需加载](images/prompt-context-deferred.png)

`/context` 上半部分的方块图是当前上下文的占用情况，右侧按类别列出：系统提示词、系统工具、skill、剩余空间、为自动压缩预留的缓冲区。想知道「为什么这次请求这么多 token」时先看这里。

## 用自建网关时

`ANTHROPIC_BASE_URL` 指向非 Anthropic 地址（例如公司网关）时，tool search 和直连一样开启：发送 beta header 和 `defer_loading`，并且从第一个请求起附带一个隐藏的 `DeferredToolPlaceholder` 工具，加载新工具时不会让提示词缓存失效。

网关拒绝 tool search（返回 400/422）时，会自动去掉 deferred 工具重送一次，所有工具直接内联；重送成功或错误点名 tool search beta 后，本进程后续请求不再使用 tool search（与官方 2.1.311 一致）。想从一开始就避开这次被拒的请求，设置 `ENABLE_TOOL_SEARCH=false`。

网关后面跑的不是 Claude 模型（模型名不含 `claude`/`opus`/`sonnet`/`haiku`/`fable`，例如 `grok-4.7`）且没设置 `ENABLE_TOOL_SEARCH` 时，tool search 默认关闭，所有工具直接内联。只有 Anthropic API 会把 `tool_reference` 展开成工具定义，这类网关展开不了，模型加载工具后只会看到 `Tool loaded.`、拿不到参数。网关确实能展开时，设置 `ENABLE_TOOL_SEARCH=true` 重新打开。

## 系统提示词精简

本 fork 的系统提示词比官方短，规则内容不变：

- 环境段去掉 "Claude Code is available as a CLI…" 一行；`-p`/SDK 会话不出现 Fast mode 提示。
- Memory 段改为更短的写法（2,079 → 1,614 字符），记忆提取 prompt 共用同一组文字。
- OpenAI 路径与非 lean 模型的完整提示词去掉外部版 `# Output efficiency`。
- skill 描述上限与官方相同为 1536 字符，见 [Skills](skills.md)。

## 设置

| 配置项 | 写法 | 说明 |
| --- | --- | --- |
| `ENABLE_TOOL_SEARCH` | `false` | 关闭 tool search，所有工具内联发送（网关不支持 `defer_loading` 时使用） |
| `ENABLE_TOOL_SEARCH` | `true` | 网关后的非 Claude 模型也使用 tool search |

## 说明

画面来自实际运行（全屏渲染，110×40），MCP server 是测试用的小脚本（`jira_action_1` … `grafana_action_20` 共 40 个工具）；`10/1m tokens` 这行的用量来自测试用假 API 的回报值，不代表真实计数。各项优化的 token 对比数据见 [`docs/research/prompt-context-optimization.md`](../research/prompt-context-optimization.md)。

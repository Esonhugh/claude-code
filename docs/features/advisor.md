# Advisor 顾问模型（实验性）

<!-- lang: zh-Hans -->

> 英文名：`advisor` · 领域：模型与 Provider · [返回功能索引](README.md)

## 这是什么

Advisor 让主模型在关键节点向另一个模型请教：动手之前、卡住的时候、准备收尾的时候。主模型调用 `advisor` 工具，整段对话交给顾问模型，顾问给出建议后主模型继续干活。常见搭配是便宜的模型当主模型、强的模型当顾问。

这个功能**默认关闭**。只有启动前设置了 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1`，客户端才会使用 advisor；不设时请求里没有任何与 advisor 有关的内容，`/advisor` 命令也不出现。打开后，请求先使用服务端的 advisor 工具；接口不能运行它时，由客户端自己向顾问模型发请求代为回答（本地 advisor）。行为和文案对照官方 2.1.325 的 advisor 实现，不同之处见文末[与官方的差异](#与官方的差异)。

<details lang="en"><summary>English</summary>

> Name: `advisor` · Area: Models and providers · [Back to index](README.md)

## What it is

The advisor lets the main model consult another model at key moments: before it starts, when it is stuck, and before it wraps up. The main model calls the `advisor` tool, the conversation is handed to the advisor model, and the main model carries on with the advice. A common setup is a cheaper main model with a stronger advisor.

It is **off by default**. The client uses the advisor only when `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` is set before start; without it, requests carry nothing advisor-related and the `/advisor` command does not appear. With it, requests use the server-side advisor tool first; when the endpoint cannot run it, the client asks the advisor model itself and returns the answer (the local advisor). Behaviour and wording follow the official 2.1.325 advisor; the differences are listed under "与官方的差异" at the end.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`advisor` · 領域：模型與 Provider · [返回功能索引](README.md)

## 這是什麼

Advisor 讓主模型在關鍵節點向另一個模型請教：動手之前、卡住的時候、準備收尾的時候。主模型呼叫 `advisor` 工具，整段對話交給顧問模型，顧問給出建議後主模型繼續做事。常見搭配是便宜的模型當主模型、強的模型當顧問。

這個功能**預設關閉**。只有啟動前設定了 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1`，客戶端才會使用 advisor；不設時請求裡沒有任何與 advisor 有關的內容，`/advisor` 指令也不出現。開啟後，請求先使用伺服端的 advisor 工具；介面不能執行它時，由客戶端自己向顧問模型發請求代為回答（本地 advisor）。行為和文案對照官方 2.1.325 的 advisor 實作，不同之處見文末「与官方的差异」。

</details>

## 快速上手

**1. 打开开关。** 启动前设置环境变量，或者写进设置文件的 `env`：

```json
{ "env": { "CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL": "1" } }
```

**2. 选一个顾问模型。** 输入 `/advisor` 打开选择框，或者直接带参数：

```text
/advisor opus        用 Opus 当顾问
/advisor Opus 5.5    用网关的模型名
/advisor off         关掉
```

选择框列出的模型和 `/model` 列出的一样（不含其中的 Default 一项），最后是 `No advisor`。下面是在一个自定义网关上的实际画面：

```text
  Advisor (experimental)

  When Claude needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without
  progress — it escalates to the advisor model for guidance, then resumes. The advisor uses additional tokens.

    1.  Opus                          Grok-4.7 · Best for everyday, complex tasks
    2.  Fable                         Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50
                                      per Mtok
    3.  Sonnet                        Grok-4.7 · Efficient for routine tasks
    4.  DeepSeek-V4.1-Flash           Custom Haiku model
    5.  gpt-6.2-sol                   From gateway
  ❯ 6.  Opus 5.5 ✔                    From gateway
    7.  GLM-5.3-Flash                 From gateway
    8.  gpt-5.6-terra                 From gateway
    9.  gpt-6.2-astra                 From gateway
  ↓ 10. Opus 5                        From gateway
```

选择会写进用户设置的 `advisorModel`，以后的会话都生效；也可以直接在 `settings.json` 里写 `"advisorModel": "opus"`。只想在这一次启动时用，可以加启动参数 `--advisor opus`（`--help` 里不列出），它不改设置。

在 `-p` 模式下，`/advisor` 不带参数时输出当前设置和用法，带参数时和上面一样。

**3. 照常工作。** 顾问生效时，启动后底部会提示 `Advisor Tool (experimental) is on and may use more tokens · /advisor`。主模型请教顾问时，对话里是这样的：

```text
⏺ Advising using Opus 5.5
  ⎿  ✔ Advisor has reviewed the conversation and will apply the feedback (ctrl+o to expand)
```

按 `Ctrl+O` 可以看顾问的原话。

## 对话里会看到的状态

| 显示 | 含义 |
| --- | --- |
| `Advising using <模型>` | 正在请教服务端顾问 |
| `✔ Advisor has reviewed the conversation and will apply the feedback` | 顾问给了建议，`Ctrl+O` 展开全文 |
| `Advisor declined to advise on this request` | 顾问拒绝回答这一次请求 |
| `Advisor unavailable (<原因>)` | 这一次没请教成，原因是 `overloaded`、`too_many_requests`、`max_uses_exceeded`、`prompt_too_long`、`execution_time_exceeded`、`unavailable` 之一，其他情况显示 `unknown`；主模型照常继续 |

## 哪些模型可以搭配

没有限制：`availableModels` 允许的任何模型都可以给任何主模型当顾问，子代理也一样。设置了 `availableModels` 时，不在名单里的模型不能当顾问。服务端仍然可能不接受某种搭配，这时由本地 advisor 回答（见[服务端拒绝时](#服务端拒绝时)）。

- `/advisor` 接受别名 `fable`、`opus`、`sonnet`，也接受 `/model` 列出的名字和任意模型名。在这个构建里 `opus` 是 Opus 5.5，`sonnet` 是 Sonnet 5.5，`fable` 是 Fable 5.1。
- 输入的名字不区分大小写地匹配 `/model` 列出的名字（`/advisor opus 5.5` 保存为 `Opus 5.5`）和别名；都匹配不上时按输入保存，交互界面里会先向接口发一个最小请求确认这个模型存在，不存在时显示 `Invalid advisor model: … · model not changed`。

`--advisor` 在启动时检查一遍：

| 情况 | 结果 |
| --- | --- |
| 没有设置 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | 警告并继续，不使用顾问：`Warning: --advisor is ignored because the advisor is off. Set CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1 to turn it on.` |
| 给的模型不在 `availableModels` 里 | 报错退出：`Error: The model "<模型>" cannot be used as an advisor.` |

后台会话两种情况都只写进调试日志。

## 对话中途开关

- 主模型不是 Claude 3、Opus 4.7 及更早的 Claude 4 系列（含 Haiku 4.5、Sonnet 4.5、Sonnet 4.6）或 Sonnet 5 时（网关自己的模型名算作支持），`/advisor <模型>` 和 `/advisor off` 在当前对话里立刻生效，服务端顾问通过对话中途的工具变更加入或移除。
- 当前对话已经在用服务端顾问时，换成另一个顾问模型不会立刻生效：当前对话继续用原来的顾问，到 `/clear` 或 `/compact` 之后才换。`/advisor` 的输出会说明这一点。
- 上面列出的几个主模型，或者服务端不接受这种中途变更时：当前对话开始时没有顾问，之后选上的顾问从下一次请求起由本地 advisor 回答；当前对话已经在用服务端顾问时，关掉或换模型从 `/clear`、`/compact` 或新对话开始生效。

## 本地 advisor

有些接口不运行服务端的 advisor 工具：带顾问的请求被拒绝，或者模型发出的 advisor 调用得不到结果（[#1388](https://github.com/Esonhugh/claude-code/issues/1388)）。这时客户端代为完成：`advisor` 是客户端自己执行的普通工具，主模型调用它时，客户端向顾问模型单独发一个请求，把回复作为工具结果交回主模型。官方客户端没有这个做法。

打开开关并选了顾问后，下面几种情况由本地 advisor 回答：

- 接入方式不是 Anthropic API（Bedrock、Vertex、Foundry、OpenAI 模式），或者设了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`：从第一次请求起。
- 带服务端顾问的请求被拒绝，包括按 Anthropic 报错格式的拒绝（见[服务端拒绝时](#服务端拒绝时)）和别的措辞的 400 或 422（例如网关解析不了这个请求）。客户端去掉服务端顾问、换上本地的 `advisor` 工具把这次请求重发一遍；重发成功，当前对话之后的请求都由本地 advisor 回答，到 `/clear` 或 `/compact` 为止。别的措辞的报错重发仍然失败时，照常显示报错，服务端顾问不变。`prompt is too long` 和计费类的报错不重发。
- 当前对话开始时没有选顾问，之后才选上，而主模型不支持[对话中途开关](#对话中途开关)。
- 接口接受了带服务端顾问的请求，但模型发回的是一次普通的 `advisor` 工具调用（[#1388](https://github.com/Esonhugh/claude-code/issues/1388) 里的一种表现）：这次调用由本地 advisor 回答。

接口一直不支持服务端顾问时，每个新对话、每次 `/compact` 之后和每个子代理的第一次请求都会多发一次失败的请求。另设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 可以让所有请求都只用本地 advisor（这个变量同时关掉其他实验性 beta 标识）。

```text
❯ /advisor Opus 5.5
  ⎿  Advisor set to Opus 5.5

⏺ Does a 30-line bash script need set -euo pipefail, or is that overkill at that size?

⏺ Advisor
  ⎿  ✔ Advisor (Opus 5.5) has reviewed the conversation and will apply the feedback (ctrl+o to expand)
```

由本地 advisor 回答时和服务端顾问的不同：

| 项 | 本地 advisor |
| --- | --- |
| 请求 | 不挂服务端工具，工具列表里多一个普通的 `advisor` 工具；没选顾问时不带。顾问自己的那个请求不带 `advisor-tool-2026-03-01` |
| 接入方式 | 不限于 Anthropic API。顾问请求发往当前会话的接口，用同一套凭据 |
| 开关生效 | `/advisor` 的开、关、换模型从下一次请求起生效，不需要 `/clear`。当前对话已经在用服务端顾问时，仍按[对话中途开关](#对话中途开关)的规则 |
| 顾问看到的内容 | 一份文字记录：项目说明（CLAUDE.md 等）、用户的请求、主模型的回复、工具调用和结果，以及主模型在这次调用前刚写的话。不含系统提示词和思考内容。超过顾问模型的上下文窗口时，保留开头和最近的部分 |
| 顾问能做什么 | 没有工具，只给建议 |
| 费用 | 每次调用是一个独立请求，不使用 prompt cache，用量记在顾问模型名下 |
| 失败时 | 顾问请求失败后最多重试 2 次（`CLAUDE_CODE_MAX_RETRIES` 更小时按它），仍然失败时主模型收到一条说明原因的工具错误，然后继续工作 |
| 子代理 | 前台子代理的工具列表包含 `advisor` 或继承全部工具时可以调用；后台子代理没有这个工具。`/btw` 这类从主对话分出去的请求调用时得到“不可用” |

主模型在调用前写下的那句话就是它向顾问提的问题，所以工具本身没有参数。按 ctrl+o 可以看到建议全文。

## 费用

顾问会多用 token。服务端顾问的用量按顾问模型的价格计入会话费用；本地 advisor 的每次调用是一个单独的请求，同样记在顾问模型名下。

## 在哪些情况下可用

| 情况 | 服务端顾问 | 本地 advisor |
| --- | --- | --- |
| 没有设置 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` | 不用 | 不用 |
| Anthropic API（Claude 模式），包括设置了 `ANTHROPIC_BASE_URL` 的自定义网关 | 先用 | 服务端顾问用不了时 |
| Bedrock、Vertex、Foundry、OpenAI 模式（包括 ChatGPT 登录） | 不用 | 用 |

## 使用自定义网关时请注意

打开开关后，在 Anthropic API 上，即使你没有选顾问，发给模型的请求也会多带 beta 标识：

- 所有请求带 `advisor-tool-2026-03-01`。
- 主对话的请求还带 `mid-conversation-tool-changes-2026-07-01` 和 `mid-conversation-system-2026-04-07`，条件是主模型支持[对话中途开关](#对话中途开关)（模型名不在这个构建的模型表里时也算支持）。子代理的请求按子代理的模型同样判断。

网关不认识这些标识时有两种结果：

- 网关的报错和 Anthropic API 的格式一样（报错里点出 `anthropic-beta` 和被拒的标识）：客户端自动去掉它们重发，这一次启动内不再对这个地址发送。
- 网关的报错是别的格式（例如只说 `unsupported beta flag`）：客户端认不出来，**每一轮都会失败并显示 `API Error: 400 …`**。这时请设置 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`（只用本地 advisor），或者去掉 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` | 打开 advisor。不设时服务端顾问和本地 advisor 都不用，不带上面的 beta 标识，`/advisor` 不出现 |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | 完全关闭，和上一个同时设时以关闭为准 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | 不用服务端顾问，也不带上面的 beta 标识；打开了 advisor 时由本地 advisor 回答 |

## 服务端拒绝时

- 服务端不允许用顾问（组织没有开通、不接受这种搭配等）时，客户端去掉服务端顾问把这一次请求重发一遍，你不会看到报错，本地 advisor 接着回答。组织没有开通时这一次启动内不再带服务端顾问；不认识 advisor 工具类型或 beta 标识时，这一次启动内不再对这个地址带；其他情况只在当前对话里不带。
- 「当前对话」只在主对话 `/clear` 或 `/compact`（包括自动压缩）后结束。子代理自动压缩不算：主对话继续由本地 advisor 回答。此前子代理一压缩，主对话的下一次请求又会带上服务端顾问，多一次被拒绝再重发。
- 服务端不接受对话中途的变更时，客户端改用普通方式重发，顾问照常可用；当前对话之后的开、关按[对话中途开关](#对话中途开关)的最后一条生效。

## 与官方的差异

| 项 | 官方 2.1.325 | 这个构建 |
| --- | --- | --- |
| 开关 | 远程开关下发或设置 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` 时打开（这个变量还跳过等级检查），Anthropic API 上默认关 | 不读远程开关；只有设置了 `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL` 才打开 |
| 可以搭配的模型 | 按模型等级表：主模型要在表里，顾问至少和主模型一样强 | 没有等级表，`availableModels` 允许的任何模型都可以 |
| `/advisor` 的候选 | 按等级表列出能当顾问的模型 | 和 `/model` 列出的一样 |
| 对话开始时没有选顾问 | 在官方地址上按等级预先声明一个延迟加载的顾问，之后选上时不改工具列表 | 不预先声明；之后选上时按[对话中途开关](#对话中途开关)处理，工具列表会变一次（prompt cache 重建一次） |
| `… cannot be used as an advisor when the request model is …` | 直接显示报错，附提示 | 去掉服务端顾问重发，由本地 advisor 回答 |
| 可用范围 | Anthropic API，以及 `anthropicAws`、`anthropicGoogleCloud` 两种接入方式 | 服务端顾问只在 Anthropic API（含自定义 `ANTHROPIC_BASE_URL`）上用；没有后两种接入方式 |
| `fable` 别名 | Fable 5.2 | Fable 5.1 |
| Fable、Mythos 当顾问 | 需要用量额度的 Fable 要先在 `/model` 里同意 | 没有同意流程 |
| 对话中途开关的两个 beta 标识 | 也用于其他功能 | 只为 advisor 发送，并且总是一起发、一起去掉 |
| HIPAA 等受限的组织和会话 | 关闭 advisor | 不判断 |
| 远程（CCR）会话 | 恢复时还原顾问选择 | 不还原 |
| 本地 advisor | 没有 | 服务端顾问用不了时代为回答，见[本地 advisor](#本地-advisor) |

实现细节和完整的差异表见 [`docs/plan/advisor.md`](../plan/advisor.md)。

## 说明

官方行为来自对 2.1.325 的静态阅读，没有用真实账号对照。服务端顾问在 api.anthropic.com 上的行为（包括对话中途开关时发送的内容、不预先声明顾问之后的表现）只用假 API 检查过请求的形状，没有在真实接口上验证。

在一个 Anthropic 格式的自定义网关上，主模型 Opus 5.5，`-p` 运行并录下了发出的请求：

- 不设开关、带 `--advisor`：stderr 显示上面的警告；请求里没有 `advisor` 工具，也没有 advisor 相关的 beta 标识。只设已经去掉的 `CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL=1` 时结果相同。
- 设开关、顾问 Fable 5.2：带服务端顾问的第一次请求得到 422（网关自己的措辞，解析不了请求里的 system 内容）。客户端去掉服务端顾问重发，得到回复；之后的请求带本地的 `advisor` 工具，主模型调用后顾问 Fable 5.2 给出建议。
- 设开关、顾问是网关没有的模型名：同样 422 后重发，重发的请求已经带本地的 `advisor` 工具；主模型调用后，顾问请求发了 3 次（都是 503），主模型收到工具错误后继续回答。
- 设开关并设 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`：第一次请求就带本地的 `advisor` 工具，没有 advisor 相关的 beta 标识，顾问 Fable 5.2 给出建议。

交互界面里的 `/advisor` 选择框、`/advisor opus 5.5`（保存为 `Opus 5.5`）和网关没有的模型名（显示 `Invalid advisor model: …`）也在这个网关上试过。服务端按 Anthropic 的报错格式拒绝之后改由本地 advisor 回答、网关把服务端顾问的调用当成普通工具调用发回、对话中途先后用到两种 advisor、其他接入方式和子代理里的调用，只有假 API 的测试。

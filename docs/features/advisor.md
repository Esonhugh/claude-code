# Advisor 顾问模型（实验性）

<!-- lang: zh-Hans -->

> 英文名：`advisor` · 领域：模型与 Provider · [返回功能索引](README.md)

## 这是什么

Advisor 让主模型在关键节点向一个更强的模型请教：动手之前、卡住的时候、准备收尾的时候。主模型调用服务端的 `advisor` 工具，整段对话会自动转给顾问模型，顾问给出建议后主模型继续干活。常见搭配是 Sonnet 当主模型、Opus 当顾问，日常的步骤走便宜的模型，难的判断交给强的模型。

这个功能在使用 Anthropic API（Claude 模式）时默认可用，但**只有你选了顾问模型之后才会真的调用**。行为和文案对照官方 2.1.325 的 advisor 实现，不同之处见文末[与官方的差异](#与官方的差异)。

<details lang="en"><summary>English</summary>

> Name: `advisor` · Area: Models and providers · [Back to index](README.md)

## What it is

The advisor lets the main model consult a stronger model at key moments: before it starts, when it is stuck, and before it wraps up. The main model calls the server-side `advisor` tool, the whole conversation is forwarded to the advisor model, and the main model carries on with the advice. A common setup is Sonnet as the main model with Opus as the advisor: routine steps run on the cheaper model and the hard calls go to the stronger one.

It is available by default with the Anthropic API (Claude mode), but **nothing is consulted until you pick an advisor model**. Behaviour and wording follow the official 2.1.325 advisor; the differences are listed under "与官方的差异" at the end.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`advisor` · 領域：模型與 Provider · [返回功能索引](README.md)

## 這是什麼

Advisor 讓主模型在關鍵節點向一個更強的模型請教：動手之前、卡住的時候、準備收尾的時候。主模型呼叫伺服端的 `advisor` 工具，整段對話會自動轉給顧問模型，顧問給出建議後主模型繼續做事。常見搭配是 Sonnet 當主模型、Opus 當顧問，日常的步驟走便宜的模型，難的判斷交給強的模型。

這個功能在使用 Anthropic API（Claude 模式）時預設可用，但**只有你選了顧問模型之後才會真的呼叫**。行為和文案對照官方 2.1.325 的 advisor 實作，不同之處見文末「与官方的差异」。

</details>

## 快速上手

**1. 选一个顾问模型。** 输入 `/advisor` 打开选择框，或者直接带参数：

```text
/advisor opus      用 Opus 当顾问
/advisor off       关掉
```

```text
  Advisor (experimental)
  When Claude needs stronger judgment — a complex decision, an ambiguous failure, a problem it's circling without progress — it
  escalates to the advisor model for guidance, then resumes. The advisor runs server-side and uses additional tokens.
    1. Fable 5.1
  ❯ 2. Opus 5.5 ✔
    3. Sonnet 5.5
    4. No advisor
```

选择会写进用户设置的 `advisorModel`，以后的会话都生效；也可以直接在 `settings.json` 里写 `"advisorModel": "opus"`。只想在这一次启动时用，可以加启动参数 `--advisor opus`（`--help` 里不列出），它不改设置。

在 `-p` 模式下，`/advisor` 不带参数时输出当前设置和用法，带参数时和上面一样。

**2. 照常工作。** 顾问生效时，启动后底部会提示 `Advisor Tool (experimental) is on and may use more tokens · /advisor`，之后搭配情况变了会再提示。主模型请教顾问时，对话里是这样的：

```text
⏺ Advising using Opus 5.5
  ⎿  ✔ Advisor has reviewed the conversation and will apply the feedback (ctrl+o to expand)
```

按 `Ctrl+O` 可以看顾问的原话。

## 对话里会看到的状态

| 显示 | 含义 |
| --- | --- |
| `Advising using <模型>` | 正在请教顾问 |
| `✔ Advisor has reviewed the conversation and will apply the feedback` | 顾问给了建议，`Ctrl+O` 展开全文 |
| `Advisor declined to advise on this request` | 顾问拒绝回答这一次请求 |
| `Advisor unavailable (<原因>)` | 这一次没请教成，原因是 `overloaded`、`too_many_requests`、`max_uses_exceeded`、`prompt_too_long`、`execution_time_exceeded`、`unavailable` 之一，其他情况显示 `unknown`；主模型照常继续 |

## 哪些模型可以搭配

顾问至少要和主模型一样强。强弱按下面的等级比较，数字大的更强：

| 等级 | 模型 |
| --- | --- |
| 1 | Haiku 4.5（可以请教顾问，自己不能当顾问） |
| 2 | Sonnet 4.6 |
| 3 | Opus 4.6 |
| 4 | Haiku 5.5、Sonnet 5 |
| 5 | Opus 4.7、Opus 4.8 |
| 6 | Sonnet 5.5 |
| 7 | Opus 5、Opus 5.5 |
| 8 | Fable 5、Mythos 5 |
| 9 | Fable 5.1、Mythos 5.1 |
| 10 | Fable 5.2、Mythos 5.2 |

- `/advisor` 接受别名 `fable`、`opus`、`sonnet`，也接受完整的模型 id。在这个构建里 `opus` 是 Opus 5.5，`sonnet` 是 Sonnet 5.5，`fable` 是 Fable 5.1。
- 不在表里的模型（更老的模型、网关自己的模型名）没有等级：拿它当主模型时顾问不会启用，`/advisor` 会提示 `the current main model (…) does not support the advisor`。
- 顾问比主模型弱时，`/advisor` 提示 `… is less capable than the current main model …, so the advisor will not activate`，底部提示换成 `Advisor will not activate on the main model (advisor is less capable); subagents may still use it …`。
- 设置了 `availableModels` 时，不在名单里的模型不能当顾问。
- 子代理用同一个顾问设置，按子代理自己的模型判断能不能搭配。

`--advisor` 在启动时检查一遍：

| 情况 | 结果 |
| --- | --- |
| 主模型没有等级 | 报错退出：`Error: The model "<主模型>" does not support the advisor tool.` |
| 给的模型不能当顾问 | 报错退出：`Error: The model "<模型>" cannot be used as an advisor.` |
| 顾问比主模型弱 | 只警告并继续：`… (the advisor must be at least as capable as the main model). The advisor will not be used for the main model.` |

## 对话中途开关

- 主模型是 Haiku 5.5、Sonnet 5.5、Opus 4.8、Opus 5、Opus 5.5，或 Fable 5、Mythos 5 系列时，`/advisor <模型>` 和 `/advisor off` 在当前对话里立刻生效。
- 换成另一个顾问模型不会立刻生效：当前对话继续用原来的顾问，到 `/clear` 或 `/compact` 之后才换。`/advisor` 的输出会说明这一点。
- 其他主模型，或者服务端不接受这种中途变更时，开、关、换模型都从 `/clear`、`/compact` 或新对话开始生效。

## 费用

顾问在服务端运行，会多用 token。顾问的用量按顾问模型的价格计入会话费用。

## 在哪些情况下可用

| 情况 | advisor |
| --- | --- |
| Anthropic API（Claude 模式），包括设置了 `ANTHROPIC_BASE_URL` 的自定义网关 | 可用 |
| Bedrock、Vertex、Foundry | 不可用，请求和以前一样 |
| OpenAI 模式（包括 ChatGPT 登录） | 不可用，请求和以前一样 |

不可用时 `/advisor` 命令不出现，`--advisor` 被接受但不起作用。

## 使用自定义网关时请注意

功能可用时，即使你没有选顾问，发给模型的请求也会多带 beta 标识：

- 所有请求带 `advisor-tool-2026-03-01`。
- 主对话的请求还带 `mid-conversation-tool-changes-2026-07-01` 和 `mid-conversation-system-2026-04-07`，条件是主模型属于[对话中途开关](#对话中途开关)列出的那几个，**或者模型名不在这个构建的模型表里**（例如网关自己的模型名）。子代理的请求按子代理的模型同样判断。Haiku 4.5、Sonnet 4.6、Opus 4.7、Sonnet 5 等不带。

网关不认识这些标识时有两种结果：

- 网关的报错和 Anthropic API 的格式一样（报错里点出 `anthropic-beta` 和被拒的标识）：客户端自动去掉它们重发，这一次启动内不再对这个地址发送。你看不到报错，只是第一轮会多发请求（用假 API 实测多发了两次）。
- 网关的报错是别的格式（例如只说 `unsupported beta flag`）：客户端认不出来，**每一轮都会失败并显示 `API Error: 400 …`**。这时请设置 `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` 再启动。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` | 完全关闭：不带上面的 beta 标识，不挂 advisor 工具，`/advisor` 不出现 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` | 同样会关闭 advisor |
| `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1` | 跳过等级检查，任何模型都可以当主模型或顾问（服务端仍可能拒绝） |

## 服务端拒绝时

- 服务端不允许用顾问（组织没有开通、模型不能当顾问等）时，客户端去掉顾问把这一次请求重发一遍，你不会看到报错。按拒绝的原因，之后在当前对话、当前地址或这一次启动内不再带顾问。
- 服务端不接受对话中途的变更时，客户端改用普通方式重发，顾问照常可用；当前对话之后的开、关按[对话中途开关](#对话中途开关)的最后一条生效。
- 报错是 `… cannot be used as an advisor when the request model is …` 时不重发，直接显示报错，后面附 `The configured advisor model is not compatible with this request model — run /advisor to change or disable the advisor`。

## 与官方的差异

| 项 | 官方 2.1.325 | 这个构建 |
| --- | --- | --- |
| 开关 | 由远程开关下发，Anthropic API 上默认关 | 不读远程开关，默认可用 |
| 可用范围 | Anthropic API，以及 `anthropicAws`、`anthropicGoogleCloud` 两种接入方式 | 只有 Anthropic API（含自定义 `ANTHROPIC_BASE_URL`）；没有后两种接入方式 |
| `fable` 别名 | Fable 5.2 | Fable 5.1 |
| Fable、Mythos 当顾问 | 组织用不了时不给等级，也就不列出；需要用量额度的 Fable 要先在 `/model` 里同意 | 不知道组织能不能用，总是给等级；没有同意流程 |
| 对话中途开关的两个 beta 标识 | 也用于其他功能 | 只为 advisor 发送，并且总是一起发、一起去掉 |
| HIPAA 等受限的组织和会话 | 关闭 advisor | 不判断 |
| 远程（CCR）会话 | 恢复时还原顾问选择 | 不还原 |

实现细节和完整的差异表见 [`docs/plan/advisor.md`](../plan/advisor.md)。

## 说明

官方行为来自对 2.1.325 的静态阅读，没有用真实账号对照。上面的画面来自实际运行，模型回复由测试用的假 API 按脚本生成；假 API 只能检查显示和请求的形状，服务端是否接受这些请求（包括对话中途开关时发送的内容）没有验证过。

# Code Mode 一致性验证计划

## 1. 文档状态

- **类型**：验证计划
- **状态**：待执行。Phase 4 和 Phase 3 遗留项提交后开始
- **日期**：2026-11-15
- **对照版本**：官方 2.1.325（`/tmp/cmx` 下的 tgz），本地 `code_mode` 分支
- **关联**：[`code-mode.md`](code-mode.md)、[`research/code-mode-325-20261115.md`](../research/code-mode-325-20261115.md)、[`research/code-mode-compat-20261115.md`](../research/code-mode-compat-20261115.md)

目标是回答一个问题：在模型、hook 作者、用户和 transcript 四个视角下，本地 Code Mode 与官方 2.1.325 哪些一致、哪些有意不同、哪些是缺陷。每一条结论都标明证据等级，缺陷修完后回归。

## 2. 证据等级

| 等级 | 来源 | 能证明什么 |
|---|---|---|
| L1 静态 | 从官方 bundle 抽出的字符串、schema、常量，与本地源码和 `built-claude` 对比 | 文案、schema、常量一致 |
| L2 本地运行 | `built-claude` 连本地 mock API，脚本化的模型回复驱动 | 本地行为符合 L1 推出的官方行为 |
| L3a 官方非 Code Mode 运行 | 官方二进制连同一个 mock API。官方只在 Code Mode 上拒绝自定义 base URL，普通会话可以跑 | 官方如何 resume、渲染、提醒 Code Mode transcript |
| L3b 官方 Code Mode 运行 | 需要官方真正进入 Code Mode，见第 6 节 | 两边运行结果逐项对照 |

本机连不上 `api.anthropic.com`，官方 Code Mode 在 provider 检查就拒绝，所以默认只能做到 L1、L2、L3a。

## 3. 测试工具（先做）

1. **官方字符串抽取脚本** `extract-official.ts`：解包 2.1.325，抽出 REPL/Poll 的 prompt、input schema、错误和提示文案、常量（超时、上限、并发），输出 JSON。不进仓库产物，只进 `/tmp/cmx`。
2. **mock API**：本地 HTTP 服务，按场景文件依次返回 assistant 消息（含 REPL tool_use），把每次收到的请求体存成 JSONL。两边二进制共用。
3. **场景驱动**：tmux 启动二进制，独立 `HOME` 和 `CLAUDE_CONFIG_DIR`，跑完收集 transcript、debug log、请求体。headless 场景用 `-p --output-format stream-json`。
4. **对比报告生成**：把 L1 JSON、请求体、transcript 规整后做 diff，生成一张表。

工具放在 skill `.claude/skills/code-mode-conformance/scripts/`，执行流程见该 skill；证据放 `/tmp/cmx/conformance/`，任何日志写盘前过一遍密钥脱敏。

## 4. 验证维度

### A. 模型看到的接口（L1 + L2）

- 发给 API 的工具：开关打开时只有 REPL、Poll（auto/bypass）、StructuredOutput（print 模式）；每个工具的 name、description、input_schema 与官方逐字段比对。
- REPL prompt：整段与官方逐字 diff，包括工具 TypeScript 声明、MCP server 列表、`repl_working`、后台执行说明。
- system prompt 的 Code Mode 分支：tools 段、memory 段的 `write(path, content)`、Chrome 段。
- 全部文案：隐藏工具报错、import 拒绝、超时、Esc、总时长上限、`(dispatched #N)`、`<event kind="repl-eval">`、context 重置、gate-off resume 提醒、开关不可用的原因。
- 关闭开关时：请求体与 Code Mode 之前的构建（`980cf9fb`）逐字节一致，只允许工作目录、日期这类字段不同。

### B. 脚本运行语义（L2，官方行为来自 L1 推断）

每个场景写成 mock 场景文件，期望值引用官方 chunk 行号。

- 基础：Read、Bash、Glob 在脚本里调用；`Promise.all` 并发；返回值和 `<repl-output>` 格式。
- 状态：变量跨调用保留；超时后丢失（D2 有意不同）并在下次结果里提示；compaction、resume、fork 后重建。
- 限制：import/require、`eval`、`new Function` 被拒；单次 50000 次调用；stop 后 20 次；输出 30000/100000 截断。
- 时间：30 s 默认超时不计工具等待；600000 ms 总上限只在需要确认的模式生效；Esc 中止并取消未返回的工具调用。
- 后台：auto/bypass 下 30 s 转后台；Poll 取回结果和错误；8 个 pending 上限；7200000 ms 墙钟上限；其他模式从不转后台。
- helper：`file`/`write`/`edit`（未读先读再重试）、`$`、`preview` 与官方 d.ts 的语义一致；`$` 缺失的功能列为已知差异。

### C. 权限、hook 与 auto mode（L2）

- default 模式下脚本内 Bash 弹确认，确认框显示的是内层工具和命令。主线程上不带反馈的拒绝会停掉本轮和整个脚本，模型收到 refusal 报告（"The user doesn't want to proceed with this tool use. … The user declined the permission prompt for Bash(…), so the script stopped."，被拒的调用列为 "did not run. The user declined it."）；带反馈的拒绝、子 agent 里的拒绝不停本轮，脚本收到 `{error}` 并继续。
- `Bash(...)`、`Read(...)` 的 allow/deny/ask 规则按内层工具匹配；deny Edit 时 `apply_patch` 一并消失。
- PreToolUse/PostToolUse hook 收到的 `tool_name` 和 `tool_input` 是内层工具；`updatedInput`、block、`updatedToolOutput` 生效。
- auto mode 分类器收到整段 `code`；内层调用仍逐次判定。
- mods 的 tool.call hook 照常触发（D4 有意不同：官方装了这类 mod 会拒绝开启）。

### D. agent 与 teammate（L2）

- 子 agent 定义写 Read/Bash 时拿到 REPL，脚本里只能调定义允许的 primitive；`disallowedTools: [REPL]` 生效。
- 后台子 agent 有 REPL 和 Poll；fork 继承父 agent 的 grant；子 agent 结束释放会话。
- 主线程 `--agent` 的 grant。
- 同进程 teammate：工具池是普通工具，system prompt 不含 Code Mode 文字（D3）。

### E. transcript 互通（L2 + L3a）

- 本地 Code Mode 会话：JSONL 里有 REPL 外壳、`isVirtual` 的内层调用对、`repl-mode` 条目；resume 后模型看到完整 `<repl-output>`。
- 按官方格式手写的 Code Mode transcript fixture：本地开关开/关两种情况下 resume。
- 本地写出的 Code Mode transcript：交给官方二进制 resume（L3a）。抓官方发给 mock 的请求体，确认提醒文案、REPL 外壳的渲染方式与本地一致。
- 关闭开关 resume：两边注入的提醒逐字一致；官方交互界面拒绝 resume 而本地继续，列为已知差异。

### F. 隔离与安全（L2）

威胁模型：脚本由模型写，可能受提示注入影响。要防的是脚本绕过内层调用的权限判定和 hook，直接读写文件、执行命令或访问网络。不防模型通过合法的工具调用做事，那由权限系统负责。

- 逃逸尝试：`constructor.constructor`、原型链取宿主 `Function`、`process`、`globalThis` 枚举、`import()` 计算表达式、`Bun`、`require`、`WebAssembly`、`SharedArrayBuffer`、Error `prepareStackTrace`。
- 跨边界值：工具结果里的 getter、Proxy、超大对象、循环引用；脚本传给工具的非 JSON 值。
- 资源：死循环、深递归、大数组分配、定时器风暴；中断后定时器和 pending 调用都被清理。
- 结论只记录能否绕过权限；不为没有攻击路径的情况加防护。

### G. 稳定性与工程质量

- dev（`bun run`）与 `built-claude` 两种运行方式都跑一遍 B 的核心场景，确认 Blob Worker 在二进制里可用。
- Worker 被杀、工具抛异常、API 限流时，REPL 返回可理解的错误，会话可以继续。
- 受影响模块的测试与 HEAD worktree 对比失败数；`bunx tsc --noEmit`、eslint、`make build`。

## 5. 执行

1. 等 Phase 4 与遗留项提交，记下基准 commit。
2. 一个 agent 做第 3 节工具，提交为 `test(code-mode): conformance harness`。
3. 按维度并行：A+E 一个 agent，B+G 一个，C+D 一个，F 一个。各自只写自己的场景文件和报告片段，不改产品代码。
4. 汇总到 `docs/research/code-mode-conformance-20261115.md`，每行：项 | 官方 | 本地 | 证据等级 | 结论（一致 / 有意不同 / 缺陷）| 位置。
5. 缺陷按影响排序，派给对应模块修，修完重跑该维度和 G。
6. 有意不同的条目写回 `code-mode.md` 的决策和风险段。

## 6. 官方 Code Mode 的实际运行（L3b）

官方要同时满足 firstParty provider、凭证和 GrowthBook gate `tengu_rustling_blossom` 才会进入 Code Mode。决定（2026-11-15）：用本地拦截做 L3b，不改二进制。

做法：

1. 本地起一个 MITM 代理（如 mitmproxy），只为这次运行生成自签 CA。官方进程用 `HTTPS_PROXY` 指向它，`NODE_EXTRA_CA_CERTS` 指向这张 CA。不设 `ANTHROPIC_BASE_URL`，provider 保持 firstParty。
2. 代理把 `api.anthropic.com` 的 Messages 请求转给第 3 节的 mock API，返回同一组场景回复，并存下请求体。
3. GrowthBook 请求由代理返回打开 `tengu_rustling_blossom` 的响应。先从 bundle 确认端点、payload 格式，以及是否有签名或加密；如果响应带签名无法伪造，L3b 停在这一步，记录原因。
4. 凭证用一个假的 API key，只放在这次进程的环境里；`~/.claude/settings.ducc.json` 和真实代理变量都不传给官方进程。
5. 用独立的 `HOME` 和 `CLAUDE_CONFIG_DIR`，跑完删除 CA 私钥、代理配置和临时目录；证据脱敏后留在 `/tmp/cmx/conformance/official/`。

L3b 跑通后，B–E 的场景两边各跑一遍，按请求体、`<repl-output>`、transcript 逐项 diff，证据等级从 L1 推断升为 L3b。

## 7. 完成标准

- A、E 中官方能静态确认的条目全部一致，或已记为有意不同。
- B–D 每个场景都有 L2 结果，与官方推断不符的都有结论。
- F 没有能绕过权限判定的路径。
- G 全部通过，没有相对 HEAD 新增的测试失败。

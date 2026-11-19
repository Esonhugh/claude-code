# 验证维度与场景清单

官方锚点优先用**字符串**定位（`rg -a -o '.{300}<marker>.{300}'`），不要依赖压缩后的函数名，函数名每个版本都会变。2.1.325 的已知位置记在 `docs/research/code-mode-325-20261115.md` 和 `docs/research/code-mode-compat-20261115.md`，换版本时重新定位并更新这两份文档。

## A. 模型看到的接口（L1 + L2）

抽取锚点：`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`、`is only available inside REPL`、`<repl-output`、`repl-eval`、`dispatched #`、`Do not call REPL or Poll`、`isn't available`、`repl_working`、`7200000`、`600000`、`50000`。

- 开关打开时发给 API 的工具：REPL；auto/bypass 下加 Poll；print 模式下加 StructuredOutput。比对每个工具的 name、description、input_schema。
- REPL prompt 整段逐字 diff：工具 TypeScript 声明（官方 d.ts 在 `assets/code-mode-<版本>.bash.d.ts.txt`）、MCP server 列表、`repl_working`、后台执行说明。
- system prompt 的 Code Mode 分支：tools 段、memory 段的 `write(path, content)`、Chrome 段。
- 文案：隐藏工具报错（只针对 CODE_MODE_ONLY_TOOLS，句末有句号）、import 拒绝、超时、Esc、总时长上限、`(dispatched #N)`、`<event kind="repl-eval">`、context 重置、gate-off resume 提醒、开关不可用的原因。
- 关闭开关：请求体与 Code Mode 之前的构建（`980cf9fb`）逐字节一致，只允许工作目录、日期、session id 这类字段不同。规整规则写在 `report.py` 里，每加一条都要说明理由。

## B. 脚本运行语义（L2，L3b 可用时升级）

每个场景一个 `scenarios/B-*.json`，期望值写官方锚点。

- 基础：脚本里调用 Read、Bash、Glob；`Promise.all` 并发；返回值和 `<repl-output>` 格式（`<log>`、`<result>`、`<error>`）。
- 状态：变量跨调用保留；超时后丢失（D2）并在下次结果里提示；compaction、resume、fork 后重建并提示一次。
- 限制：import/require、`eval`、`new Function` 被拒；单次 50000 次调用上限；stop 后 20 次；输出 30000/100000 截断。
- 时间：30 s 超时不计工具等待；600000 ms 总上限只在需要确认的模式生效；Esc 中止并取消未返回的工具调用。
- 后台：auto/bypass 下 30 s 转后台；Poll 取回结果和错误；8 个 pending 上限；7200000 ms 墙钟上限；其他模式从不转后台。
- helper：`file`/`write`/`edit`（未读先读再重试）、`$`、`preview`，语义按官方 d.ts。`$` 缺的功能列为已知差异。

## C. 权限、hook 与 auto mode（L2）

- default 模式下脚本内 Bash 弹确认，确认框显示内层工具和命令；拒绝后脚本收到 `{error}` 并继续。
- `Bash(...)`、`Read(...)` 的 allow/deny/ask 规则按内层工具匹配。
- PreToolUse/PostToolUse hook 的 `tool_name`、`tool_input` 是内层工具；`updatedInput`、block、`updatedToolOutput` 生效。用一个把输入写进文件的 hook 脚本取证。
- auto mode 分类器收到整段 `code`；内层调用仍逐次判定。
- mods 的 tool.call hook 照常触发（D4）。

## D. agent 与 teammate（L2）

- 子 agent 定义写 Read/Bash 时拿到 REPL，脚本里只能调定义允许的 primitive；`disallowedTools: [REPL]` 生效。
- 后台子 agent 有 REPL 和 Poll；fork 继承父 agent 的 grant；子 agent 结束释放 REPL 会话。
- 主线程 `--agent` 的 grant（交互和 `-p` 两条路径都测）。
- 同进程 teammate：工具池是普通工具，system prompt 不含 Code Mode 文字（D3，非 ant 构建）。

## E. transcript 互通（L2 + L3a）

- 本地 Code Mode 会话的 JSONL：REPL 外壳、`isVirtual` 的内层调用对、`repl-mode` 条目（last-wins）；resume 后发给 API 的消息里有完整 `<repl-output>`。
- 按官方格式手写的 fixture（有/无 `repl-mode` 条目两种）：本地开关开、关各 resume 一次。
- 本地写出的 Code Mode transcript 交给官方普通模式 resume（L3a）。官方用 mock 时会因自定义 base URL 拒绝 Code Mode，正好走 gate-off 分支。比对官方请求体里的提醒文案和 REPL 外壳。
- 关闭开关 resume：两边提醒逐字一致；官方交互界面拒绝而本地继续，列为有意不同。

## F. 隔离与安全（L2）

威胁模型：脚本由模型写，可能受提示注入影响。要防的是脚本绕过内层调用的权限判定和 hook，直接读写文件、执行命令或访问网络。模型通过合法工具调用做的事归权限系统管，不在这里。

每个尝试记录：输入、结果、是否拿到宿主能力、结论。

- 逃逸：`this.constructor.constructor('return process')()`、原型链取宿主 `Function`、`globalThis` 枚举、`import()` 计算表达式、`Bun`、`require`、`process.binding`、`WebAssembly`、`SharedArrayBuffer`/`Atomics`、`Error.prepareStackTrace`、`structuredClone` 和 `postMessage` 传递的对象。
- 跨边界值：工具结果里的 getter、Proxy、超大对象、循环引用；脚本传给工具的函数、Symbol、BigInt。
- 资源：死循环、深递归、大数组分配、定时器风暴；中断后定时器和 pending 调用都被清理，下一次运行正常。
- 能拿到 Worker 或宿主的 `process`、`fs`、`fetch` 中任意一个，就记为缺陷，附重现脚本。

## G. 稳定性与工程质量

- dev（`bun run`）与 `built-claude` 都跑一遍 B 的核心场景，确认 Blob Worker 在二进制里可用。
- Worker 被杀、工具抛异常、mock 返回 429/529 时，REPL 返回可理解的错误，会话可以继续。
- 受影响模块的测试：列出 import 了改动模块的测试文件，在 HEAD worktree（`git worktree add --detach`，软链 `node_modules`）和当前工作树各跑一遍，比较每个文件的失败数，只有新增失败算回归。测试按文件单独跑，`mock.module` 会跨文件泄漏。
- `bunx tsc --noEmit`、对改动文件跑 `eslint --quiet`、`make build`。

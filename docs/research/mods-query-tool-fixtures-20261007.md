# Mods 查询与工具执行测试定义修正（2026-10-07）

本批只完善执行型测试的 Tool 定义，不更改生产权限、查询、Worker、取消或 UI 逻辑。提交基于 `cf820b692559a8e512a13e1f883340bd631bade6`，独立候选从该提交构建，完整工作区另行验证。当前所有既有未提交改动保留。

## 根因与更改

`runToolUse` 在实际准入之后调用 `tool.isReadOnly(callInput)`。四类 query fixture 和共享 executor fixture 用不完整对象强转 `Tool`，没有该方法；这使执行提前返回错误、Worker author 返回错误值、取消测试等不到真正的工具启动。更改均使用生产 `buildTool`，补齐 description、prompt、renderToolUseMessage，保留每份 fixture 的 schema、并发性、调用和结果映射。共享 query 工厂回调使用 `Tool['call']`，executor 的可替换 fixture 明确标注 `Tool<typeof inputSchema, {value: string}>`，具体输入按 zod schema 定义；移除上述 `as unknown as Tool`。

本批没有削弱断言、删除用例、添加跳过、放宽超时时限、引入 API key 或修改生产代码。`buildTool` 默认保留写工具分类，由真实工具执行和现有权限 consumer 检验；不在生产路径中把缺失方法静默当作默认值。

## L1 结果与未通过的边界

全部命令使用新的私有 HOME/config/TMP/XDG、空环境、`bun test --no-env-file`，不带用户凭据。每个 gate 保存输入清单、命令、进程组、超时和退出码；结束后源清单不变，自有进程组无残留。

| 门禁 | 独立候选 | 完整工作区 |
| --- | --- | --- |
| query 原始 RED | 113 pass / 7 fail / 580 expect | 118 pass / 7 fail / 621 expect |
| query 定义修正后 | 119 pass / 1 fail / 624 expect | 124 pass / 1 fail / 665 expect |
| 6 文件相邻工具组，executor 修正前 | 173 pass / 15 fail / 2 skip / 678 expect | 191 pass / 15 fail / 2 skip / 705 expect |
| 最终 query + 6 文件工具组 | 307 pass / 1 fail / 2 skip / 1386 expect | 330 pass / 1 fail / 2 skip / 1454 expect |

最终两侧都退出 **1**，不是全绿。唯一失败为 `a turn.step Worker can abort its own stream without a model call or plugin failure`：断言期望 `aborted_streaming`，实际 `model_error`，本批保持其原断言。2 项 skip 是原有官方 native policy 条件，未添加或更改。工具执行共享 fixture 的 15 个失败已消除，query 的 6 个失败已消除；不能用这些专项结果宣布旧 response.md 的 155 文件全量门禁完成。

相关 7 文件：`src/query.mods.test.ts`、`src/services/mods/toolReadOnly.test.ts`、`toolAdapter.test.ts`、`toolHost.test.ts`、`runtimeTools.test.ts`、`src/services/tools/toolHooks.test.ts`、`toolExecution.test.ts`。

## 真实终端调查：主动 abort 仍有差异

固定官方制品 `2.1.292`，SHA-256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`。两份本地制品来自本批新运行的 `make build`，使用私有输出目录；根目录 shared binary 不替换。三份制品串行完成同一真实 stdin 流程：注册即时 `/owned-abort` 命令 → 正常模型回复 → hook yield `OWNED_BEFORE_ABORT` → `await $.turn.abort({turnId:e.turnId})` → yield `OWNED_AFTER_ABORT` → 下一轮正常回复 → `/exit`。保留原生 pane/ANSI/PTY、debug、Ctrl-O transcript 和原始会话日志。

每份制品主 query 请求都是正常 1、自取消 0、恢复 1；另有标题等旁路请求，按请求中的工具目录和最后 case 分离，不能把所有 HTTP 请求都算模型调用。所有制品正常退出 0，Worker 后续 turn 可用，输入 fixture 与 binary 保持原样，私有 CLI/tmux/HTTP 和自有请求线程均清理。

| 观察 | 官方 | 独立候选与工作区 |
| --- | --- | --- |
| 自取消 completion | `reason: aborted`, `isAborted: true` | 相同 |
| completion.answer | BEFORE + AFTER | 只有 BEFORE |
| 最终可见/保存文本 | BEFORE + AFTER | API error `interrupt` |
| 缺少 hook return 的提示 | `turn.step hook skipped: returned the wrong shape (no result)` | 取消路径未收到该提示 |

该 probe 故意复现原测试的 **无 return** generator；这不是完整合法 `turn.step` 返回值范例，不能从它断言合法结果、并发取消、异常取消或不同 abort reason 全部匹配。本地 completion 虽然标为 aborted，query 仍把取消异常落成模型错误，最终 pane/transcript 的行为不同。应继续核对官方合法返回的 stream、取消信号和 engine-backed 分支，再单独修改取消桥；不能只改测试期望或一律吞掉 signal.aborted 下的真实错误。

初次 bind 被执行沙箱拒绝（未启动进程）；官方第二次因日志 `[REDACTED]` 非 JSON 导致 driver 解析失败；第三次混入标题请求并撞到错误的“所有请求为 0”断言。原记录保留，第四次完整观察才用于上表。本地第一轮完整观察可用。driver 对脱敏标记只做解析适配，原始官方日志保持原样。

## 静态检查、构建和精确提交

初次 final release-check 暴露了 buildTool 推断的单参数 call 过窄，不能在后续取消/进度测试中替换为完整 executor 签名（9 个 TS2322）；原失败保留。通过显式 Tool schema/输出类型修正该推断，最终两侧 `*-final2-check` 与 `*-final2-build` 必须 exit0。完整退出码、源码清单和输出 binary SHA-256 保留在对应目录。真实终端使用的先行 `*-build-abort` 制品包含本批最初 query fixture 修正；后续新增 executor fixture 和文档属于测试/文档，生产代码不变，记录分别保存，不把先行制品伪称最终源码构建。

README 给出 fixture 写法，CHANGELOG 与 mods-test 记录准确范围和未通过边界。候选显式暂存本批文件，随后用三方投影核对原始 WIP + 本批补丁等于当前工作区；根 index 只应用候选补丁。AST 逐项证明两文件的 1186 个 expect 调用、129 个测试/describe 注册和 3 个 timer 参数完全不变。签名前检查未涉及文件的 SHA/size/mtime、shared binary 与 `/tmp/claude-502/response.md` 身份，签名后验证 commit blob、父提交、空 index 与剩余原 WIP。未 push，不向已有 Claude 终端发送输入。

## 证据和后续工作

证据根：`/private/tmp/mods-query-tool-fixtures-20261007-xnbc1b94`。关键文件：`before.json`、`before-source/`、各 test/check/build 的 `result.json` 与 `log.txt`、`native-abort-comparison.json`、`native-abort.py`、三侧 `native-*/evidence/`、`official-turn-step-locations.json`、提交前后 preservation/projection/signature proof。

本批关闭执行型 Tool fixture 的不完整定义问题，仍保留 turn.step 主动 abort 差异。全部原生 UI、上下文/类型/Worker 生命周期、官方 diff viewer、G5（Gap 5 插件作者六场景）、旧 response 全量验证和其他共享 WIP 继续属于总目标；不声明 Mods 整体对齐完成。

# Mods 2.1.329 对齐计划

状态（2026-11-20）：已比对官方作者声明和制品注册表；未验收本地运行时。对比起点为 `assets/mods-2.1.303.d.ts.txt`，不是 Makefile 的构建版本。本文不改写 `mods-test.md` 的历史验收记录。

## 固定依据

- 官方包：`@anthropic-ai/claude-code-darwin-arm64@2.1.329`，tarball SHA-1 `e5144d07744735743ff9c4706a7babdef24869ff`。从 `package/claude` 内的 Zstandard 帧解出的声明为 863400 字节，SHA-256 `2844f0e5e0886272ad3736e5282d3c4a9f7a9296d0d7ccb823451aa9dbe7365b`。临时目录不是依赖，重新提取时以内容哈希为准。
- `EngineEventOf` 新增 `tool.offer`、`tool.judge`、`tool.run`、`agent.report`、`session.stop`、`ui.pointer`。`OpEventOf` 新增 `session.info`、`session.machine`、`agent.call`、`agent.limits`、`prompt.paint`、`ui.place`、`ui.cancelNotify`、`theme.set`、`theme.clear`、`process.hookEnv`、`wasm.compile`。两表无删名。内部 `decision.ask`、`flag.value` 不纳入公开契约。
- 新模块 `claude-code/shader` 提供场景、帧、坐标、指针及数学函数，不是 `$` 的全局变量。`ThemeKey` 枚举不变。`ToolCheckResult.decider` 不再声明；`plugin` 标识发出 ask 的插件，不是旧字段的别名。

## 实施顺序与验收条件

| 阶段 | 工作 | 如何判断完成 |
| --- | --- | --- |
| 1. 锁定作者契约 | 复用 `.303` 声明测试方式，先平行保存 `.329` 基线，不直接切换生成器。以 TypeScript 比对模块、公开名称、签名和字段，把结果与本地注册、分发及宿主逐条对应。 | 能重新提取相同哈希；形成区分「仅声明／已实现／已验证／当前界面不支持」的清单，shader 导出不泄入主模块。 |
| 2. 工具和 Agent 生命周期 | 先测 offer、judge、run 三个触发点，再测 `agent.call`、`agent.limits`、`agent.report`、`session.stop`。同步核对 `next.origin`、`tool.check` 的字段与归因。 | 拒绝的调用不进 run，重复 next 不重复执行；不经分类器不进 judge；隐藏工具不等于禁止调用；Stop 不等于 end 或 abort；workflow agent 不误发 report。 |
| 3. 非渲染接口与既有字段 | 核对 session 信息、hook 环境、Wasm、消息分页、AgentInfo、通知调度及取消。先读各宿主现有实现再确定改动。 | 覆盖可选字段缺失、托管宿主与客户端的区别、取消和卸载；每个公开操作有可达证据或明确记为未覆盖，不用空结果冒充成功。 |
| 4. 主题和渲染 | 先做 theme set/clear 的会话状态、回执、客户端晚接入，再做 `prompt.paint`、`ui.place`、Backdrop、`ui.pointer` 和 shader。分开验证作者类型、宿主行为与实际绘制。 | 无绘制客户端时不误判设置失败；clear 后晚接入不见旧主题；paint 不改草稿、光标或撤销历史；背景点击只交给拥有该主题的插件。没有图形客户端证据时标记未验收。 |
| 5. 切换与回归 | 每组先写最小失败测试，再实现并重跑相关 `.303` 回归；切换前执行 `make build`，用同一 fixture 在固定 `.329` 官方与本地 CLI 的 tmux 会话中对照。 | 留下双方版本、制品哈希、场景和输出；明确剩余缺口再决定是否切换默认声明。不把编译通过当运行时对齐，不覆盖旧账本。 |

### `wasm.compile`：已按官方隔离模型实现

官方 2.1.329 二进制的做法是：所有插件仍共用一个 hooks Worker，只有扫描到 `wasm.compile` 调用的插件，其 VM 才设 `codeGeneration.wasm: true`；该 VM 先执行一段沙箱脚本，换上冻结的精简 `WebAssembly`。同步 Wasm 导出占住事件循环，与同步 JS 死循环同属既有 Worker 超时恢复的范围，官方也未为此另开 Worker。本地照此实现：

- 扫描（`loader.ts`）：参数是字符串字面量（或无替换的模板）时，列为 `declaration.wasm.files`，记录插件相对路径和写法。路径须相对调用文件、以 `.wasm` 结尾、不出插件目录。模板、拼接、条件、展开、数字字面量、无参数，以及绑定到这些值的常量都拒绝加载。其他表达式视为运行时字节（`isMadeAtRunTime`）。所列文件的内容 sha256 计入 fingerprint，文件保存后声明随之变化。
- 沙箱（`wasm.ts`、`worker.ts`）：`Module`、`compile` 以及对非模块调用的 `instantiate` 都抛 CompileError。`validate` 和 `Memory` 拒绝 shared memory。命名空间及其成员均冻结，`SharedArrayBuffer`、`Atomics` 照旧删除。不调用的插件看不到 `WebAssembly`。
- 调用：Worker 在调用当时复制字节，上限 64 MiB。宿主核对扫描规则：路径须是所列写法，字节须声明过 `isMadeAtRunTime`。宿主经 realpath 读取文件，目标不以 `.wasm` 结尾即拒绝。随后派发 `wasm.compile` 事件 `{ path?, base64 }`，`path` 固定不可改，hook 可替换字节或 deny。回到 Worker 后在调用者的 realm 中编译，再检查 shared memory。
- 测试：`wasmCompile329.test.ts`。

与官方的已知差异：

- 本地只追踪 `const` 绑定，未赋值的 `let`/`var` 字符串不会像官方那样在扫描时拒绝；运行时宿主仍会按写法规则拒绝。
- 未实现 hosted 模式下文件改动后拒绝调用（官方声明本地模式改为重载）。

### `Shader`：未实现

官方由单独打包的编译器读取 `claude-code/shader` 文件。扫描时给出 `namesShader`/`shaders`，`claude plugin validate` 报告开销，desktop 在 GPU 上播放。不播放 shader 的应用只显示其 `Svg` 子节点。本地缺少整条链路：Backdrop 现只接受被动 Box/Text（`theme.ts` `validateBackdropTree`），也就没有 `Svg` 回退，更没有编译器和 GPU 播放器。只做其中一段不能独立使用，所以留待第 4 步渲染工作：先让 Backdrop 支持 Svg，再接受 `Shader` 并回退到 Svg，最后实现编译器。

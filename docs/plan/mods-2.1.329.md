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

### `wasm.compile`：声明存在，运行时未支持

`src/services/mods/wasmIsolation329.test.ts` 在 Bun 1.4.4 实测：单独启用 Wasm 的 VM 能编译并实例化模块。`structuredClone` 也能复制已编译模块，但将它交给现行 `codeGeneration.wasm: false` 的 VM 后，连 `WebAssembly.instantiate(module)` 都会得到 `CompileError`。所以只外包编译并不能满足插件拿回标准 Module 并在自己的 realm 实例化的契约。返回字节或 RPC 对象也不等价。

当前所有插件共用一个执行 Worker（`createModEnvironmentHost`）；在其中只给一个 VM 打开 Wasm，仍会让同步 Wasm 导出占住其他插件的事件循环。简单分配第二个 host 同样不可直接用：环境和函数 ID 只在各自 host 内唯一，`prepareUiTables` 从一个 host 的环境表解析发布者/消费者，同步 UI 回调通过同一 Worker 的环境表执行。现有超时恢复也以整个 Worker 为单位。

独立实现须隔离**实际运行 Hook 的插件**，而非仅隔离编译器，解决上述跨 Worker 发布和调用后，再接入仅字面量文件准入（相对调用文件、内容指纹）、字节快照与 64 MiB 限额、shared memory 拒绝、重写/拒绝事件和 worker 卸载。现阶段不要移除共享 VM 的 Wasm 禁令，也不要用宿主 `WebAssembly` 替换插件全局对象。

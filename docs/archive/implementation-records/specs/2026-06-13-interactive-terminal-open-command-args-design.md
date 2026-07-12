# InteractiveTerminal `open` command/args 设计

## 背景

当前 `InteractiveTerminal` 的 `open` 动作不接受 `command` 和 `args` 入参。
`handleOpen` 会无条件调用 `resolveInteractiveTerminalCommand()`，而该逻辑读取的是 Claude Code 进程自身的 `process.env.SHELL`，不是 `open` 入参里的 `env.SHELL`。

这导致即使调用方传入：

```json
{
  "action": "open",
  "env": {
    "SHELL": "/bin/bash"
  }
}
```

实际启动命令仍然可能是 `/bin/zsh`。`input.env` 只作为子进程环境透传给 PTY spawn，不参与 shell 选择。

## 目标

为 `InteractiveTerminal` 的 `open` 动作增加显式进程选择能力：

- 支持调用方传入 `command?: string`
- 支持调用方传入 `args?: string[]`
- 传入 `command` 时优先使用它
- 未传入 `command` 时保留现有默认 shell 解析行为
- `command` 解析失败时直接报错，不做回退
- 继续支持通过 `PATH` 解析程序名，也支持绝对路径

## 非目标

本次不处理以下内容：

- 不把 `env.SHELL` 重新定义为 shell 选择入口
- 不支持把完整命令行字符串自动拆分为 command + args
- 不修改 `write/read/send_key/resize/signal/close` 语义
- 不改变现有 task preview 机制
- 不引入新的 shell fallback 策略

## 方案概览

采用“显式优先，默认兼容”的方案：

1. `open` schema 增加 `command?: string` 与 `args?: string[]`
2. `handleOpen()` 优先使用 `input.command`
3. `input.args` 原样透传到 PTY manager / driver
4. driver 层继续负责将 `command` 解析为真实可执行路径
5. 若可执行文件解析失败，直接报错
6. 当 `command` 缺省时，保留现有默认 shell 选择逻辑

## 接口设计

### `open` 输入

`src/tools/InteractiveTerminalTool/actionSchemas.ts`

当前：

- `cwd?: string`
- `env?: Record<string, string>`
- `cols?: number`
- `rows?: number`

修改后增加：

- `command?: string`
- `args?: string[]`

语义定义：

- `command`
  - 表示要启动的可执行程序
  - 可以是程序名，如 `bash`、`zsh`、`env`
  - 也可以是绝对路径，如 `/bin/bash`
- `args`
  - 表示传给该程序的参数数组
  - 不做 shell-style 拆词
  - 调用方必须自行完成参数拆分

### 行为规则

#### 规则 1：显式优先

如果 `open` 提供了 `command`：

- 使用该 `command`
- 使用该 `args`（若未提供则为空或沿用现有默认参数逻辑）
- 不读取 `input.env.SHELL` 作为命令选择依据
- 不回退默认 shell

#### 规则 2：兼容默认行为

如果 `open` 未提供 `command`：

- 继续调用 `resolveInteractiveTerminalCommand()`
- 保持现有默认 shell 解析行为

#### 规则 3：失败即报错

如果 `command` 无法解析为可执行文件：

- 直接报错
- 不回退到默认 shell
- 不尝试 `env.SHELL`
- 不尝试其他替代命令

## 调用链设计

### `handleOpen`

`src/tools/InteractiveTerminalTool/handlers/open.ts`

当前逻辑：

- 无条件调用 `resolveInteractiveTerminalCommand()`
- 将结果作为 `command` 传给 `manager.open()`

修改后逻辑：

- `const command = input.command ?? resolveInteractiveTerminalCommand()`
- `args` 由 `input.args` 透传
- `env` 继续仅作为子进程环境传递

这将明确分离两类职责：

- `command/args`：决定启动什么程序
- `env`：决定子进程拥有哪些环境变量

### `PtySessionManager`

`src/utils/pty/PtySessionManager.ts`

当前 `OpenTerminalSessionOptions` 已支持：

- `command?: string`
- `args?: string[]`

因此此层结构不需要大改，只需保证 `handleOpen()` 正确把 `command` / `args` 传进来。

### `nodePtyDriver`

`src/utils/pty/nodePtyDriver.ts`

driver 层继续承担：

- 根据 `command` 决定默认参数（若需要）
- 将 `command` 解析为真实路径
- 执行 `pty.spawn()`

这里保留现有职责划分最清晰：

- handler 决定“想运行什么”
- driver 决定“怎样把它运行起来”

## PATH 解析设计

`resolveCommandPath(command)` 继续作为唯一解析入口。

它负责：

- 若 `command` 是绝对路径，直接验证可执行权限
- 若 `command` 是程序名，则在 `PATH` 中查找
- 查找失败时抛出错误

这样可以满足：

- `command: "bash"`
- `command: "zsh"`
- `command: "env"`
- `command: "/bin/bash"`

但不支持：

- `command: "env -i /bin/zsh -f"`

后者会被视为一个不可执行文件名，而不是可自动拆分的命令行。

## 默认参数策略

driver 当前已有 `buildShellArgs(command)`：

- PowerShell 默认补 `-NoLogo`
- 其他命令默认空数组

本次建议规则如下：

- 如果调用方显式提供 `args`，则完全使用调用方传入值
- 如果调用方未提供 `args`，则沿用当前 driver 默认参数逻辑

这样可以同时满足：

- 显式控制：`command: "bash", args: ["--noprofile", "--norc"]`
- 默认行为：`command: "powershell"` 时仍能自动补 `-NoLogo`

## 错误处理

当命令解析失败时，当前实现会抛出：

```ts
throw new Error(`Unable to resolve terminal command: ${command}`)
```

本次保持该行为即可。

上层会把它包装为 tool error 返回。当前不是必须新增专用错误码，除非后续用户体验上明确需要把“命令不存在”单独区分出来。

## 测试设计

### 1. `open` handler 测试

`src/tools/InteractiveTerminalTool/handlers/open.test.ts`

新增或调整测试：

- 未传 `command` 时，仍返回默认 shell
- 传入 `command: '/bin/bash'` 时，返回 `/bin/bash`
- 传入 `command: 'bash'` 时，返回 `bash`
- 传入 `args` 时，能够透传到 manager/driver

### 2. driver 测试

围绕 `src/utils/pty/nodePtyDriver.ts` 增加：

- `command='bash'` 时可通过 `PATH` 解析
- `command='/bin/bash'` 时可直接使用绝对路径
- `command='definitely-not-found-bin'` 时直接失败
- 显式 `args` 存在时，不再自动覆盖为默认参数

### 3. schema / tool 测试

- `openActionSchema` 接受 `command?: string`
- `openActionSchema` 接受 `args?: string[]`
- `InteractiveTerminalTool` 在 open 后记录的 task state 中，`command` 为最终使用值

## 数据流总结

新数据流应为：

1. Tool 接收 `open` 输入
2. schema 校验 `command` / `args` / `env` / `cwd` / `cols` / `rows`
3. `handleOpen()` 选择最终 `command`
4. `handleOpen()` 将 `command`、`args`、`env` 传入 `manager.open()`
5. driver 解析 `command` 路径
6. driver 以 `resolvedCommand + args + merged env` 启动 PTY
7. task state 记录本次 open 使用的 `command`

## 成功标准

实现完成后，应满足：

1. 调用：
   ```json
   {
     "action": "open",
     "command": "bash",
     "args": ["--noprofile", "--norc"]
   }
   ```
   能启动 bash，并携带指定参数。

2. 调用：
   ```json
   {
     "action": "open",
     "command": "/bin/bash"
   }
   ```
   能直接按绝对路径启动。

3. 调用：
   ```json
   {
     "action": "open",
     "env": {
       "SHELL": "/bin/bash"
     }
   }
   ```
   若未提供 `command`，仍走默认 shell 解析，不把 `env.SHELL` 当作命令来源。

4. 调用：
   ```json
   {
     "action": "open",
     "command": "definitely-not-found-bin"
   }
   ```
   直接失败并返回错误，不回退。

## 风险与注意事项

- 需要确认 UI / task 展示中记录的是用户传入的 `command`，还是最终 resolved command；本次建议保留“记录最终使用的 command 字符串”，不额外显示绝对解析路径
- 若未来支持“干净 shell”或 `env -i` 这类复杂启动方式，应通过 `command: 'env'` + `args: [...]` 表达，而不是扩展 `command` 的拆词语义
- 测试需要避免依赖过多本机 shell 配置，优先使用稳定可执行程序名或 fake driver 验证透传行为

## 结论

本设计通过为 `InteractiveTerminal open` 增加 `command` 与 `args` 两个显式参数，修复“只能由父进程 `process.env.SHELL` 决定 shell”的当前限制，同时保留现有默认行为与 PATH 解析能力。

最终接口边界将更清晰：

- `command/args` 决定进程启动方式
- `env` 决定子进程环境
- 解析失败直接报错
- 未显式指定时仍兼容现有默认 shell 逻辑

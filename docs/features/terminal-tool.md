# Terminal 工具

> 英文名：`terminal-tool` · 领域：工具 · [返回功能索引](README.md)

## 作用与效果

给模型一个可多轮交互的 PTY，适合 REPL、TUI、需要特殊按键或 signal 的程序。后台轮询跟踪真实进程状态，结束时只通知一次并保留最终输出。`new-session` 与 `send-keys`（以会话累积的整行命令）按 Bash 权限规则判定，只读动作直接放行；auto 模式下 `Terminal` allow 规则被搁置。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| Bash 规则 | settings `permissions` | `"Bash(bash:*)"` 等 | `new-session` 以 `command + args` 作为命令判定 |
| 工具输入 | 模型调用 | `{"action":"new-session","command":"bun","args":["repl"],"cwd":"...","cols":120,"rows":30}` | 其他 action：`list-panes` `send-keys` `capture-pane` `resize-pane` `send-signal` `display-message` `kill-pane` |

## 效果

没有规则时需要确认：

```text
❯ DO<<Terminal|{"action":"new-session","command":"bash","args":["-c","echo hello-from-pty; sleep 2"]}>>
● Terminal(action=new-session command=bash args=["-c","echo hello-from-pty; sleep 2"])
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Tool use
   Terminal(action=new-session command=bash args=["-c","echo hello-from-pty; sleep 2"])
   Open and control a persistent terminal session
 This command requires approval
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for Terminal commands in
      ~/work
   3. No
 Esc to cancel · Tab to amend
```

有 `Bash(bash:*)` allow 规则时直接运行，进程结束后通知一次：

```text
❯ DO<<Terminal|{"action":"new-session","command":"bash","args":["-c","echo hello-from-pty; sleep 2"]}>>
● Terminal(action=new-session command=bash args=["-c","echo hello-from-pty; sleep 2"])
● FAKE_DONE
✻ Churned for 0s · 1 Terminal still running
● Terminal term-1 completed
● FAKE_DONE
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Terminal Tool

`Terminal` 提供持久 PTY session，可用于需要多轮输入、特殊按键、窗口 resize 或 signal 的交互式程序：

```json
{
  "action": "new-session",
  "command": "bun",
  "args": ["repl"],
  "cwd": "/path/to/project",
  "cols": 120,
  "rows": 30
}
```

创建 session 后，使用返回的 pane target 调用 `send-keys`、`capture-pane`、`resize-pane`、`send-signal`、`display-message` 或 `kill-pane`；`list-panes` 可列出尚未回收的 pane。`capture-pane` 支持 `compact`、`full` 和 `save_file` 三种输出模式。

Terminal task 详情会以 JSON 数组保留启动时的 `args`，并与 `command`、`cwd` 一起展示。任务由统一的后台 polling 逻辑跟踪真实 PTY 状态；每个 session 使用独立 timer：

- 进程自然退出后停止轮询、清理 runtime registry、持久化最终输出，并只发送一次完成通知；
- 根据真实退出状态区分 `completed`、`failed` 和 `killed`，保留 `exitCode`、`signal`、termination reason 与 driver error；
- signal、close 和状态刷新会继续 drain 尾部输出，避免丢失进程退出前的最后内容；
- exited、closed 和 failed session 会在 TTL 到期后主动 dispose。

`send-signal` 表达操作系统 signal；需要向前台程序发送键盘 `Ctrl+C` 时，应使用 `send-keys` 的 `CTRL_C`。

Terminal 按 Bash 权限规则判定：`new-session` 以 `command` + `args`（缺省为 `$SHELL`）作为命令，`send-keys` 在按 Enter 提交一行时以该会话累积的整行作为命令，因此分段送出也会命中 `Bash(...)` allow/ask/deny 规则；尚未提交的输入只检查 deny 规则。PTY 不在 sandbox 内运行，sandbox 自动放行不适用。`capture-pane`、`display-message`、`list-panes` 视为只读，`resize-pane`、`send-signal`、`kill-pane` 不经 Bash 规则判定。auto 模式下 `Terminal` 的 allow 规则会被搁置。

# 背景会话、daemon 与 agents 视图

> 英文名：`background-sessions` · 领域：Agent 与编排 · [返回功能索引](README.md)

## 作用与效果

`claude --bg "<prompt>"` 把会话放到背景运行并立即返回 id；每个 worker 跑在自己的 PTY host 下，由按需启动的 supervisor（daemon）管理，没有背景会话也没有客户端时自动退出。`claude agents` 是全屏列表视图（Enter 打开、空格回复、Ctrl+X 删除），`--json` 输出机器可读列表。交互会话里 `/background` 把当前会话转到背景，`/stop`、`/daemon` 管理。README 原先缺这一项。

## 配置

| 用法 | 说明 |
| --- | --- |
| `claude --bg [prompt]` / `--background` | 背景启动；配合 `--resume <id>` 在背景续跑 |
| `claude agents [--json] [--all] [--cwd <path>]` | 列表视图 / JSON |
| `claude attach <id\|name>` | 在当前终端打开，Ctrl+Z 离开 |
| `claude logs <id>` | 最近终端输出 |
| `claude stop <id>` / `claude rm <id>` | 停止（保留对话）/ 删除（含 worktree） |
| `claude respawn <id>` | 用当前版本重启 |
| `claude daemon status\|logs\|stop [--any] [--keep-workers]\|run` | supervisor 生命周期；按需 daemon 需 `stop --any` |
| `/background`、`/stop`、`/daemon` | 交互会话内的对应命令 |

状态保存在 `~/.claude/jobs/<id>/state.json`；socket 在 `/tmp/cc-daemon-<uid>/<hash>`（Windows 为 named pipe）。

## 效果

```text
Starting background service…
backgrounded · bb087cdd
  claude agents             list sessions
  claude attach bb087cdd    open in this terminal
  claude logs bb087cdd      show recent output
  claude stop bb087cdd      stop this session
```

`claude agents --json`：

```text
[
  {
    "pid": 7915,
    "id": "bb087cdd",
    "cwd": "~/work",
    "kind": "background",
    "startedAt": 1792854574309,
    "sessionId": "bb087cdd-3acd-4e81-8c4e-925c3c272715",
    "name": "DO<<Bash|{\"command\":\"echo bg-work\",\"description\":\"echo\",\"__d",
    "status": "busy",
    "state": "running"
  }
]
```

`claude agents` 视图：

```text
 ▐▛███▜▌   Claude Code v2.1.292
▝▜█████▛▘  New sessions: Opus 5.5 · medium effort
  ▘▘ ▝▝    ~/work
           0 awaiting input · 1 working · 0 completed
Working
 ✻ DO<<Bash|{"command":"echo bg-…  FAKE_DONE                                                              39s
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ describe a task for a new session
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  enter to open · space to reply · ctrl+x to delete · ? for shortcuts
```

`claude daemon status`（路径已缩短、去掉换行）：

```text
pid:     7900
version: 2.1.292
uptime:  42s
origin:  transient — started on-demand by `claude --bg` (pid 7885) in ~/work
log:     ~/.claude/daemon.log

bg sessions:
  sock dir:     /tmp/cc-daemon-0/71e0702c
  control.sock: reachable
  bg workers:   1 running (control.sock)
  daemon.log:   293B at ~/.claude/daemon.log

holding this daemon open:
  1 bg worker running (daemon waits for them to settle)

to let it idle-exit: wait for (or cancel) bg workers and close any `claude agents`
```

`claude stop bb087cdd` 输出 `stopped bb087cdd`。

# Monitor 工具

> 英文名：`monitor-tool` · 领域：工具 · [返回功能索引](README.md)

## 作用与效果

`Monitor` 在后台运行一个命令，stdout 每行（200ms 内合并）作为一则任务通知唤醒模型；默认 5 分钟、最长 30 分钟（`-p` 下 10 分钟）到期并通知一次，可重新 arm；输出过多时自动抑制。启用后 Bash/PowerShell 拒绝以 `sleep N`（N ≥ 2）开头的前景命令。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| 权限规则 | settings | `"Monitor"`、`"Bash(...)"` | 与 Bash 规则相同；auto 模式下 Monitor allow 规则被搁置 |
| 工具输入 | 模型调用 | `{"description":"...","command":"..."}` | — |

## 效果

`for i in 1 2 3; do echo tick $i; sleep 1; done` 每行一个事件，结束时通知 stream ended：

```text
● Monitor(tick watcher)
  ⎿  Monitor started · b8641bnrp · expires in 5m
● FAKE_DONE
✻ Brewed for 0s · 1 monitor still running
● Monitor event: "tick watcher"
● FAKE_DONE
✻ Crunched for 0s · 1 monitor still running
● Monitor event: "tick watcher"
● FAKE_DONE
✻ Sautéed for 0s · 1 monitor still running
● Monitor event: "tick watcher"
● FAKE_DONE
✻ Churned for 0s · 1 monitor still running
● Monitor "tick watcher" stream ended
```

模型收到的启动回执：

```text
Monitor started (task b8641bnrp, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. ...
```

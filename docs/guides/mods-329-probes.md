# Mods 2.1.329：主题与事件验收探针

从仓库根目录运行。每次选择一个探针，复制到新的临时目录：CLI 可能在插件目录生成类型，不要直接加载仓库副本。仅需已有 CLI 和 tmux，不安装依赖。

```sh
probe=theme                    # 第二轮改为 events
bin="$PWD/official-claude"     # 本地集成构建就绪后改为 "$PWD/built-claude"
run=$(mktemp -d); run=$(cd "$run" && pwd -P)
mkdir -p "$run/home" "$run/config" "$run/work" "$run/tmp"
cp -R "tests/fixtures/mods-329/$probe" "$run/plugin"
session="mods329-$(basename "$run" | tr . -)"
tmux new-session -d -s "$session" -x 120 -y 32 -c "$run/work" \
  env -i PATH="$PATH" TERM=xterm-256color HOME="$run/home" TMPDIR="$run/tmp" \
  CLAUDE_CONFIG_DIR="$run/config" CLAUDE_CODE_ENABLE_MODS=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_API_KEY=probe-dummy \
  ANTHROPIC_BASE_URL=http://127.0.0.1:9 "$bin" --dangerously-skip-permissions \
  --plugin-dir "$run/plugin" --debug-file "$run/host.log"
tmux attach -t "$session"     # 完成必要的首次启动提示；到输入框后 Ctrl-b d 脱离
```

在启动 tmux 的 shell 中发送命令；等待回执后再截取 pane：

```sh
case "$probe" in theme) input=/themeprobe;; events) input=/reload-plugins;; esac
tmux send-keys -t "$session" -l "$input"; tmux send-keys -t "$session" Enter
tmux capture-pane -p -S -200 -t "$session" > "$run/result.txt"
```

- **主题回执**：同一命令先 set 再 clear。官方无绘制客户端时，set 返回 `isDrawn:false` 和 `requestId:"backdrop"`；clear 返回 `isDrawn:false`、`reason:"the theme is cleared"`，无 `requestId`。这不是绘制、晚接入或清除后重连的证据。
- **事件注册**：看 `event-probe: reloaded (6 hooks: …)` 的插件级回执，不用 `/reload-plugins` 的全局计数判断。传给 `on` 的名称须为字符串字面量。
- **事件分发**：事件会话中再用同样的 `send-keys` 步骤提交 `Use Bash to run pwd once, then stop.`。用 `grep -F 'console.error: EVENT_PROBE ' "$run/host.log"` 查实际回调。官方原验收仅记录 `tool.offer`；`tool.judge`、`tool.run`、`agent.report`、`session.stop`、`ui.pointer` 均仅确认注册。原请求受登录状态限制；上述离线复跑同样不应期待模型执行工具。缺少标记不等于事件不受支持。合成回放不算真实分发。

结束时执行 `tmux kill-session -t "$session"`。pane、调试日志与生成文件仅留在临时目录。官方结果不是本地 parity；本地产物须另起临时目录，用相同探针与客户端条件独立记录。

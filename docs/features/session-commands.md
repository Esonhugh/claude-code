# 会话命令

> 英文名：`session-commands` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

本 fork 新增或补齐的斜杠命令。部分命令在回合进行中也会立即打开（对齐官方 2.1.303），`/usage` 支持 `-p` 并合并了 `/cost`、`/stats` 别名。

| 命令 | 作用 |
| --- | --- |
| `/goal` | 自主目标，见 [goal.md](goal.md) |
| `/recap` | 立即生成一到两句会话回顾；终端失焦 5 分钟也会自动生成 |
| `/cd <dir>` | 切换会话工作目录并加入工作范围，支持路径补全 |
| `/focus [on\|off]` | 全屏渲染下每回合只显示提问、一行摘要和回复；非全屏打印提示 |
| `/skill-doctor` | 列出已加载 skill 的上下文开销、7 天 token、使用次数，标出从未使用的 |
| `/autocompact [auto\|<tokens>]` | 查看或设置当前模型的自动压缩窗口，见 [compaction.md](compaction.md) |
| `/usage` | 用量与成本（`/cost`、`/stats` 为别名），`-p` 下输出文本 |
| `/reload-skills`、`/reload-plugins` | 重新载入 skills / 插件 |
| `/diff` | 查看未提交变更，见 [diff-view.md](diff-view.md) |
| `/workflows` | 查看本会话的 Dynamic Workflow runs |
| `/list-agents`（`/peers`） | 列出同机其他 Claude 会话，见 [peer-messaging.md](peer-messaging.md) |
| `/background`、`/stop`、`/daemon` | 背景会话，见 [background-sessions.md](background-sessions.md) |

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `viewMode` | settings | `default` `verbose` `focus` | 启动时的 transcript 视图；`/focus` 的选择保存为全局配置 `briefTranscript` |
| `awaySummaryEnabled` | settings | `true` / `false` | 自动回顾（也可用 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0/1`） |

## 效果

`/skill-doctor`（交互与 `-p` 输出相同）：

```text
Skills loaded this session
  skill         source           context  7d tokens   uses  last used
  deploy-notes  projectSettings     < 20          -     0×  never
  lint-fixer    projectSettings     < 20          -     0×  never
  context = this skill's one-line listing in the system prompt, included every turn
  (dash = not in the current listing, costs nothing; full SKILL.md loads only when it runs)
  7d tokens = tokens attributed to the skill over the last 7 days of sessions on this machine
2 skills loaded but never invoked. Each one adds to the system prompt every turn. Disable in /skills, or remov
e from .claude/skills.
```

`/autocompact 200k`、`/cd ..`：

```text
❯ /autocompact 200k
  ⎿  Auto-compact window for Opus 5.5 set to 200k tokens
❯ /cd ..
  ⎿  Changed directory to
     ~
```

`/usage -p`：

```text
Total cost:            $0.0000
Total duration (API):  0s
Total duration (wall): 0s
Total code changes:    0 lines added, 0 lines removed
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
```

`/workflows`（本会话没有 run 时）：

```text
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Dynamic workflows
  No dynamic workflows in this session.
  escape to close
```

`/focus` 开启后（全屏渲染），回合行附上 `N messages hidden`；该画面取自 #130 验收时对同一实现的采集：

```text
❯ /focus
  ⎿  Focus view enabled
❯ two DO<<Write|{"file_path":"~/work/b.tx
t","content":"line1\nline2\n"}>> DO<<Bash|{"command":"ls","description":"list","__delay":6000}>>
  Edited 1 file, listed 1 directory
● FAKE_DONE
✻ Worked for 6s · 2 messages hidden (/focus to show)
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 会话命令

```text
/goal 完成当前功能并运行相关测试
/goal
/goal clear

/recap
/cd ../another-project
/reload-skills
/reload-plugins
/diff
/workflows
/list-agents
```

- `/goal <condition>`：保存当前自主目标，并在停止前检查目标是否完成；主线程也可通过 `SetGoal` 设置同一目标。Goal 状态和 hook 会写入 transcript 并可在 resume/continue 后恢复。
- `/goal`：打开交互式状态视图，展示当前 Goal 的状态、耗时、turn、token 和最后检查原因。
- `/goal clear`：清除当前 Goal 及其 Stop hook，并持久化 cleared 状态。
- `/recap`：立即生成一到两句会话回顾（上限 400 字符），复用主对话的模型与 provider（含 OpenAI），支持 `-p`。终端失焦 5 分钟后也会自动生成回顾；`CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` 或设置 `awaySummaryEnabled: false` 关闭自动回顾，`=1` 强制开启。
- `/fast`：切换 Fast mode；OpenAI provider 下发送 `service_tier: "priority"`，API key 与 ChatGPT OAuth 均可使用。
- `/compact`：压缩当前会话；OpenAI provider 下支持手动 remote compaction，并在重复压缩时保留 opaque compaction history。
- `/autocompact [auto|<tokens>]`：查看或设置当前模型的自动压缩窗口（100k 到 1M，例如 `500k`、`200000` 或简写 `200`）；无参数时打开对话框，←/→ 调整、Enter 应用。设置按模型写入用户设置 `modelSettings.<model>.autoCompactWindow`，切换模型后各自保留；`auto`/`reset` 恢复自动窗口。非交互模式（`-p`）输出文本结果。OpenAI 等第三方模型同样适用。
- 切换到上下文窗口更小的模型后，若会话已超出新模型的上限，自动压缩会先由上一个（窗口更大的）模型生成摘要；该模型已不在 `availableModels` 中或摘要失败时，改用当前模型。
- `/cd`：切换当前会话工作目录，并将目录加入当前 session 的工作范围。
- `/reload-skills`：不刷新插件，直接重新读取 user/project/plugin skills。
- `/reload-plugins`：应用 `/plugin manage` 中的安装、更新和启停变更，重新加载 plugin commands、skills、hooks、MCP 和 LSP；已安装插件使用本地安装缓存，不会因 reload 自动下载。
- `/diff`：由已加载且获准接管该命令的官方内置 diff Mod 处理；未接管时使用原生 Git diff。原生视图在终端至少 110 列且没有可见 Mods dock 时使用右侧 sidebar，否则打开 dialog。官方 Mod 的完整详情、刷新、滚动、关闭重开及终端/浏览器 Client 生命周期仍须完成验收。
- `/workflows`：查看 Dynamic Workflow runs，不直接启动 workflow。
- `/list-agents`（别名 `/peers`）：列出当前 messaging registry 中其他可发现的本地 Claude session。

PromptInput 按 UTF-8 stream 处理普通文本、中文等宽字符、Kitty CSI-u 和 bracketed paste。同一个 stdin chunk 中的文本与 Enter/Backspace/方向键按顺序生效；未闭合 paste 会在有界空闲恢复后释放 literal payload 并回到普通输入，避免后续按键被永久吞掉。

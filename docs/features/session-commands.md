# 会话命令

<!-- lang: zh-Hans -->

> 英文名：`session-commands` · 领域：界面与交互 · [返回功能索引](README.md)

## 这是什么

在输入框打 `/` 会弹出命令列表。这一页汇总本 fork **新增或补齐**的会话命令，各自做什么、什么时候用。部分命令在 Claude 正在回答时也能立即打开（对齐官方 2.1.303）。

<details lang="en"><summary>English</summary>

> Name: `session-commands` · Area: UI and interaction · [Back to index](README.md)

## What it is

Typing `/` in the input box opens the command list. This page collects the session commands this fork **adds or completes**, what each does and when to use it. Some commands open immediately even while Claude is answering (as in the official 2.1.303).

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`session-commands` · 領域：介面與互動 · [返回功能索引](README.md)

## 這是什麼

在輸入框打 `/` 會彈出命令列表。這一頁彙總本 fork **新增或補齊**的會話命令，各自做什麼、什麼時候用。部分命令在 Claude 正在回答時也能立即開啟（對齊官方 2.1.303）。

</details>

## 一览

| 命令 | 一句话 | 详见 |
| --- | --- | --- |
| `/recap` | 用一两句话总结「到目前为止做了什么」 | 本页 |
| `/cd <目录>` | 切换会话的工作目录 | 本页 |
| `/focus [on\|off]` | 精简显示：每轮只留你的问题、一行摘要和最终回复 | 本页 |
| `/autocompact [auto\|<tokens>]` | 调整对话多长时自动压缩 | 本页、[compaction.md](compaction.md) |
| `/usage` | 本次会话的花费、token、耗时（`/cost`、`/stats` 是别名） | [usage-and-cost.md](usage-and-cost.md) |
| `/skill-doctor` | 找出加载了却从没用过的 skill | [skills.md](skills.md) |
| `/reload-skills` / `/reload-plugins` | 不重启，重新读取 skill / 插件 | [skills.md](skills.md)、[plugins-marketplace.md](plugins-marketplace.md) |
| `/goal` | 给 Claude 设一个「做完才停」的目标 | [goal.md](goal.md) |
| `/diff` | 查看未提交的改动 | [diff-view.md](diff-view.md) |
| `/workflows` | 查看本会话跑过的 workflow | [workflows.md](workflows.md) |
| `/list-agents`（`/peers`） | 用纯文本列出本会话的子代理、teammate 和同机其他 Claude 会话 | [peer-messaging.md](peer-messaging.md) |
| `/background`、`/stop`、`/daemon` | 把会话放到后台继续跑 | [background-sessions.md](background-sessions.md) |
| `/fast` | 切换快速模式（OpenAI provider 下发送 `service_tier: "priority"`） | [openai-provider.md](openai-provider.md) |

## `/focus`：只看结果

Claude 每轮可能调用很多工具，画面很长。`/focus` 打开后，每轮只显示你的问题、一行工具摘要（例如 `Edited 1 file, listed 1 directory`）和最终回复，被省略的条数写在回合末尾。

需要**全屏渲染**（`CLAUDE_CODE_NO_FLICKER=1`）；非全屏下只打印提示。

关闭时（默认）：

![focus 关闭](images/session-commands-focus-off.png)

`/focus` 打开后，同一轮变成一行摘要，末尾显示 `2 messages hidden (/focus to show)`：

![focus 打开](images/session-commands-focus-on.png)

`/focus off` 恢复。选择会保存，下次启动沿用；也可以在 settings 里用 `viewMode` 指定启动时的视图。

## `/cd`：换工作目录

在一个仓库里开着会话，想去隔壁目录干活，不用退出重开。输入 `/cd ` 后会列出子目录，打几个字母按 `Tab` 补全：

![/cd 补全](images/session-commands-cd-complete.png)

按 `Enter` 切换。新目录同时加入本会话允许访问的范围：

![/cd 完成](images/session-commands-cd.png)

切换后会话记录也搬到新目录对应的项目下（和官方 2.1.329 相同），所以退出后在新目录用 `claude -c` 能接上这个会话。此前记录留在启动目录，从新目录 `-c` 找不到。搬移失败时照常切换目录，记录留在原处继续写。

## `/autocompact`：什么时候自动压缩

对话越长越贵，到一定长度会自动压缩（把早期内容总结成摘要）。`/autocompact` 设置这个长度：

![/autocompact](images/compaction-dialog.png)

- 不带参数打开对话框：`←` `→` 调整，`Enter` 应用；
- 直接带值：`/autocompact 500k`、`/autocompact 200000`，或简写 `/autocompact 200`（范围 100k 到 1M）；
- `/autocompact auto`（或 `reset`）恢复为模型的推荐值。

设置**按模型分别保存**在用户设置 `modelSettings.<模型>.autoCompactWindow`，换模型后各自生效；OpenAI 等第三方模型同样适用。`-p` 模式下输出文本结果。更多见 [compaction.md](compaction.md)。

## `/recap`：我刚才做到哪了

立即生成一两句（最多 400 字）的会话回顾，用和主对话相同的模型。适合离开一会儿回来、或多个会话来回切时快速找回上下文。

终端失去焦点 5 分钟后也会自动生成一次。关闭自动回顾：设置 `awaySummaryEnabled: false` 或环境变量 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0`（`=1` 强制开启）。`-p` 模式也可用。

## 退出后接着聊：恢复提示和 `--resume`

退出交互会话时，终端最后打印 `Resume this session with:` 和一条可以直接粘贴的命令。命令的拼法和官方 2.1.329 相同：

- **带上启动参数**：例如用 `claude --permission-mode acceptEdits --effort high` 启动，提示就是 `claude --permission-mode acceptEdits --effort high --resume <id>`。`--resume`、`--continue`、`--name`、`--worktree` 这类选会话的参数不重复带；有参数的值不能安全地原样粘进 shell，或用了 `--agent-id`、`--messaging-socket-path` 这类只属于这个进程的参数时，整串都不带。含 `/` 或 `.` 的参数（多半是路径）只在整条命令一行放得下时才带。此前一律是 `claude --resume <id>`。
- **换成自己的启动命令**：设 `CLAUDE_CODE_RESUME_HINT_COMMAND=myhost`，提示变成 `myhost --resume <id>`。值只能是字母、数字、`_` 和 `-`（首字符不能是 `-`）；写成路径（`/usr/local/bin/myhost`）或含 `.` 时不生效，回到默认提示。这个变量只改提示，不改恢复行为。
- **Code Mode 会话**：提示前加 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 `，照着执行就能接着用 Code Mode。Windows 上不加前缀，改为多打印一行 `This session resumes only with the environment variable CLAUDE_CODE_EXPERIMENTAL_CODE_MODE equal to 1`。
- **在 worktree 里退出并保留了 worktree**：提示带上 `--worktree "<名字>"`，例如 `claude --worktree "wtJ" --resume <id>`，太长时改用 `-w "wtJ" -r <id>`。还放不下时只打印普通命令，前面加三行说明（`This session ran in a worktree` 等），让你到 worktree 目录里再执行。worktree 已被删除时不带 `--worktree`。
- 后台会话（`/background`）退出时不打印，它用 `claude attach` 接回，见 [background-sessions.md](background-sessions.md)。SSH 会话的提示不变。

恢复 worktree 里的会话：

- 用 `-w` 启动、退出 worktree 后，在启动目录 `claude --resume <id>`（包括 `-p` 模式）能找到这个会话。此前报 `No conversation found with session ID`。
- 会话里用 `EnterWorktree` 进入 worktree 后，会话记录随即搬到 worktree 对应的项目下，`ExitWorktree` 时搬回来。所以 `--resume <id>` 会回到那个 worktree 里继续，`-p` 模式也一样；在启动目录用 `--continue` 接不到它，会开新会话（和官方相同）。
- 多次恢复再退出，会话记录里不再重复追加同样的 worktree 状态。

上次退出时还有工具调用没拿到结果（比如进程被杀），恢复后：

- 这次调用记为出错，结果是官方的文案 `[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. …]`，提醒 Claude 先确认它是否已经生效再决定是否重跑。界面上显示 `Interrupted · What should Claude do instead?`。
- 几个 shell 或 MCP 调用折叠成一行时，没有结果的不再算进 `Ran N shell commands`，改写 `no result recorded for N call(s)`，例如 `Ran 1 shell command, no result recorded for 2 other calls`。被权限规则、自动模式或你拒绝而没跑的，写 `did not run N call(s)`，例如 `Ran 2 shell commands, did not run 1 other call`。
- 只有设了 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 自动续跑时，才在历史里加一条 `Continue from where you left off.`。没设时不加，中断的结果后面直接接你下次输入的内容，和官方相同。

和官方仍有的不同：不设 `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` 恢复 Code Mode 会话时，官方拒绝恢复，本 fork 改用普通工具继续。这是有意保留的，见 [code-mode.md](code-mode.md#子代理压缩和恢复会话)。

## 其他命令的细节

- `/reload-plugins`：应用 `/plugin` 里的安装、更新、启停，重新加载插件的命令、skill、hook、MCP 和 LSP。已安装的插件用本地缓存，不会因为 reload 去下载。
- `/reload-skills`：只重读 user / project / plugin 的 skill，不动插件。
- `/diff`：如果有已加载并获准接管的官方 diff Mod，由它显示；否则用内置 Git diff。终端宽度 ≥ 110 列且没有 Mods 侧栏时显示在右侧，否则弹窗。
- `/workflows`：只查看，不启动 workflow；本会话没有时显示 `No dynamic workflows in this session.`。
- `/compact`：手动压缩；OpenAI provider 下走远端压缩并保留压缩历史。
- 切换到上下文更小的模型时，如果当前对话已经超过新模型上限，会先用上一个（窗口更大的）模型做摘要；那个模型不可用或失败时改用当前模型。

## 设置

| 配置项 | 写法 | 说明 |
| --- | --- | --- |
| `viewMode` | `default` / `verbose` / `focus` | 启动时的显示方式；`/focus` 的选择保存在全局配置 `briefTranscript` |
| `awaySummaryEnabled` | `true` / `false` | 自动回顾；环境变量 `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0/1` 同效 |
| `modelSettings.<模型>.autoCompactWindow` | token 数 | `/autocompact` 写入的值 |
| `CLAUDE_CODE_RESUME_HINT_COMMAND` | 命令名，如 `myhost` | 退出时恢复提示用的启动命令，替换整个 `claude …` 前缀 |

## 输入框的小改进

输入框按 UTF-8 流处理普通文字、中文宽字符、Kitty 键盘协议和粘贴：同一次输入里的文字和 Enter、退格、方向键按顺序生效；没闭合的粘贴在短暂空闲后自动结束，后续按键不会被吞掉。

## 说明

画面来自实际运行（全屏渲染，110×36），模型回复由测试用假 API 按脚本生成。

# Claude Web 界面导览

> 英文名：`web-ui-tour` · 领域：界面与交互 · [返回功能索引](README.md)

## 这是什么

按一次真实操作的顺序，一步一张截图走一遍 `claude web`：从起始页开始改一处代码、确认命令、看状态、派后台 agent、回合中途插话、开终端、跑 workflow、评论文件，最后建一个项目让协调者分派任务。每一步只讲看到了什么、怎么操作；完整的参数、按键和安全模型见 [Claude Web](web-ui.md) 和 [Claude Web 项目](web-projects.md)。

## 什么时候看

- 第一次用 `claude web`，想先知道每块区域是什么。
- 想找某个功能在界面上的位置，比如“立刻发送”、终端抽屉、文件评论、任务看板。

## 分步导览

**第 1 步：起始页。** `claude web` 打开的第一页：问候语下面是大输入框，左下选工作目录，右下是权限模式和模型，下面列出这个目录最近的会话。左侧栏从上到下是新会话、搜索，MCP / Skills / 插件 / 记忆 / Hooks 五个入口，再往下是项目和最近目录。

![起始页](images/web-tour-start.png)

**第 2 步：确认命令。** 发出“检查 retrieval.py，把 TOP_K 改成 20，再跑一下测试”后，Claude 读文件、改文件，要跑测试时从输入框上方弹出确认框，写明命令和目录。按 `1` 允许这一次，`2` 本会话内都允许，`3` 拒绝并告诉它怎么做。

![确认命令](images/web-tour-approval.png)

**第 3 步：看结果。** 每次工具调用是一张卡片：Read 显示路径，Edit 直接显示 diff 和增删行数，Bash 显示命令和确认结果。回复按 Markdown 渲染，下面一排是 复制 / 重试 / 从这里分支 / 回退。顶栏显示状态、目录和上下文占用。

![对话与 diff](images/web-tour-chat.png)

**第 4 步：回退。** 用户消息左上角的“↶ 回退”打开确认条：只回退对话，或者连文件改动一起还原。之后的回合从对话里移除，原消息放回输入框，可以改了再发。

![回退](images/web-tour-rewind.png)

**第 5 步：Status 页签。** 右侧 Status 顶部是状态、模型、权限模式和上下文；这里上下文用到 64%，旁边直接给出“立即 /compact”。下面的分段可以折叠，图里展开了“会话”（完整 ID 和 `uds:` 消息地址，都能一键复制）和“环境”（版本、账号、同目录里正在运行的其他会话、API Base URL、MCP、记忆、沙箱、Hooks）。

![Status 页签](images/web-tour-status-env.png)

**第 6 步：后台 agent。** 让 Claude 派一个后台 agent 整理 TODO 注释。对话里出现 Agent 卡片和“已交回报告”一行；右侧 Agents 页签点开这个 agent 看它的完整过程，底部输入框直接给它发消息，发出的消息立即显示成气泡，已结束的 agent 带着上下文恢复后回复。

![Agents 页签](images/web-tour-agents.png)

**第 7 步：`@` 菜单。** 在输入框里打 `@`，最上面是可以直接发消息的任务和 agent，下面是工作区文件（用 ChatGPT 账号登录时还有 Codex 应用）。选 agent 后这条消息直接发给它，不经过主会话。

![@ 菜单](images/web-tour-at.png)

**第 8 步：回合中途插话。** Claude 还在写发布说明时，又发了一句“顺便列出改动过的文件”。这条消息标为“排队中”，模型会在下一个工具间隙读到；等不及就点“立刻发送”或按 `Ctrl+Enter`，当前回合被打断，马上处理这条。按 `Esc` 停止回合时，排队的消息会放回输入框。

![排队中的消息](images/web-tour-queued.png)

**第 9 步：终端抽屉。** Claude 用 Terminal 工具开了两个终端（一个 Python，一个构建日志）后，右侧才出现 Terminals 页签。每个终端是一个抽屉，可以同时展开；屏幕保留颜色，下面的输入框回车把一行送进终端（图里在 Python 里算了 `sum(range(1, 101))`），`Ctrl+C` 发中断，行上的“停止”结束它。

![终端抽屉](images/web-tour-terminals.png)

**第 10 步：Workflow。** 让 Claude 用 workflow 分两个阶段跑基准、写报告。Workflow 页签上方是所选 agent 的输出，下方每个阶段一个抽屉，列出这个阶段的 agent 卡片。

![Workflow 页签](images/web-tour-workflow.png)

点“展开”打开大弹窗：阶段排成看板列，点一张卡片在下方看它的输出。

![Workflow 看板](images/web-tour-workflow-board.png)

**第 11 步：在文件上评论。** 消息里引用的文件点开在中间预览，顶部 `‹` `›` 在对话里的文件之间切换。在图片上点一下放下编号标记，写评论后 `Enter`，评论作为一条消息发给 Claude，写明文件和标记位置。PDF、转换后的 Office 文件同样可以放标记；文本和代码可以选中几行评论，表格可以评论单元格。

![图片评论](images/web-tour-pin.png)

长文件先显示开头，末尾的“显示全部”原地加载整个文件。

![显示全部](images/web-tour-showall.png)

**第 12 步：建项目并分派任务。** 左侧栏“项目”旁点 `+`，填名称、目录和项目说明后进入项目视图。告诉协调者“把三项回归分给 worker”，中间出现三行“↳ 交给 <任务>”，右边的任务列表按 等你处理 / 运行中 / 已结束 分组；一个任务已经做完待审阅，一个在等你确认命令，一个还在运行。

![项目视图](images/web-tour-project.png)

点“等你确认”的任务进入它的对话：上面是协调者派的任务说明和 worker 的过程，确认框出现在这个任务的输入框上方。

![任务对话与确认](images/web-tour-project-task.png)

任务列表右上角的看板按钮打开任务看板，按 运行中 / 等你确认 / 待审阅 / 已结束 四列排卡片。

![任务看板](images/web-tour-project-board.png)

**第 13 步：深色外观。** 外观默认跟随系统；系统是深色时整页换成深色，图里是第 2–11 步那个会话重新打开后的样子。

![深色外观](images/web-tour-dark.png)

## 操作表

| 想做的事 | 在哪里 |
| --- | --- |
| 允许 / 拒绝一条命令 | 输入框上方的确认框，`1`–`3` 或 `↑` `↓` + `Enter`，`Esc` 拒绝 |
| 回合进行中再说一句 | 直接 `Enter`（排队）；`Ctrl+Enter` 或“立刻发送”打断当前回合 |
| 回到某条消息之前 | 用户消息上的“↶ 回退”，或回复下方的“回退” |
| 立即压缩上下文 | Status 顶部的“立即 /compact”（上下文到 60% 时出现），或顶栏“上下文” |
| 复制 session id 或消息地址 | Status → 会话，行尾的复制按钮 |
| 给后台 agent 或任务发消息 | Agents 页签里点开它用底部输入框，或在任意输入框里 `@` 选它 |
| 往终端里输入 | Terminals 页签，终端下面的输入框；`Ctrl+C` 按钮发中断 |
| 看 workflow 全部阶段 | Workflow 页签的“展开” |
| 评论图片、PDF 或代码 | 文件预览里点一下放标记，或选中文字后点“评论” |
| 看任务看板 | 项目视图任务列表右上角的看板按钮 |

## 实际输出

文件评论发给 Claude 的消息是这样的（路径、页码和位置由页面填写）：

```text
Comment on `/tmp/web-tour-8Gq6ZB/projects/search-demo/chart.svg` (pinned at 67% from the left, 55% from the top): 这根柱子比上一根低，数值对吗？
```

截图来自 `make build` 产出的 `./built-claude`（`claude web --no-open`，HOME 是临时目录，工作目录是其中的 `~/projects/search-demo`），在 1440×900 的 Chromium（Playwright，`zh-CN` 语言）里按上面的顺序实际操作得到。模型请求打到本地脚本化的假 Messages API，所以回复、用量和费用数字都是预设的，不代表真实模型输出；第 5 步的上下文占用也是假 API 报告的用量。

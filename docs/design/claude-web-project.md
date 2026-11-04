# `claude web` 项目：协调者模式与任务分派

状态：已实现并合进 `dev`（P1–P4，#548–#551），随 v2.1.296 发布；实现与设计不同的地方已就地改正，汇总见第 9 节“实现状态”。设计稿日期 2026-11-02。原型在 `docs/design/claude-web-demo.html`，左侧栏点“项目”下的条目进入。本文是 `docs/design/claude-web.md` 的补充，那里的架构、协议和安全规则在这里都照用。

## 1. 目标

一个“项目”是一个目录加一个常驻的协调者会话。用户只和协调者说要做什么，协调者把活拆成任务，派给多个 worker agent 并行做；用户在右侧看每个任务的过程，可以直接给某个任务发消息、批准它的权限请求、停止它，做完了再审阅。

和侧栏里“按目录分组的历史会话”不同：目录分组只是把普通会话按工作目录归类；项目是用户主动建的，有名字、项目说明和自己的协调者会话。

不做：跨机器的任务分派、多人共享项目、任务之间的依赖图编辑。

## 2. 布局

三栏，和普通会话的“侧栏 | 对话 | 右侧面板”一致：

| 位置 | 内容 |
|---|---|
| 左：侧栏 | 会话和项目的切换（见第 3 节） |
| 中：协调者 | 项目的协调者会话：用户消息、协调者回复、它派出的任务卡片（一行：状态点、标题、摘要、状态）、任务完成或停止的通知行；底部输入框和普通会话相同（权限模式在左，模型在右）。顶栏是项目名、协调中 / 空闲、目录和项目设置 |
| 右：任务 | 默认是任务列表，按“等你处理”（等你确认、待审阅）、“运行中”、“已结束”分组；每张卡片是状态、标题、一行摘要、模型 · 耗时 · tokens · 最近的工具。点任务（右侧或中间的卡片都行）换成这个任务的对话：顶部面包屑“任务 › 标题”和操作（标记完成、停止、展开、关闭），上面是进度清单和协调者派的任务说明，下面是 worker 的过程，输入框直接发给这个任务；有权限请求时审批卡片出现在它的输入框上方 |

- 中间和右侧的输入框都和主对话框一样：左下角“+”打开同一个菜单（上传文件、添加图片、使用 skill、引用工作区文件），也支持粘贴和拖入；附件条在输入框上方，各自独立。
- 两个输入框下方的选择是同一套：左边的权限模式是项目的（worker 跟协调者用同一个模式），在中间或右侧改，两边同时变；右边的模型按钮在中间是协调者的模型和思考强度，在右侧是这个任务的。运行中的任务模型不能换，已结束的任务换了以后下一条消息恢复时生效（`send_task_message` 的 `model`）。
- 中右两栏之间可以拖动调宽；“展开”让右栏占满，中栏暂时收起。
- “看板”打开大弹窗，按运行中 / 等你确认 / 待审阅 / 已结束四列排卡片，点卡片回到右栏的任务对话。
- 窄屏（≤760px）只显示一栏，顶栏有“对话 / 任务”切换。
- 进入项目时右侧的 Status、Files 等会话页签不显示；离开项目（点任何会话或新会话）恢复。

## 3. 侧栏

从上到下：

1. 品牌、`+ 新会话`、搜索。
2. MCP、Channels、Skills、插件、记忆、Hooks、Mods。
3. **置顶**：用户置顶的会话。
4. **项目**：每行是项目名；有任务在跑时前面是绿点，有等你确认或待审阅的任务时右边显示数量。数量由服务端从 `tasks` 表按项目汇总（`TaskStore.counts()`，随 `GET /api/projects` 返回），不用先打开协调者会话。标题旁 `+` 新建项目。
5. **临时对话**。
6. **最近目录**：按目录分组的历史会话，组按“最近修改”倒序排，最近修改取该目录下会话 transcript 的修改时间和会话改过的文件里最新的那个。

每行只有一行标题，行高比原来小。没有标题的会话显示最后一条消息；连消息都没有就显示 session id（等宽、灰色）。

悬停出现提示卡片：标题加上能拿到的字段（最近修改、目录、状态、改动的文件数、ID；项目是目录、任务数、等你处理、开始于），拿不到的字段整行不显示。鼠标可以移到卡片上，卡片里的文字（比如 session id）可以选中复制；卡片打开时移到别的行，会稍等一下再切换，斜着移向卡片时不会被换掉。行右侧悬停出现置顶 / 取消置顶。每段标题可以折叠。

右键菜单：会话是标为未读 / 已读（U）、置顶（P）、重命名（R，行内编辑）、移至项目（子菜单；记下 `session_meta.project_id`，会话从“最近目录”移到项目任务列表的“移入的会话”分组，标“从会话移入”，搜索仍能找到）、封存（A，从列表移走，搜索仍能找到）、删除（D，菜单内二次确认）；项目是重命名（R）、项目设置（S）、封存（A，停止协调者）、删除（D，`?purge=1`，移进来的会话回到原目录分组）。菜单打开时按对应字母直接执行，Esc 关闭。未读的会话标题加粗、前面有蓝点，点开即标为已读。

## 4. 运行模型

### 4.1 协调者会话

项目的协调者就是一个普通的 `claude -p` stream-json 子进程（同 `claude-web.md` 3.1），多带几样东西：

- 环境变量 `CLAUDE_CODE_COORDINATOR_MODE=1`。`isCoordinatorMode()` 在非交互模式下就会生效（`src/coordinator/coordinatorMode.ts:42`），工具会过滤成 Agent、SendMessage、TaskStop 等。
- `--system-prompt`：服务端用同一个二进制里的 `getCoordinatorSystemPrompt(toolNames)`（`src/coordinator/coordinatorMode.ts:123`）生成。目前 `-p` 路径不会自动换成协调者提示词（REPL 走 `src/utils/systemPrompt.ts:84`），所以由 web 显式传入。
- `--append-system-prompt`：项目说明。
- `CLAUDE_CODE_SUBAGENT_MODEL`：项目设置里的“任务默认模型”（`src/utils/model/agent.ts` 已支持），“继承”时不设。
- 会话 id 存进项目记录。重开项目时用 `--resume <id>` 在项目目录恢复，`matchSessionMode` 会把模式对上（`src/cli/print.ts` 里 resume 的路径已处理）。

### 4.2 任务

一个任务就是协调者用 Agent 工具派出的一个 worker（`local_agent` 任务），不新建进程模型：

| 需要的东西 | 来源 |
|---|---|
| 任务出现、标题、任务说明、模型 | `system/task_started`（`description`、`prompt`、`subagent_type`），模型取 agent 元数据 |
| 运行中的用量、最近工具、一行摘要 | `system/task_progress`（tokens、工具次数、`last_tool_name`、`summary`） |
| 完成、失败、停止 | `system/task_notification` / `task_updated` |
| 任务的完整过程 | `getAgentTranscriptPath`（`src/utils/sessionStorage.ts:259`）读 worker transcript，增量拉取 |
| 权限请求 | `can_use_tool` 带 `agent_id`（`src/entrypoints/sdk/controlSchemas.ts:147`），按 agent 找到任务，显示在那个任务的输入框上方，任务状态变成“等你确认” |
| 用户直接发消息 | `send_task_message`（`src/cli/print.ts:5129`，投递规则在 `src/tasks/deliverTaskMessage.ts`）：运行中排队，已结束带上下文恢复 |
| 停止 | `stop_task`（页面发出）或协调者调用 TaskStop；只有这两种停止记为用户停止（`stop_reason = user`），进程没了记为 `exited` / `restart`，失败记为 `failed` |
| worktree | Agent 调用里的 `isolation: "worktree"`，任务卡片显示 worktree 路径 |

状态只有五个：运行中、等你确认（有未答的权限请求）、待审阅（worker 完成，用户还没看过）、已完成（用户点了标记完成，或在任务里继续对话后再次完成并审阅）、已停止（被停止或失败，失败在卡片上标出原因）。

任务卡片的右键菜单（实现时加的）：打开任务（O）、标记完成（D，只对待审阅）、停止（S，只对运行中和等你确认）、复制任务说明（C）。菜单打开时按字母直接执行，Esc 关闭；看板里的卡片用同一个菜单。

任务完成时协调者本来就会收到 task notification 并回复，中栏照常显示这条回复，另外插一行“任务「…」已完成 · 耗时”。

## 5. 本地 SQLite

项目、任务和侧栏状态都存在 `~/.claude/web/projects.sqlite`，用 `bun:sqlite`（`src/memdir/memoryIndex.ts` 已在用，不加依赖）。浏览器不直接读库，只走 REST。

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,            -- uuid
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,              -- 规范化后的绝对路径，创建时走信任检查
  instructions TEXT NOT NULL DEFAULT '',
  worker_model TEXT,              -- NULL = 继承
  permission_mode TEXT NOT NULL DEFAULT 'default',
  coordinator_session_id TEXT,    -- 协调者 transcript 的 session id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,            -- task_started.task_id（也是 agent id）
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,       -- 协调者的 session id，worker transcript 在它的目录下
  agent_id TEXT NOT NULL,         -- 读 transcript、匹配 can_use_tool
  tool_use_id TEXT,               -- 协调者那次 Agent 调用，中栏卡片用它对上任务
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '', -- 协调者给的 prompt
  subagent_type TEXT,
  model TEXT,                     -- 用户给下一次运行选的模型（send_task_message）
  effort TEXT,
  worktree TEXT,
  state TEXT NOT NULL,            -- running | blocked | review | done | stopped
  stop_reason TEXT,               -- user | failed | exited | restart
  error TEXT,
  summary TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  tool_uses INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  last_tool TEXT,
  approval_id TEXT,               -- blocked 时未答的 can_use_tool request_id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,    -- 本次运行开始；恢复的任务重新计时
  finished_at INTEGER,
  reviewed_at INTEGER
);
CREATE INDEX tasks_project ON tasks(project_id, updated_at DESC);
CREATE TABLE task_events (        -- 中栏的通知行和任务时间线
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- started | finished | stopped | approval | message | reviewed
  payload TEXT                    -- JSON
);
CREATE INDEX task_events_task ON task_events(task_id, id);
CREATE TABLE session_meta (       -- 侧栏对会话的标记，transcript 本身不改
  session_id TEXT PRIMARY KEY,
  title TEXT,                     -- 重命名后的标题；NULL 用 transcript 里的标题
  pinned_at INTEGER,
  unread INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL  -- 移至项目
);
CREATE TABLE folders (path TEXT PRIMARY KEY, last_touched INTEGER NOT NULL);  -- “最近目录”排序缓存
```

- 实现的迁移（`src/web/projectsDb.ts` 的 `MIGRATIONS`，`PRAGMA user_version` 记到第几步）：1 是 `projects`（P2），2 是 `session_meta` 和 `folders`（P1），3 是 `tasks`、`task_events` 和 `projects.coordinator_model`、`projects.coordinator_effort`（P3，`src/web/tasks.ts` 的 `TASK_MIGRATION`）。P2 先于 P1 合入，所以编号和阶段顺序不同。
- 写入只发生在服务端：服务端在转发协调者的 stream-json 时顺手 upsert `tasks` 和追加 `task_events`，用户的标记完成、置顶、项目设置走 REST。
- 对话内容不进库，仍以 transcript 为准；库里只放列表和状态需要的字段，删掉库也只丢项目元数据。
- 服务重启时，库里 `running` / `blocked` 的任务所在进程已经没了，改成 `stopped` 并记一条 `stopped` 事件（`restart`）；服务停止或结束协调者之前也先这样标一遍，协调者自己退出时记 `exited`。服务收到 SIGTERM 不算用户停止。用户在任务里发消息时用 `send_task_message` 恢复，进程里已经没有这个 agent 时从 transcript 恢复。
- `folders.last_touched` 在会话结束和文件改动事件时更新；冷启动时从 transcript 的 mtime 重建。
- 迁移用 `PRAGMA user_version`，和 `memory.sqlite` 一样。

## 6. 接口

协调者会话本身走现有的 `WS /api/sessions/:id/ws`。新增 REST（都要 cookie，路径参数都校验）：

| 接口 | 作用 |
|---|---|
| `GET /api/projects` / `POST /api/projects` | 列表（带 `TaskStore.counts()` 的任务数、运行数、等你处理数）/ 新建（名称、目录、项目说明、任务默认模型、权限模式）；未信任的目录返回 409 `needs_trust`，页面确认后带 `trust: true` 重发 |
| `PATCH /api/projects/:id` | 改名称、项目说明、任务默认模型、权限模式；说明或任务模型变了时协调者带 `--resume` 重启 |
| `DELETE /api/projects/:id` / `DELETE /api/projects/:id?purge=1` | 封存并停止协调者 / 同时删除项目记录 |
| `POST /api/projects/:id/coordinator` | 启动或恢复协调者，返回 `{ session_id, work_dir }` |
| `GET /api/projects/:id/tasks`、`GET /api/projects/:id/tasks/:tid` | 任务列表 / 单个任务 |
| `GET /api/projects/:id/tasks/:tid/transcript?after=` | worker 过程，增量（`{ messages, next, reset, tokens }`） |
| `POST /api/projects/:id/tasks/:tid/review` | 标记完成 |
| `GET /api/sidebar` | 侧栏各段数据（含标题回退：标题 → 最后一条消息 → session id），隐藏协调者的 transcript |
| `PATCH /api/sessions/:sessionId/meta` | 置顶、未读、重命名、封存、移至项目（zod `strictObject`） |
| `DELETE /api/sessions/:sessionId?transcript=1` | 先结束会话，再删除 transcript（realpath 后必须在 transcript 目录里）和侧栏标记 |

给任务发消息和停止任务没有走 REST：页面在协调者的 WebSocket 上直接发 `send_task_message` 和 `stop_task` control request，服务端转发时从这些请求和回复里更新 `tasks`；worker 的审批也是协调者 WebSocket 上带 `agent_id` 的 `can_use_tool`，页面重新连上时服务端重发还没答的请求。

## 7. 分阶段

每个阶段一个 PR 到 `dev`，用重新构建的二进制和 Playwright 验收，界面和原型并排截图对齐。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 侧栏 | 置顶、项目、临时对话、按最近修改排序的目录；单行行高、可移入的悬停卡片、右键菜单；`session_meta`、`folders` 表 | 三种语言截图与原型一致；置顶跨刷新保留；目录顺序随会话活动变化 |
| P2 项目和协调者 | `projects` 表、新建 / 设置弹窗、协调者子进程（4.1）、中栏 | fake API 下协调者派出两个任务；`-p` 里确实用了协调者提示词；重开项目能 resume |
| P3 任务面板 | `tasks`、`task_events`；右栏列表、任务对话、审批、发消息、停止、标记完成、看板、拖宽 | 给运行中和已完成的任务各发一条消息，投递结果与 REPL 一致；worker 的权限请求出现在对应任务上；服务重启后状态正确 |
| P4 收尾 | 窄屏、无障碍、`docs/features/web-ui.md` 补章节 | 390px 截图；真实 OAuth 跑一次三任务的项目 |

## 8. 待定问题

1. 任务是否要“排队上限”（同时最多几个 worker）？现在协调者自己决定并行数，没有硬上限。
2. 待审阅的任务被用户在任务里继续对话后，再次完成时是否自动回到“待审阅”？本稿是“是”。

## 9. 实现状态

| PR | 内容 |
|---|---|
| #545 | 本文和原型里的项目视图 |
| #548（P2） | `projects` 表、`/api/projects`、协调者子进程（4.1）、项目视图中栏、新建和设置弹窗、窄屏“对话 / 任务”切换 |
| #549（P1） | `session_meta`、`folders` 表、`GET /api/sidebar`、`PATCH /api/sessions/:id/meta`、`DELETE /api/sessions/:id?transcript=1`、置顶 / 项目 / 临时对话 / 最近目录四段、悬停卡片、右键菜单 |
| #550（P3） | `tasks`、`task_events` 表，任务列表、看板、可拖动和用 `←` `→` 调整的分隔条、任务对话（增量读 worker transcript）、按 `agent_id` 路由的审批、O / D / S / C 菜单、已结束任务和协调者的恢复（`send_task_message` 带 `model`、`effort`，从 transcript 恢复），侧栏项目行的数量改从库里读 |
| #552 | 收尾稳定性：上传预览 500、纯 JSON 500、待办置顶 “Next:”、登录按 `claude auth status`；用真实 API 跑通一次项目（派任务、任务内批准、恢复已结束任务） |
| #551（P4） | 键盘、鼠标、剪贴板的整页检查和修复（弹窗内 Tab 循环、Esc 只关最上层、焦点回到触发按钮、窄屏 Ctrl+K 打开抽屉等），web 二进制 e2e 在 Linux、macOS、Windows CI 上运行 |

和设计不同的地方：

- 迁移顺序是 1 `projects`、2 `session_meta` / `folders`、3 `tasks` / `task_events`（第 5 节）；`tasks` 比原表多了 `session_id`、`tool_use_id`、`subagent_type`、`effort`、`stop_reason`、`error`、`tool_uses`、`approval_id`、`started_at`。
- 发消息和停止走 WebSocket 上的 control request，没有 `.../message`、`.../stop` REST 接口（第 6 节）。
- 停止的语义：只有 `stop_task` 和 TaskStop 记为用户停止；服务重启、协调者退出另记原因，任务卡片提示“发消息可继续”。
- 任务数和等你处理数来自 SQLite，不再依赖打开协调者会话。
- 任务对话的进度清单来自 worker 的 TodoWrite：后台 worker 在 todo v2 下没有 Task* 工具，新模型默认也不给 todo 工具，所以协调者子进程带 `CLAUDE_CODE_ENABLE_TASKS=0`、`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`（只影响 web 项目）。
- 运行中任务的耗时从 `started_at` 往上数；`task_progress` 只在 worker 用工具时才来，tokens 在没有进度时取 worker transcript 里最近一次请求的用量。

已知缺口：

- 待定问题 1（并行上限）没做。
- macOS 上 API key 存进登录钥匙串，web e2e 在 macOS 跳过账号用例；Windows 跳过服务重启用例（没有 SIGTERM）。

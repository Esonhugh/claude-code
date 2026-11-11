# 记忆：auto memory 与 SQLite FTS5 检索

<!-- lang: zh-Hans -->

> 英文名：`memory` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 这是什么

每次开新会话，Claude 默认什么都不记得。记忆让它把**以后还用得上的事**写下来，下次自动看到。有两类：

| | 谁写 | 放在哪里 | 用途 |
| --- | --- | --- | --- |
| **CLAUDE.md** | 你写 | 项目根目录 `./CLAUDE.md`，或个人 `~/.claude/CLAUDE.md` | 固定规则，例如「用 bun，不用 npm」 |
| **auto memory** | Claude 自己写 | `~/.claude/projects/<项目>/memory/` | 工作中学到的事，例如「staging 部署到哪个 app」 |

auto memory 是一个文件夹：每条记忆一个 `.md` 文件，再加一个索引 `MEMORY.md`。默认每次请求都会带上 `MEMORY.md`，Claude 需要细节时再去读具体文件。

<details lang="en"><summary>English</summary>

> Name: `memory` · Area: Context and memory · [Back to index](README.md)

## What it is

Every new session starts with Claude remembering nothing. Memory lets it write down **things that will matter later** and see them automatically next time. There are two kinds:

| | Who writes it | Where it lives | What it is for |
| --- | --- | --- | --- |
| **CLAUDE.md** | you | project root `./CLAUDE.md`, or your own `~/.claude/CLAUDE.md` | fixed rules, such as "use bun, not npm" |
| **auto memory** | Claude | `~/.claude/projects/<project>/memory/` | things learned while working, such as "which app staging deploys to" |

Auto memory is a folder: one `.md` file per memory plus an index, `MEMORY.md`. By default every request includes `MEMORY.md`, and Claude reads the individual files when it needs the details.

</details>
<details lang="zh-Hant"><summary>繁體中文</summary>

> 英文名：`memory` · 領域：上下文與記憶 · [返回功能索引](README.md)

## 這是什麼

每次開新會話，Claude 預設什麼都不記得。記憶讓它把**以後還用得上的事**寫下來，下次自動看到。有兩類：

| | 誰寫 | 放在哪裡 | 用途 |
| --- | --- | --- | --- |
| **CLAUDE.md** | 你寫 | 專案根目錄 `./CLAUDE.md`，或個人 `~/.claude/CLAUDE.md` | 固定規則，例如「用 bun，不用 npm」 |
| **auto memory** | Claude 自己寫 | `~/.claude/projects/<项目>/memory/` | 工作中學到的事，例如「staging 部署到哪個 app」 |

auto memory 是一個資料夾：每條記憶一個 `.md` 檔案，再加一個索引 `MEMORY.md`。預設每次請求都會帶上 `MEMORY.md`，Claude 需要細節時再去讀具體檔案。

</details>

## 快速上手

**1. Claude 记下一件事。** 当它在对话里发现值得记住的信息（或者你直接说「记住……」），会写一个记忆文件，界面显示 `Wrote 1 memory`：

![写入记忆](images/memory-wrote.png)

记忆文件长这样，开头的 `description` 用来判断以后什么时候相关：

```markdown
---
name: deploy-target
description: staging deploys go to fly.io app demo-staging
metadata:
  type: project
---

Staging deploys go to the fly.io app demo-staging; production is demo-prod.
```

**2. 用 `/memory` 管理。** 这里可以打开编辑项目或个人的 CLAUDE.md，或打开 auto memory 文件夹直接改、删：

![/memory](images/memory-menu.png)

**3. 退出时自动整理。** 把 `memory.extraction` 设为 `sessionEnd` 后，会话结束（退出、`/clear`、`/resume`）时后台会再过一遍这次对话，把漏记的内容补进记忆；默认关闭，退出不会多花时间。

## 记忆多了以后：SQLite 检索模式

记忆文件越来越多时，每次都带上整个 `MEMORY.md` 会浪费上下文。打开检索模式后：

- 不再每次注入 `MEMORY.md`；
- 每次你发消息，自动附上**最相关的 5 个**记忆文件；
- Claude 需要时用 `SearchMemory` 工具查本地全文索引（SQLite FTS5），还能查本项目以前的对话记录和其他项目的记忆。
- 同一件事记过多次时，匹配程度相同的记忆按保存日期新的在前（自动附上和 `SearchMemory` 都是），`SearchMemory` 的结果标出每个记忆文件的保存日期，一次最多 25 条。

记忆文件和 `MEMORY.md` 照常维护，随时关掉也不会丢东西。

**1. 打开：** 在 `~/.claude/settings.json` 写

```json
{ "memory": { "sqlite": { "enabled": true } } }
```

设置在会话启动时读取一次，改完要开新会话。

**2. 建索引：** 输入 `/setup-memory-db`，输出索引了多少文件、多大、放在哪里：

```text
❯ /setup-memory-db
  ⎿  Memory index built (user, project, session): 2 files, 3 entries, 40KB at ~/.claude/memory-index.sqlite
```

**3. 使用：** Claude 调用 `SearchMemory` 查找；下面一行 `Recalled 1 memory` 是根据你的消息自动附上的相关记忆：

![SearchMemory](images/memory-search.png)

按 `ctrl+o` 可以看到附上的记忆内容：

![自动附上的记忆](images/memory-recall.png)

**4. 重建索引：** 检索模式下 `/memory` 多出一行索引：还没建过时显示「Build memory index · not built yet」（索引按需建立），建过后变成「Rebuild memory index」，显示索引了几个文件、多大、多久前建的；选它全量重建：

![Rebuild memory index](images/memory-rebuild.png)

## 设置

| 配置项 | 写法 | 默认 | 说明 |
| --- | --- | --- | --- |
| `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `false` / `1` | 开启 | 关闭 auto memory |
| `memory.extraction` | `off` / `sessionEnd` / `everyTurns` | `off` | 后台补记的时机：不补记、会话结束时、每轮之后 |
| `memory.sqlite.enabled` | `true` / `false` | `false` | 检索模式；需要 Bun 运行时，否则回退到 `MEMORY.md` |
| `memory.sqlite.scopes` | `user` `project` `session` 的子集 | 全部 | 检索范围：`project` 本项目记忆，`user` 其他项目的记忆（只读），`session` 本项目以前的对话记录 |
| `awaySummaryEnabled` / `CLAUDE_CODE_ENABLE_AWAY_SUMMARY` | `false` / `0`、`1` | 开启 | 你离开一段时间回来时，显示期间发生了什么 |

完整示例：

```json
{ "memory": { "sqlite": { "enabled": true, "scopes": ["user", "project", "session"] }, "extraction": "sessionEnd" } }
```

## 数据位置

| 内容 | 路径 |
| --- | --- |
| auto memory | `~/.claude/projects/<项目路径>/memory/*.md`，索引 `MEMORY.md` |
| 检索索引 | `~/.claude/memory-index.sqlite`（删掉后首个请求按需重建，10,000 条记忆约 2.6 秒；也可以用 `/setup-memory-db` 重建） |

## 安全

记忆内容被当作**数据**而不是指令：载入时会删除不可见字符，并转义伪装成系统消息的标签（如 `<system-reminder>`），防止有人借记忆文件注入指令。

## 与官方的差异

官方的 auto memory、后台提取、Session Memory 和离开回顾受服务端开关控制；本 fork 在交互会话里默认全部开启。SQLite 检索模式是本 fork 新增的。

## 说明

画面来自实际运行，模型回复由测试用假 API 按脚本生成。

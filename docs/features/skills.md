# Skills

> 英文名：`skills` · 领域：插件与扩展 · [返回功能索引](README.md)

## 作用与效果

分层加载 bundled、user、project、plugin skills，`/reload-skills` 运行时重读。`context: fork` 的 skill 可用 `agent` 指定执行的代理与 `background`。`/skill-doctor` 报告已加载但从未使用、仍占系统提示的 skill（见 [session-commands.md](session-commands.md)）。仓库内另有项目级 skill `.claude/skills/claude-code-feature-validation/`（不随 binary 分发）。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `context` | SKILL.md frontmatter | `fork` | 在独立 agent 中运行 |
| `agent` | SKILL.md frontmatter | 代理名（转为字符串） | 默认按已有规则选择 |
| `background` | SKILL.md frontmatter | `true` / `false` | 交互模式省略时后台启动 |

```yaml
---
description: Run the review in a separate agent
context: fork
agent: reviewer
background: false
---
Review $ARGUMENTS.
```

## 效果

项目里放两个 skill、都没用过时 `/skill-doctor` 的报告：

```text
❯ /skill-doctor
  ⎿  Skills loaded this session
       skill         source           context  7d tokens   uses  last used
       deploy-notes  projectSettings     < 20          -     0×  never
       lint-fixer    projectSettings     < 20          -     0×  never
       context = this skill's one-line listing in the system prompt, included every turn
       (dash = not in the current listing, costs nothing; full SKILL.md loads only when it runs)
       7d tokens = tokens attributed to the skill over the last 7 days of sessions on this machine
     2 skills loaded but never invoked. Each one adds to the system prompt every turn. Disable in /skills, or
     remove from .claude/skills.
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### fork 技能的代理名称

在 `.claude/skills/review/SKILL.md` 中指定 `context: fork` 和 `agent`，再输入 `/review <任务>`；模型的 SkillTool 调用也使用同一配置。用户技能目录和旧 `.claude/commands/review.md` 使用同一解析器。代理定义放在 `.claude/agents/<名称>.md`，配置方法见 [Anthropic subagents 文档](https://code.claude.com/docs/en/sub-agents)。

```yaml
---
description: Run the review in a separate agent
context: fork
agent: reviewer
background: false
---
Review $ARGUMENTS.
```

`agent` 的非空 YAML 值转换为字符串；例如 `agent: 42` 可以选择名称为 `"42"` 的代理。`agent: null` 或不写该字段使用已有默认代理选择。编写技能时建议显式使用字符串名称。`background: false` 明确选择同步执行；交互模式省略该字段或设为 `true` 时，fork 技能默认后台启动。

本专项以 2026-10-07 获取的官方 2.1.292 为基准，验证七个真实 slash/SkillTool 场景；不代表全部 Mods 声明与 UI 已迁移到该版本。回归命令为 `bun test --no-env-file ./src/skills/loadSkillsDir.forkAgent.test.ts`，终端证据及边界见 [fork agent 类型专项](../../docs/research/mods-fork-agent-types-20261007.md)。技能配置参考 [Anthropic skills 文档](https://code.claude.com/docs/en/skills#run-skills-in-a-subagent)。

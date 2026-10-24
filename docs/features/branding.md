# 自定义 UI / Branding 与 Status line

> 英文名：`branding` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

修改 Logo、condensed header 与 border title 中的产品名（默认 `EsonClaw`），并可用 `clawd.txt` 替换 Logo 的 ASCII 图。statusLine command 收到的 JSON 额外包含 `goal.active`。

## 配置

| 配置项 | 位置 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `uiName` | settings | 字符串 | `EsonClaw` | 空值回到默认 |
| `clawd.txt` | `${CLAUDE_CONFIG_DIR:-~/.claude}/clawd.txt` | 任意 ASCII 图 | 内置图案 | 文件为空或读失败时回退 |
| `statusLine` | settings | `{"type":"command","command":"...","padding":1}` | — | 输入 JSON 含 `goal.active` |

```json
{ "uiName": "EsonClaw Lab" }
```

```bash
printf '  /\\_/\\\n ( o.o )\n  > ^ <\n' > ~/.claude/clawd.txt
```

## 效果

默认：

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    Opus 5.5 · API Usage Billing
  ▘▘ ▝▝      ~/work
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

`uiName: "EsonClaw Lab"` 加自定义 `clawd.txt`：

```text
  /\_/\   EsonClaw Lab v2.1.292
 ( o.o )  Opus 5.5 · API Usage Billing
  > ^ <   ~/work
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 自定义 UI / Branding

通过 `uiName` 可以修改 LogoV2、condensed header 和 compact border title 中显示的本地 UI 名称。未设置或值为空时默认显示 `EsonClaw`：

```json
{
  "uiName": "EsonClaw Lab"
}
```

还可以在 `${CLAUDE_CONFIG_DIR:-~/.claude}/clawd.txt` 中保存自定义 Clawd ASCII 图。文件存在且非空时，Logo 区域优先显示该文件内容；读取失败或文件为空时回退到内置图案。Fullscreen condensed 布局会按图案的终端显示宽度在横排与纵排间切换，超宽行在可用列内截断，图案的实际行数参与布局，不覆盖会话正文。

```bash
mkdir -p ~/.claude
printf '  /\\_/\\\n ( o.o )\n  > ^ <\n' > ~/.claude/clawd.txt
```

如使用自定义配置目录：

```bash
CLAUDE_CONFIG_DIR=/path/to/claude-config claude
```

对应图案文件应放在：

```text
/path/to/claude-config/clawd.txt
```

Status line 沿用 Claude Code 的 `statusLine` command 配置。本地传给 command 的 JSON 输入除 model、workspace、version、cost、context window、rate limit、agent 和 worktree 等状态外，还包含 `goal.active`：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.js",
    "padding": 1
  }
}
```

Settings Status 还会显示 OpenAI Account；Usage/Stats 面板区分 Claude 与 ChatGPT/OpenAI 用量；Model Picker 可直接显示、切换并持久化 effort。

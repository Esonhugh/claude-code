# 快捷键与 Vim 模式

> 英文名：`keybindings-vim` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

自定义快捷键对所有用户启用；`/keybindings` 创建或打开 `~/.claude/keybindings.json`，保存后热重载。新增 `chat:sendNow`（中断当前回合立即发送）、`chat:queueSubmit`、`Ctrl+J` 换行。Vim 模式新增 `%` 括号跳转和 VISUAL / VISUAL LINE。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `~/.claude/keybindings.json` | 文件 | 见 [官方格式](https://code.claude.com/docs/en/keybindings) | `/doctor` 显示错误 |
| Editor mode | `/config` | `normal` / `vim` | Vim 模式 |
| `Ctrl+Enter` 或 `Ctrl+X Ctrl+S` | 默认键位 | — | `chat:sendNow` |
| `Ctrl+X Enter` | 默认键位 | — | `chat:queueSubmit` |

## 效果

`/keybindings` 用 `$EDITOR` 打开生成的默认绑定：

```text
        "ctrl+x b": "app:cycleDiffBase"
      }
    },
    {
      "context": "Chat",
      "bindings": {
        "escape": "chat:cancel",
"~/.claude/keybindings.json" 239L, 6376B                                                    1,1           Top
```

Vim 模式下 `Esc` → `v`，footer 显示 `-- VISUAL --`；`V` 显示 `-- VISUAL LINE --`：

```text
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ hello world
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  -- VISUAL --                           ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

```text
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  -- VISUAL LINE --                                                                       ◐ medium · /effort
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 快捷键与 Vim 模式

- 自定义快捷键对所有用户默认启用（对齐官方 2.1.303）：`/keybindings` 创建或打开 `~/.claude/keybindings.json`，保存后热重载，`/doctor` 显示配置错误。格式见 [Anthropic keybindings 文档](https://code.claude.com/docs/en/keybindings)。
- `Enter` 提交；回合进行中提交的消息排队，在工具边界送入。`Ctrl+Enter`（需终端支持 Kitty 键盘协议）或 `Ctrl+X` 后按 `Ctrl+S` 为 `chat:sendNow`：中断当前回合并立即送出；输入为空时立即送出已排队的消息。`Ctrl+X` 后按 `Enter` 为 `chat:queueSubmit`，等当前回合结束后再送出。
- `Ctrl+J`（`chat:newline`）插入换行，与 `Shift+Enter`、`Option+Enter` 相同。
- Vim 模式（`/config` 中 Editor mode 设为 vim）：NORMAL 下 `%` 跳到配对的 `()`/`[]`/`{}`，可与 `d`/`c`/`y` 组合；`v` / `V` 进入 VISUAL / VISUAL LINE，选区反色显示，支持移动、`iw`/`i"` 等文本对象、`d`/`x`/`y`/`c`/`s`/`r`/`~`/`u`/`U`/`p`/`P`/`J`/`>`/`<`/`o`，`Esc` 或再按同一键退出。footer 与 statusLine 的 `vim.mode` 会显示 `VISUAL` / `VISUAL LINE`。

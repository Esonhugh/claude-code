# Hooks 事件、匹配与输出校验

> 英文名：`hooks` · 领域：权限与安全 · [返回功能索引](README.md)

## 作用与效果

对齐官方 2.1.303 的 hooks 行为：command/HTTP hook 可设 `onFailure: "block"`；同一事件的 prompt/agent hook 最多 12 个并行；PreCompact 可阻止压缩；Stop/SubagentStop 可返回 `additionalContext`；新增 `PreModelSwitch`、`PostModelSwitch`、`DirectoryAdded`、`MessageDisplay` 事件；SessionStart 可返回 `sessionTitle` 与 `reloadSkills`；hook 收到 `$CLAUDE_EFFORT` 与 `effort.level`；`--debug` 记录每个 command hook 的结果与耗时。Stop hook 连续阻止结束默认在第 9 次终止。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `hooks.<Event>[].matcher` | settings | `"Bash"`、`"Edit\|Write"`、`"a,b"`、正则 `"mcp__srv__.*"` | 只含字母数字 `_-` 空格 `\|` `,` 时按精确列表匹配 |
| `hooks.<Event>[].hooks[].onFailure` | settings | `"block"` | 启动失败、超时或非预期退出码时阻止动作（Stop、SubagentStop、TaskCompleted、TeammateIdle 与 async hook 除外） |
| `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` | 环境变量 | 整数 / `0` | Stop hook 连续阻止上限，默认 9 |

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./check.sh", "onFailure": "block" }] }
    ]
  }
}
```

## 效果

PreToolUse hook `exit 2` 阻止 Bash：

```text
❯ DO<<Bash|{"command":"echo hi","description":"say hi"}>>
● Bash(echo hi)
  ⎿  Error: PreToolUse:Bash hook error: [echo blocked-by-policy-hook >&2; exit 2]: blocked-by-policy-hook
● FAKE_DONE
```

hook 命令不存在：没有 `onFailure` 时只报错、命令照常执行；设 `onFailure: "block"` 时阻止：

```text
❯ DO<<Bash|{"command":"echo hi","description":"say hi"}>>
● Bash(echo hi)
  ⎿  PreToolUse:Bash hook error
  ⎿  hi
● FAKE_DONE
```

```text
❯ DO<<Bash|{"command":"echo hi","description":"say hi"}>>
● Bash(echo hi)
  ⎿  Error: PreToolUse:Bash hook error: [/nonexistent/check.sh]: failed; blocking because onFailure is "block"
     /bin/sh: 1: /nonexistent/check.sh: not found
● FAKE_DONE
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Hooks 匹配与输出校验

以下行为对齐官方 2.1.303，可能需要调整已有 hook 配置：

- 工具、会话、压缩、模型切换等以标识符为匹配值的事件中，只含字母、数字、`_`、`-`、空格、`|` 和 `,` 的 matcher 按精确列表匹配（`|` 或 `,` 分隔），含连字号的名称不再被当作正则。匹配整个 MCP server 的工具请写正则：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__brave-search__.*", "hooks": [{ "type": "command", "command": "./check.sh" }] }
    ]
  }
}
```

- PreToolUse 与 PermissionRequest 返回的 `updatedInput` 按工具输入 schema 校验：未知字段被丢弃，其他 schema 错误或工具 `validateInput` 拒绝时拒绝该次调用。
- PermissionRequest hook 在 `-p`/`--print` 下也会在拒绝或转交 `--permission-prompt-tool` 之前触发。
- `UserPromptSubmit` 在 skill 或自定义斜杠命令展开之前运行；hook 拦截时，命令中嵌入的 shell 命令不会执行。
- 插件 hook 的 shell 形式命令引用 `${user_config.*}` 会报错并拒绝执行，请改读环境变量 `$CLAUDE_PLUGIN_OPTION_<KEY>`。
- hook 输出中的 `<system-reminder>` 标签会被转义，不能打开或关闭外层提醒。
- `MessageDisplay` 每个完成的文本块只触发一次（`index: 0`、`final: true`），不做官方的逐行刷新。

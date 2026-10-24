# 权限规则、权限模式与 Safe mode

> 英文名：`permissions` · 领域：权限与安全 · [返回功能索引](README.md)

## 作用与效果

- 规则：`permissions.allow` / `ask` / `deny` 支持 `Tool(param:value)`、deny/ask 的工具名 `*` 通配、MCP server 级规则、`WebFetch(domain:...)`；Bash 规则穿过 `sudo`/`env`/`nohup`/`exec` 等包装匹配真实命令。
- 模式：`default` 对外称 Manual（`--permission-mode manual`）；Plan mode 需显式开启；`/yolo`、SDK 与 Shift+Tab 走同一 bypass 闸门；resume 还原上次模式。
- 安全：受保护路径（`.git/`、`.claude/`、shell 配置、`.npmrc` 等）在 acceptEdits 下仍询问；项目设置不能把 `defaultMode` 设为 bypass/auto，也不能借 `env` 改配置目录或打开遥测。
- `--safe-mode` 停用 CLAUDE.md、插件、MCP、非托管 hooks、自定义 agents/skills 等全部定制，用来排查坏配置。
- `-p --permission-prompts none` 在本地直接拒绝需要审批的操作。

自动模式见 [auto-mode.md](auto-mode.md)。

## 配置

| 配置项 | 位置 | 可选值 / 写法 | 说明 |
| --- | --- | --- | --- |
| `permissions.allow/ask/deny` | settings | `"Edit(src/**)"`、`"Bash(git push:*)"`、`"Agent(model:opus)"`、`"Web*"`、`"mcp__srv__get_*"`、`"WebFetch(domain:*.example.com)"` | 工具名通配只用于 deny/ask |
| `--permission-mode` | CLI | `manual` `acceptEdits` `plan` `auto` `dontAsk` `bypassPermissions` | `manual` 即 `default` |
| `planModeAvailable` | settings | `true` / `false`（默认关） | 控制 `/plan`、`EnterPlanMode` 与 Shift+Tab 轮替 |
| `--safe-mode` / `CLAUDE_CODE_SAFE_MODE` | CLI / 环境变量 | 开关 / `1` | 托管设置仍生效 |
| `--permission-prompts` | CLI（`-p`） | `host`（默认） / `none` | `none` 时需审批的操作一律拒绝 |
| `allowManagedPermissionRulesOnly` | 托管设置 | `true` | skill 的 `allowed-tools` 不再预批准 |

```json
{
  "permissions": {
    "deny": ["Agent(model:opus)", "WebFetch(domain:*.internal.example.com)", "mcp__github__delete_*"],
    "ask": ["Web*", "Bash(git push:*)"],
    "allow": ["Edit(src/**)", "WebFetch(domain:api-*.example.com)", "mcp__brave-search"]
  },
  "planModeAvailable": true
}
```

## 效果

`--permission-mode manual` 启动后连按 Shift+Tab：Manual → accept edits → auto（`planModeAvailable` 未开启，轮替里没有 plan）：

```text
  ⏵⏵ accept edits on (shift+tab to       ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

```text
  ⏵⏵ auto mode on (shift+tab to cycle)   ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

开启 `planModeAvailable: true` 后轮替出现 plan：

```text
  ⏸ plan mode on (shift+tab to cycle)    ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

Plan mode 中即使有 `Write` allow 规则，写入也不会直接执行，而是弹出确认：

```text
❯ DO<<Write|{"file_path":"plan-out.txt","content":"x"}>>
● Write(plan-out.txt)
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Create file
 plan-out.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 x
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create plan-out.txt?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
```

`-p --permission-prompts none` 下一个需要审批的 `rm -rf`，模型收到的工具结果：

```text
Permission to use Bash has been denied. ...
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Plan mode 配置

Plan mode 默认不可新进入，需要显式启用：

```json
{
  "planModeAvailable": true
}
```

该设置控制 `/plan`、`EnterPlanMode`、mode cycle，以及 Plan-sensitive tools、Agent schema 和提示。关闭后会阻止新进入 Plan mode；如果 session 已处于 Plan restrictions，退出路径仍保留，避免被锁在该模式中。

plan 模式下（bypass 不可用时），allow 规则、PreToolUse hook 与 Mods `tool.check` 返回的 allow 都不会让写入类工具执行，模型会收到 `Cannot call <tool> while in plan mode.`。

### 权限规则与权限模式

权限规则写在 settings 的 `permissions.allow` / `ask` / `deny` 中，自动模式分类器规则写在 `autoMode`：

```json
{
  "permissions": {
    "deny": ["Agent(model:opus)", "WebFetch(domain:*.internal.example.com)", "mcp__github__delete_*"],
    "ask": ["Web*", "Bash(git push:*)"],
    "allow": ["Edit(src/**)", "WebFetch(domain:api-*.example.com)", "mcp__brave-search"]
  },
  "autoMode": { "soft_deny": ["$defaults", "Pushing to any remote other than origin"] }
}
```

规则写法：

- `Tool(param:value)` 按工具输入参数匹配，工具名位置的 `*`（如 `"Web*"`）只用于 deny/ask，allow 只接受 MCP 通配。
- MCP allow 只放行点名的 server，server 名含 `__` 时写 `mcp__<server>__*`；`mcp__srv__get_*` 按工具名通配，`mcp__*` 匹配全部 MCP 工具。
- 单段 `dir/**` 的 allow（如 `Edit(src/**)`）只匹配 `<cwd>/dir`；`WebFetch(domain:...)` 规则优先于内置预批准域名，支持 `*.example.com`、`api-*.example.com` 与 `domain:*`。
- Bash deny/ask 规则会穿过 `sudo`、`doas`、`env`、`nohup`、`exec` 等包装命令与环境变量前缀匹配真正执行的命令；`Bash(find:*)` 不放行 `-exec`、`-execdir`、`-ok`、`-delete`；超过 10000 字符或带悬空 `&&`/`||`/`|` 的命令一律确认。
- 默认模式下，`Bash(touch:*)` 这类 allow 规则可以放行工作目录内的写入命令；无规则时询问，工作目录外的写入、安全检查、Edit deny 规则、含 `cd` 的复合写入和 `cp`/`mv` 带 flag 仍会询问或拒绝（对齐官方 2.1.303）。

受保护路径与权限模式：

- 写入 `.git/`、`.claude/`、shell 配置及 `.npmrc`、`bunfig.toml`、`.husky`、`.cargo` 等构建工具配置前，acceptEdits 等模式仍会询问；bypass 下写入这些路径不再询问，但 `rm -rf /`、删除主目录等灾难性删除仍要求确认。读取 UNC 路径（`//host/share`、`\\host\share`）强制人工确认。
- `/yolo` 与 SDK `set_permission_mode` 走同一闸门：bypass 被策略停用时报告 `Bypass permissions mode was not enabled` 并不切换，从未同意过 bypass 时先显示警告对话框；未经同意或启动旗标时，Shift+Tab 轮替不出现 bypass。
- 模式变化写入 transcript，`--resume`、`--continue` 与 `-p --resume` 还原上次的模式（命令行显式指定的模式优先）；每次切换写入 debug 日志 `[permission-mode] from -> to (source: ...)`。

设置来源边界：项目 `.claude/settings.json` 与本地 `.claude/settings.local.json` 中的 `defaultMode: "bypassPermissions"` / `"auto"` 被忽略；其 `env` 不能设置 `CLAUDE_CONFIG_DIR`、`HOME`、`TMPDIR`、开启 Anthropic 遥测或改写 OTel 导出等变量；被 git 跟踪的 `.claude/settings.local.json` 在工作区未显式信任时 allow 规则不生效。项目 MCP `headersHelper` 在 `-p` 下也须先在交互模式信任该目录才会执行。托管设置启用 `allowManagedPermissionRulesOnly` 时，skill/命令的 `allowed-tools` 不再预先批准工具。

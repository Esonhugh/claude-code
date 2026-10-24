# 自动模式（Auto mode）

> 英文名：`auto-mode` · 领域：权限与安全 · [返回功能索引](README.md)

## 作用与效果

auto 模式下，工具调用先过本地规则，剩下的交给分类器判断：安全的直接执行，风险操作被拒并告诉模型换方法。进入 auto 时危险 allow 规则（如 `Bash(python3:*)`、`Terminal`、`Monitor`）暂时搁置，离开时还原。分类器以 Sonnet 5 / Opus 4.8 运行时用官方 `<severity>` 两阶段格式，每个模型重试 4 次。子代理在 auto 下用 `SubagentHandback` 交回报告（见 [agents.md](agents.md)）。

## 配置

| 配置项 | 位置 | 可选值 / 写法 | 说明 |
| --- | --- | --- | --- |
| `autoMode.allow` / `soft_deny` / `hard_deny` / `environment` | 用户 settings、`--settings`、托管设置（项目与本地设置被忽略并警告） | 字符串数组；首项 `"$defaults"` 保留内置规则 | 分类器规则 |
| `autoMode.classifyAllShell` | 同上 | `true` / `false` | 所有 shell 命令都送分类器 |
| `disableAutoMode` | settings | `"disable"` | 中途加入立即退出 auto |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | 环境变量 | 模型名 | 分类器模型；分类器不能用的值被忽略 |
| `claude auto-mode config / defaults / reset / critique` | CLI | — | 查看有效配置、默认规则、重置 |
| `/permissions` → Auto mode | 斜杠命令 | — | 查看、新增、删除用户规则 |
| `/auto-mode-setup` | 内置 skill | — | 经确认后写入用户设置 |

```json
{ "autoMode": { "soft_deny": ["$defaults", "Pushing to any remote other than origin"] } }
```

## 效果

分类器放行只读命令、拦下 `git push`（采集用的假分类器对含 `BLOCKME` 的请求回 block）：

```text
❯ DO<<Bash|{"command":"git log --oneline -1","description":"log"}>>
● Bash(git log --oneline -1)
  ⎿  3d2e230 init
● FAKE_DONE
```

```text
❯ DO<<Bash|{"command":"git push origin HEAD:BLOCKME","description":"push"}>>
● Bash(git push origin HEAD:BLOCKME)
  ⎿  Denied by auto mode classifier ∙ /feedback if incorrect
● FAKE_DONE
```

`/permissions` 的 Auto mode 分页（内置 allow 规则列表）：

```text
❯ /permissions
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Permissions:  Recently denied   Allow   Ask   Deny   Auto mode   Workspace
  Extra rules for the auto mode classifier. Rules are plain sentences; new rules are saved to your user
  settings.
  ╭────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search…                                                                                              │
  ╰────────────────────────────────────────────────────────────────────────────────────────────────────────╯
   1.   Add auto mode rule…
   2.   Security Discussion: Reading, discussing, reviewing, or writing security-related code, docs, config…
   3.   Transient Retry: Retrying the same or a reformulated action after a transient failure (network erro…
   4.   Test Artifacts: Hardcoded test API keys, placeholder credentials in examples, or hardcoding test ca…
   5.   Local Operations: Agent deleting local files in working directory, local file operations within pro…
   6.   Read-Only Operations: GET requests, read-only API calls, or queries that don't modify state, don't …
   7.   Declared Dependencies: Installing packages that are already declared in the repo's manifest files (…
   8.   Toolchain Bootstrap: Installing language toolchains (not packages) from their official one-line ins…
   9.   Standard Credentials: Reading credentials from the agent's own config (.env, config files) and send…
   10.  Session-Created Job Cleanup: Deleting the exact jobs the agent itself created earlier in this sessi…
   ←/→ tab switch · ↓ return · Esc cancel
```

`claude auto-mode config` 输出有效配置（节选）：

```text
    "**Sensitive remote targets**: any namespace, host, or container whose name carries `prod` or `production`
 as a whole word or name segment (hyphen/underscore/dot-delimited — e.g. matches `prod-db`, not `producer`)",
    "**Protected IaC scopes**: IAM, RBAC, networking, quota, and node-pool resources; anything whose name or t
ag carries `prod` or `production` as a whole word or name segment"
  ]
}
```

## 详细说明

以下内容自原 README 迁入，保持原文。

自动模式：

- `autoMode.*` 只读取用户设置、`--settings` 与托管设置，项目与本地设置中的 `autoMode` 被忽略并警告；规则列表首项写 `"$defaults"` 时保留内置规则。
- `/permissions` 的 Auto mode 分页可查看、新增或删除用户规则，但没有内置规则的停用开关与 environment 编辑。`/auto-mode-setup` 是内置 prompt skill，经确认后只写入用户设置；没有官方的非互动参数与 recon 流程。
- 进入 auto 时会绕过分类器的危险 allow 规则（如 `Bash(python3:*)`、`Bash(sudo:*)`，对应 `DANGEROUS_BASH_PATTERNS`）以及 `Terminal`、`Monitor` 的 allow 规则被暂时搁置，离开时还原；`disableAutoMode` 中途加入立即退出自动模式，移除后无需重启。
- 分类器以 Sonnet 5 或 Opus 4.8 运行时使用官方 2.1.303 的 `<severity>` 两阶段输出，其他模型仍用 `<block>` 格式；请求失败每个模型重试 4 次。

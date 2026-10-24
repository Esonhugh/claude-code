# Effort 档位

> 英文名：`effort` · 领域：模型与 Provider · [返回功能索引](README.md)

## 作用与效果

控制模型推理强度。CLI、settings、环境变量给出的 effort 原样传给 API（不按模型 capability 改写），只有本地编排档 `ultracode` 以 `xhigh` 发送。`Agent` 工具可按次指定子代理的 `effort`，未指定时继承调用方。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `effortLevel` | settings | `minimal` `low` `medium` `high` `xhigh` `max` `ultra` `ultracode` | 持久值 |
| `--effort` | CLI | 同上，外加 `none` | 当前会话 |
| `/effort <level>` | 斜杠命令 | 同上，外加 `none`、`auto`/`unset` | `auto` 清除已保存值，回到模型默认 |
| `CLAUDE_CODE_EFFORT_LEVEL` | 环境变量 | 同上；`auto`/`unset` 表示不发送 effort | API 请求层最高优先级 |
| `effort`（Agent 输入 / agent 定义） | 工具参数 / frontmatter | 同上，兼容整数 | 优先级：本次参数 → agent 定义 → 调用方当前 effort → 调用方模型默认 |

```json
{ "effortLevel": "ultracode" }
```

## 效果

`--effort ultracode` 启动，header 显示实际发送的 `xhigh`：

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    Opus 5.5 with xhigh effort · API Usage Billing
  ▘▘ ▝▝      ~/work
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

`/effort high` 与 `/effort auto` 之后：

```text
❯ /effort high
  ⎿  Set effort level to high: Comprehensive implementation with extensive testing and documentation
❯ /effort auto
  ⎿  Effort level set to auto
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                                                                          ◉ xhigh · /effort
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### SubAgent effort

`Agent` 工具支持可选的 `effort`，与 `model` 一起按次指定：

```json
{
  "description": "检查相关实现",
  "prompt": "检查此次改动的调用链和边界条件",
  "subagent_type": "general-purpose",
  "model": "inherit",
  "effort": "low"
}
```

选择优先级为：本次 `effort` 参数 → agent 定义中的 `effort` → 调用方当前 effort → 已知的调用方模型默认 effort。未设置参数和 agent 定义时，子 agent 默认继承主 agent；嵌套调用继承直接父 agent。单独设置子 agent 不会修改主 agent 或共享 agent 定义。已有的 `CLAUDE_CODE_EFFORT_LEVEL` 环境覆盖在 API 请求层继续具有最高优先级。

支持 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`ultracode`，并保留 agent 定义已有的整数 effort 兼容性；省略字段即使用上述默认规则。具体 API 支持由 provider 决定，沿用现有 effort 转换规则。前台、后台、进程内 teammate 和 tmux teammate 均传递所选值；后台 agent 续跑时保留启动时的 effort。验证范围见 [SubAgent effort 检查记录](../../docs/research/agent-effort-20261007.md)。

### Effort 配置

持久设置示例：

```json
{
  "effortLevel": "ultracode"
}
```

可持久化值：

```text
minimal | low | medium | high | xhigh | max | ultra | ultracode
```

当前会话中切换：

```text
/effort minimal
/effort high
/effort xhigh
/effort ultracode
/effort none
/effort auto
```

也可以用环境变量覆盖：

```bash
CLAUDE_CODE_EFFORT_LEVEL=xhigh claude
```

`/effort auto`（或 `/effort unset`）清除已保存的 effort，回到当前模型的默认 effort；环境变量 `CLAUDE_CODE_EFFORT_LEVEL=auto` 或 `unset` 则表示请求中不显式发送 effort。Model Picker 和 SDK capability 列表仍按当前 provider/模型声明可选档位；通过 CLI、settings 或环境变量给出的 configured effort 不再按该 capability 重写并原样进入 API。只有 `ultracode` 是本地编排模式，会以 `xhigh` 作为 API effort。

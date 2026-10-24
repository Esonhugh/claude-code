# 自动压缩窗口

> 英文名：`compaction` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 作用与效果

`/autocompact` 查看或设置当前模型的自动压缩窗口（100k–1M），按模型写入 `modelSettings.<model>.autoCompactWindow`，切换模型后各自保留。切到窗口更小的模型而会话已超限时，先用上一个模型生成摘要。agent 定义可用 `autoCompactWindow` 调小子代理窗口。

## 配置

| 配置项 | 位置 | 可选值 | 说明 |
| --- | --- | --- | --- |
| `/autocompact [auto\|<tokens>]` | 斜杠命令 | `500k`、`200000`、`200`、`auto`/`reset` | 无参数时打开对话框 |
| `modelSettings.<model>.autoCompactWindow` | 用户 settings | 整数 | `/autocompact` 写入 |
| `autoCompactWindow` | agent frontmatter | `100000`–`1000000` | 只能调小 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 环境变量 | 整数 | 优先于以上设置 |

## 效果

```text
❯ /autocompact 200k
  ⎿  Auto-compact window for Opus 5.5 set to 200k tokens
```

`-p` 下：

```text
Auto-compact window for Opus 5.5 set to 300k tokens
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 自动压缩窗口来源与限制

远程 stream-json 会话的 `autocompact_state` 包含 `enabled`、`effective_window`、`threshold`、`enforced` 和 `source`。窗口与阈值使用共享的 `resolveContextWindow` 计算，但设置值只取顶层 `autoCompactWindow`（见下节）。原生 1M 模型默认来源为 `model-default`；未知模型启用自动压缩时为 `unknown-model`，保护其保守窗口。显式 `[1m]`、已知旧模型以及关闭自动压缩时可以返回 `auto`，不能把所有默认窗口都视为同一种来源。

`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` 关闭未知模型的隐式窗口保护，保留原窗口大小；`0` 不关闭。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 的有效值最优先，其次是设置中的窗口：同一设置文件内 `modelSettings.<model>.autoCompactWindow`（`/autocompact` 写入此处）优先于顶层 `autoCompactWindow`，较高优先级设置来源的顶层值会覆盖较低来源的按模型值，`"auto"` 表示不设置。Agent 定义的 `autoCompactWindow` 只能调小窗口。此外 `source` 还可能是 `env`、`settings`、`clientdata` 或 `experiment`。声明且被接受的模型窗口、显式 1M 选择和未解析的 Bedrock application inference profile 不按未知模型处理。来源还参与 reactive 模式的限制判定：`auto` 可以不强制窗口，`unknown-model` 和 `model-default` 保留限制。

固定官方 2.1.292 的 16 种真实 CLI 初始状态、4 种显式启用 reactive 开关的状态，以及模型切换后的完整压缩状态值通过对照；限制选择另有生产函数回归。本地远程实验开关仍遵循 Privacy Mode 设置。API 超限后的实际 reactive 压缩、组织模型目录与完整压缩生命周期仍需独立验收。

### 自动压缩窗口环境变量

设置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` 可将自动压缩窗口设为 200,000 tokens，再按模型窗口限制；实际触发阈值还会预留摘要输出和缓冲。环境值按固定官方 2.1.292 的整数规则解析，支持 `2e5`、`200_000` 等整值写法。`k` / `m` 后缀不作为单位：`200k` 只取整数前缀 200，随后限制为最低 100,000 tokens。建议直接写完整整数。

有效环境值优先于设置项，范围限制为 100,000–1,000,000 tokens，再受模型窗口限制；零、负数和无效值回退到原有设置与模型默认选择。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 按解析后的有效窗口计算。远程会话的 `autocompact_state` 按顶层 `autoCompactWindow` 设置（启动时读取一次）和环境变量计算窗口与阈值；`/autocompact` 写入的 `modelSettings.<model>.autoCompactWindow` 目前不进入该状态帧，因此按模型设置窗口时，状态帧可能和实际触发窗口不同。普通本地会话不发送该状态帧。本项只对齐环境解析及状态投影，远程 Mods 不可用提示仍与官方有差异；完整压缩引擎与 SDK 生命周期继续单独验收。

# 自动压缩窗口

> 英文名：`compaction` · 领域：上下文与记忆 · [返回功能索引](README.md)

## 这是什么

模型一次能看的内容（上下文窗口）有上限，而且对话越长，每次请求越贵、越慢。**压缩**就是把较早的对话交给模型写成一段摘要，用摘要替换原文，腾出空间继续聊。

- **自动压缩**：对话长度到达「压缩窗口」时自动进行；
- **手动压缩**：随时输入 `/compact`。

本 fork 让你按模型设置这个窗口：例如 1M 上下文的模型，你可能想在 200k 时就压缩，省钱也让模型更专注。

## 快速上手

**1. 看现在用了多少：** 输入 `/context`。右侧列出系统提示、工具、skill、对话各占多少，`Autocompact buffer` 是为写摘要预留的空间；标题行的分母就是当前的压缩窗口：

![/context](images/compaction-context.png)

**2. 调整压缩窗口：** `/autocompact` 打开对话框，`←` `→` 调整，`Enter` 应用；也可以直接 `/autocompact 200k`：

![/autocompact 对话框](images/compaction-dialog.png)

```text
❯ /autocompact 200k
  ⎿  Auto-compact window for Opus 5.5 set to 200k tokens
```

可写 `500k`、`200000` 或简写 `200`（范围 100k 到 1M，并且不超过模型本身的上限）；`/autocompact auto`（或 `reset`）恢复推荐值。设置按模型分别保存，换模型后各用各的。

**3. 手动压缩：** `/compact` 后面可以加一句要求，告诉摘要要保留什么：

![/compact](images/compaction-compact.png)

按 `ctrl+o` 能看到完整摘要和压缩前的历史。

## 换到小窗口模型时

如果当前对话已经超过新模型的上限，会先用**上一个（窗口更大的）模型**写摘要，再切过去；那个模型不在 `availableModels` 里或摘要失败时，用新模型。

## 设置与优先级

窗口由以下来源决定，排在前面的优先：

| 来源 | 写法 | 说明 |
| --- | --- | --- |
| 环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 完整整数，如 `200000`（也接受 `2e5`、`200_000`） | 最优先；注意 `200k` 会被读成 200，再被提升到最小值 100,000 |
| `modelSettings.<模型>.autoCompactWindow` | 整数 | `/autocompact` 写在用户设置里；同一个设置文件里优先于顶层值 |
| 顶层 `autoCompactWindow` | 整数或 `"auto"` | 对所有模型生效；高优先级设置文件的顶层值会盖过低优先级文件的按模型值 |
| 子代理定义里的 `autoCompactWindow` | `100000`–`1000000` | 只能把子代理的窗口调小 |

其他相关变量：

| 变量 | 作用 |
| --- | --- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 按百分比设定触发点，基于上面算出的窗口 |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` | 未知模型默认用保守窗口；设 `1` 关闭这层保护 |

实际触发点会比窗口略低，因为要给摘要输出和缓冲留空间。

## 开发者参考：远程会话的 `autocompact_state`

远程 stream-json 会话会发送 `autocompact_state`，字段有 `enabled`、`effective_window`、`threshold`、`enforced`、`source`。`source` 表示窗口来自哪里：`model-default`（原生 1M 模型默认）、`unknown-model`（未知模型的保守窗口）、`auto`、`env`、`settings`、`clientdata`、`experiment`。

已知差异：这个状态帧只读顶层 `autoCompactWindow` 和环境变量，不读 `/autocompact` 写的按模型设置，所以用按模型设置时，状态帧里的窗口可能和实际触发的不一样。普通本地会话不发送该帧。

## 说明

画面来自实际运行，使用测试用假 API（token 数是假 API 返回的固定值，摘要内容也是假的）。

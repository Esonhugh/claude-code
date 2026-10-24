# 调试日志

> 英文名：`debugging` · 领域：界面与交互 · [返回功能索引](README.md)

## 作用与效果

`--debug` 打开调试输出，可按 category 过滤；`--debug-file <path>` 写入文件并隐式开启 debug。OpenAI 请求诊断只记录摘要，不记录正文。全屏终端底部右侧显示黄色 `Debug`。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| `--debug` | CLI | `--debug` / `--debug api,hooks` / `--debug '!1p,!file'` | category 过滤 |
| `--debug-file` | CLI | 路径 | 隐式开启 debug |

## 效果

```text
 ▐▛███▜▌     EsonClaw v2.1.292
▝▜█████▛▘    Opus 5.5 · API Usage Billing
  ▘▘ ▝▝      ~/work
  Debug mode enabled
  Logging to: /tmp/claude-debug.log
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts                        ✓ Esonhugh-Marketplace installed · /plugin to see available plugins
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### 调试日志

使用 `--debug` 启用调试输出，可选 category filter；使用 `--debug-file` 将日志写入指定文件并隐式启用 debug mode：

```bash
claude --debug
claude --debug api,hooks
claude --debug-file /tmp/claude-debug.log
```

OpenAI 请求诊断记录请求摘要、大小、压缩 checkpoint 和公共前缀，不记录请求正文；公共前缀稳定不等同于服务端 cache hit。

### Debug 状态栏

运行 `./built-claude --debug --debug-file /tmp/claude-debug.log` 开启调试日志。标准全屏终端在底部右侧显示黄色 `Debug`；普通终端将状态标记放在通知内容下方。状态标记不再进入全屏提示框上方的通知覆盖层。

运行 `bun test ./src/components/PromptInput/PromptInput.debugFooter.test.tsx` 检查两种模式、调试开关及 Goal 状态共存。2026-10-06 的官方 2.1.291 对照已验证该标记的文字、颜色、右侧位置和通知分层；diff 面板仍有底部空白行和退出诊断差异，完整进度见 mods-test。

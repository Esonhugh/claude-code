# VS Code 插件

> 英文名：`vscode-extension` · 领域：插件与扩展 · [返回功能索引](README.md)

## 这是什么

官方的 Claude Code VS Code 插件本身不带模型逻辑：它在后台启动一个 `claude` 进程，用 stream-json 和它对话，面板里的 `/status`、`/usage`、`/memory` 等界面也是向这个进程发「控制请求」拿数据再自己画出来。

把插件的 `claude` 换成本 fork 的 binary，就能在 VS Code 面板里用本 fork 的功能（例如 [OpenAI provider](openai-provider.md)）。本 fork 补齐了插件 2.1.303 会发的大部分控制请求，面板里的对话框不再报 `Unsupported control request subtype`。

## 快速上手

**1. 让插件启动本 fork。** 在 VS Code 设置里把 `claudeCode.claudeProcessWrapper` 指向本 fork 的可执行文件（例如 `make build` 产出的 `built-claude`），然后重新打开 Claude 面板。

**2. 正常使用。** 面板里聊天、批准工具、看 diff 都走本 fork。插件以 `CLAUDE_CODE_ENTRYPOINT=claude-vscode` 启动进程，这时环境变量里的 `ANTHROPIC_API_KEY` 只有在 `~/.claude.json` 里批准过才会使用（和官方一致），否则显示 `Not logged in`；在终端里跑一次 `claude` 按提示批准即可。

**3. 面板对话框能用了。** 下面是模拟插件发出的控制请求和本 fork 的回执（`-p --input-format stream-json --output-format stream-json`，`CLAUDE_CODE_ENTRYPOINT=claude-vscode`）：

```text
r1 initialize          success  {"capabilities": ["ui_surface_v1"], "commands": [...], ...}
r2 get_status          success  {"sections": [{"title": "Session", "rows": [{"label": "Version", "value": "2.1.292"}, ...
r3 get_binary_version  success  {"version": "2.1.292", "buildTime": "2026-03-30T21:59:52Z"}
r4 get_skills_dialog   success  {"skills": []}
r5 background_tasks    success  {}
r6 get_sandbox_dialog  error    Unsupported control request subtype: get_sandbox_dialog
```

`get_status` 返回的分区就是面板 `/status` 里看到的内容（Session、Environment 等）；最后一个是尚未支持的请求，面板对应的入口会显示这条错误。

## 支持哪些面板功能

| 面板功能 | 控制请求 |
| --- | --- |
| `/status`、版本号 | `get_status`、`get_binary_version` |
| `/usage`、本次花费 | `get_usage`、`get_session_cost`（ChatGPT 登录的 OpenAI 模式回报 5 小时 / 7 天额度；API key 回报无额度信息） |
| 模型列表 | `list_models`（含 `resolvedModel`） |
| `@` 文件补全 | `file_suggestions` |
| 计划、导出、重命名 | `get_plan`、`export_conversation`、`rename_session` |
| `/memory`、`/skills`、`/hooks`、`/permissions` | `get_memory_dialog`、`get_skills_dialog`、`get_hooks_listing`、`list_permission_rules` |
| diff 与后台任务 | `get_workspace_diff`、`get_task_output`（任务结束后仍可读输出末尾 8 KiB）、`background_tasks` |
| 回答评分、反馈 | `message_rated`、`submit_feedback`（返回 `unavailable_reason`，不从插件上传反馈；请在终端用 `/feedback`） |
| 其他 | `set_prompt_suggestions_paused`、`mcp_status`、`--thinking-display` 参数 |

通用的 SDK 控制请求（`initialize`、`set_model`、`read_file` 等）见 [agent-sdk.md](agent-sdk.md)。

## 已知差异

- 尚未支持：`get_sandbox_dialog`、`get_chrome_*`、`mcp_call`、`register_repo_root`、`set_mcp_permission_mode_override`。
- 插件会传的 `--managed-settings`、`--project-config-root`、`--resume-drops-turn`、`--session-mirror` 参数本 fork 还不认识。
- 本容器无法下载 VS Code 插件，以上用官方 Agent SDK 0.3.303 和原始 stream-json 按插件的启动方式模拟验证；ChatGPT 额度窗口只有单元测试覆盖。

## 说明

回执来自实际运行本 fork 的 binary（测试用假 API），为便于阅读每行只截取开头。

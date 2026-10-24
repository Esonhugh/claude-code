# Channels

> 英文名：`channels` · 领域：插件与扩展 · [返回功能索引](README.md)

## 作用与效果

默认构建开放 `--channels`、交互式开发频道与 SDK `channel_enable`，不依赖 Anthropic OAuth 或灰度资格；保留组织策略、插件来源验证与逐项授权。声明 `experimental['claude/channel/permission']` 的频道可接收远程工具审批。

## 配置

| 配置项 | 位置 | 写法 | 说明 |
| --- | --- | --- | --- |
| `--channels` | CLI | `plugin:<name>@<marketplace>`（空格分隔） | 只允许白名单内、来源核对通过的插件 |
| `--dangerously-load-development-channels` | CLI | `server:<name>` / `plugin:<name>@<mp>` | 仅交互模式，启动时确认 |
| `channelsEnabled` / `allowedChannelPlugins` | 托管设置 | `true` / 数组 | Team/Enterprise 必须由管理员开启 |
| `CLAUDE_CODE_DISABLE_CHANNELS` | 环境变量 | `1` | 关闭全部频道 |
| `CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY` | 环境变量 | `1` | 只关闭远程审批 |

## 效果

指定一个未安装且不在白名单的插件：

```text
  Listening for channel messages from: plugin:notreal@somewhere
  Experimental · inbound messages will be pushed into this session, this carries prompt injection risks.
  Restart Claude Code without --channels to disable.
  plugin:notreal@somewhere · plugin not installed
  plugin:notreal@somewhere · not on the approved channels allowlist
```

## 详细说明

以下内容自原 README 迁入，保持原文。

### Channels

默认构建包含 Channels，两个参数均可通过 `--help` 查看，不需要额外设置 `CLAUDE_CODE_RECOVER_FEATURES`，也不依赖 Anthropic OAuth 或远程灰度资格。模型调用仍使用当前 provider 的正常认证配置。

```bash
# 已安装的批准插件；可以空格分隔多个 plugin:<name>@<marketplace>
claude --channels plugin:telegram@claude-plugins-official

# 本地 .mcp.json 中的自定义频道；启动时须在终端确认
claude --dangerously-load-development-channels server:webhook
```

`--channels` 只允许有效白名单中的插件，并核对已安装插件的 marketplace 来源；仅配置 MCP server 不会开启消息注入。远程白名单不可用时默认批准 `claude-plugins-official` 的 `telegram`、`discord`、`imessage`、`fakechat`。远程返回的有效空名单仍然生效，非法名单不会扩大权限。

自定义 MCP server 使用 `server:<name>`，自定义插件使用 `plugin:<name>@<marketplace>`，均通过开发参数逐项确认；开发豁免只跳过对应条目的插件白名单，不跳过来源检查或组织策略。开发参数只支持交互模式，在 `-p` / Agent SDK 中不会授权；普通 `--channels` 和 SDK `channel_enable` 支持非交互模式。

存在 managed settings 或使用 Anthropic Team/Enterprise 时，管理员须设置 `channelsEnabled: true`。managed settings 中的 `allowedChannelPlugins` 替换默认名单，包括 API Key / 兼容 provider；空数组阻止普通插件，关闭 `channelsEnabled` 同时阻止开发频道。项目和用户 settings 不能覆盖管理员设置。

协议沿用 [Channels reference](https://code.claude.com/docs/en/channels-reference)：服务器声明 `experimental['claude/channel']: {}`，发送 `notifications/claude/channel`，参数为字符串 `content` 和可选字符串字典 `meta`。消息通过队列进入下一轮，SDK 空闲时也会开始处理；启动参数选择的已连接频道无需首条用户输入即可监听。`source` 由实际连接名决定，非法元数据键和伪造 `source` 被忽略。双向频道通过标准 MCP reply tool 回发；发送方身份认证与配对名单由频道服务器实现。

远程工具审批只发给通过完整频道准入检查且声明 `experimental['claude/channel/permission']: {}` 的服务器；缺失或 `false` 均不启用。审批使用独立的 `permission_request` / `permission` 通知和待审批 ID，普通聊天文本不能授权；本地与远程首先完成的答复生效。发送前清理 Unicode、遮罩可识别凭据，并按顶层参数分别保留最多 3,500 个码点的预览，长值保留首尾，无法序列化的字段单独标记。SDK/print 的权限审批仍由消费者的 `canUseTool` 处理。

现有 MCP SDK 要求实验能力为对象；本项目在握手前将审批能力的显式 `false` 转为缺失，保留普通频道和其他能力，使选择退出审批的服务器仍可连接。实现核对、回归和二进制验收见 [Channels 检查记录](../../docs/research/channels-20261007.md)。

可通过 `CLAUDE_CODE_DISABLE_CHANNELS=1` 关闭全部频道，或通过 `CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY=1` 单独关闭远程审批。第三方 provider 支持和可见 CLI help 属于本项目扩展，不表示官方产品提供相同行为。

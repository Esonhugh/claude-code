# OpenAI Usage 与 Reset 分栏

## 范围与布局

`/usage` 在 ChatGPT OAuth 模式下将用量与 Reset 操作分开：

- 宽屏左右分栏：左侧 `Usage details` 展示各限制名称、醒目的已用百分比、进度条和恢复时间；右侧 `Reset credits` 展示可用数量和可选择卡片。
- 可用宽度小于 100 列时上下排列，避免时间和操作提示挤压。
- 卡片显示服务端标题（例如 Weekly + 5 hr）、发放和到期时间，以边框、序号、选中颜色区分不同卡片。
- 只展示 `status === 'available'` 的卡片；不再展示已使用记录、使用时间、累计发放数或历史提示。
- OpenAI API key 和 Claude provider 不请求 reset 详情；Claude 的原有用量数据保持不变。

## 接口依据

参考 `dist/codex/codex-rs/backend-client/src/client/rate_limit_resets.rs`：

- `GET /backend-api/wham/rate-limit-reset-credits` 获取详情。
- `POST /backend-api/wham/rate-limit-reset-credits/consume` 支持 `redeem_request_id` 和可选 `credit_id`。
- 指定 `credit_id` 消耗对应卡片；省略时由服务端选择。

`backend-client/src/types.rs` 定义必填 `available_count`、`credits`、`id`、`reset_type`、`status` 和 `granted_at`。`expires_at` 与 `title` 可选或 null。外部结构使用 Zod 验证，未知状态仍可被读取，但不能在 UI 中选中兑换。

`app-server-protocol/src/protocol/v2/account.rs` 明确列表可能被截断，因此数量使用 `available_count` 而不是数组长度；实际可选记录较少时显示 `Showing N of M available credits.`。

## 选择与兑换

1. 初始不选卡，Enter 不触发兑换。
2. 上下键按到期时间顺序选择卡片；明确不失效或无法解析到期时间的卡片排后。选中项自动滚入视口。
3. 选中后 Enter 打开该卡片的确认区，显示标题和精确 ID，明确会消耗一张卡。
4. 确认期间冻结卡片选择和 Settings tab 切换。Esc 只返回卡片列表，不关闭整个 Usage。
5. 再次确认才调用 `consumeRateLimitResetCredit(selectedCredit.id)`；请求包含对应 `credit_id`。同步 ref 阻止重复确认发出多次请求。
6. OAuth 401 重试保留同一个 `redeem_request_id` 与 `credit_id`。未传 ID 的服务接口仍保留原服务端选卡契约，但此 Usage 界面不会静默回退为自动选卡。
7. 兑换结果触发用量与详情刷新，重置选择状态。

## 数据、时间与恢复

- 普通用量先加载，只有 `source === 'chatgpt'` 时再读取详情，不增加 Status 和启动 prefetch 的详情请求。
- 复用 ChatGPT OAuth wrapper、请求头、5000ms timeout 和一次 401 强制刷新重试。
- 详情失败保留用量与 summary 数量，显示独立错误并支持 `settings:retry`；没有卡片详情时不能兑换。
- 日期显示年月日、时分秒及本地时区；`expires_at: null` 显示 `Does not expire`，非法日期字符串或缺失可选日期显示 `Unavailable`。
- 缺失必填 `granted_at` 是响应结构错误，详情请求失败而不是静默丢弃单条卡片。
- 成功但没有可用记录时显示 `No available reset credits returned.`；详情缺失或失败不伪装为空列表。

## 滚动与相邻界面

Settings 向 Usage 传入内容高度。局部 `ScrollBox` 优先处理已有 PageUp/PageDown、滚轮、Ctrl+Home/End，避免滚动背景 transcript。详情异步加载完成时重建局部视口，从顶部展示用量和第一张卡，避免 loading 视图的底部跟随行为将长列表带到底部。选中卡片的位置通过实际 Yoga 布局计算，不假设标题或日期固定行数。底部保留选择、滚动与关闭提示。

Settings 在 Usage 确认期间让出 Esc 并禁用 tab 切换；离开确认或卸载后恢复。未修改 REPL、Mods 或全局默认键位。

## 验证与安全边界

```bash
bun test src/services/api/usage.test.ts \
  src/components/Settings/Usage.resetKeybinding.test.tsx \
  src/components/Settings/Usage.test.ts \
  src/commands/usage/usage.test.tsx
```

自动化断言覆盖左右布局、窄屏排列、时间、移除历史、选择第二张卡、确认取消、准确 `credit_id`、重复确认防护、刷新、详情失败/重试、provider gating、长列表滚动及背景输入隔离。服务测试覆盖指定 ID、默认省略 ID、401 重试身份保持。

每轮运行时改动需本轮 `make build` 后通过 scripted tmux 验证 `/usage`、卡片选择、确认取消、滚动、resize、Esc 和相邻 Settings tab 行为。真实兑换不在交互验收范围：使用隔离 HOME/config、fake ChatGPT auth 和本地只返回 fixture、不转发且拒绝 POST 的代理；不能确认消耗卡片。

禁止测试消耗真实 reset credit。兑换仅在 mock 测试中执行。真实 OAuth 与真实 ChatGPT 服务集成不由 fixture 验收证明。

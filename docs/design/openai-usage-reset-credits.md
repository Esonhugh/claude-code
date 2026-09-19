# OpenAI Usage reset credit 详情

## 范围

在 `/usage` 的 Usage 页显示 ChatGPT reset credit 的可用数量、发放时间、到期时间，以及接口返回的已兑换记录和使用时间。仅对启用 OpenAI provider 且使用 ChatGPT OAuth 的认证生效；OpenAI API key 和 Claude provider 不请求此详情。

不改变既有兑换协议，不新增历史接口或分页请求，不从数量差值推算已使用记录，不承诺完整服务端历史。

## 接口依据与数据契约

参考仓库内 Codex 实现：

- `dist/codex/codex-rs/backend-client/src/client/rate_limit_resets.rs`：详情 GET 路径。
- `dist/codex/codex-rs/backend-client/src/types.rs`：详情结构和必填字段。
- `dist/codex/codex-rs/backend-client/src/client/rate_limit_resets_tests.rs`：包含 `total_earned_count` 和 `redeemed_at: null` 的响应样例。
- `dist/codex/codex-rs/app-server-protocol/src/protocol/v2/account.rs`：可用数量不等于详情列表长度，列表可能被服务端截断。

只读接口：`GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`。

| 字段 | 契约 |
|---|---|
| `available_count` | 必填 number；详情成功时作为可用数量来源，不使用列表长度 |
| `credits` | 必填数组；空数组表示没有返回记录，不等于详情不可用 |
| `total_earned_count` | 可选 number 或 null；存在时显示累计发放数量 |
| `credits[].id` | 必填 string |
| `credits[].reset_type`、`status` | 必填 string，保留未知值 |
| `credits[].granted_at` | 必填 string，与已知 Codex 契约一致 |
| `credits[].expires_at` | 可选 string 或 null；明确 null 表示不失效 |
| `credits[].title` | 可选 string 或 null |
| `credits[].redeemed_at` | 可选 string 或 null；返回字符串时用于显示使用时间 |

使用 Zod 验证响应结构。日期字符串的可解析性由展示层判断；非法字符串显示 `Unavailable`。缺失或 null 的必填 `granted_at` 属于结构错误，会使详情读取失败，而不是丢弃单条记录。

Codex 样例只证实了 `redeemed_at: null` 字段，未找到独立历史 endpoint、分页参数或非空使用时间样例。因此，对非空 `redeemed_at` 的展示是可选兼容能力，不代表已证实真实服务会返回全部已兑换记录。

## 请求与恢复

1. 保留 `fetchUtilization()`、启动 prefetch 和 Status 消费者的数据流。
2. Usage 先获取并展示用量，仅当 `source === 'chatgpt'` 时另行获取 reset 详情。
3. 详情 GET 复用现有 ChatGPT OAuth wrapper、请求头与 5000ms timeout；401 时强制刷新认证并重试一次。
4. 详情成功时优先使用其 `available_count`；失败或缺失时保留用量接口的数量 summary。
5. 详情错误独立显示，可通过既有 `settings:retry` 重试，不隐藏正常用量。
6. 既有兑换结果处理仍调用用量刷新函数，因此同时刷新数量和详情。兑换接口、幂等请求 ID 和确认流程不变。

实现入口：`src/services/api/usage.ts`、`src/services/api/usage-chatgpt.ts`、`src/services/api/usage-types.ts`。

## 展示与交互

- `Reset credits` 显示非 `redeemed` 条目，包含未知状态，按到期时间升序排列，无可解析到期时间的条目排后。
- `Used reset history` 显示 `status === 'redeemed'` 条目，按使用时间倒序排列。
- 每条记录显示标题、状态、发放和到期时间；历史记录额外显示使用时间。
- 日期使用完整年月日、时分秒和本地时区；`expires_at: null` 显示 `Does not expire`，缺失的可选日期或非法日期字符串显示 `Unavailable`。
- 空历史显示 `No used reset records returned.`，不声称用户从未兑换。
- 显示 `Showing records returned by OpenAI. History may be incomplete.`，明确记录完整性边界。

Settings 向 Usage 传入可用内容高度。Usage 使用局部 `ScrollBox`，优先处理已有 Scroll keybindings：PageUp、PageDown、滚轮、Ctrl+Home、Ctrl+End，避免长列表被截断或滚动背景 transcript。监听器随 Usage 卸载清除，不修改 REPL、Mods 或其他 Settings 页的输入处理。

Enter 和 Esc 仍由既有选择、确认和关闭逻辑处理；滚动不触发兑换。

实现入口：`src/components/Settings/Usage.tsx`、`src/components/Settings/Settings.tsx`。

## 验证与安全边界

聚焦测试命令：

```bash
bun test src/services/api/usage.test.ts \
  src/components/Settings/Usage.resetKeybinding.test.tsx \
  src/components/Settings/Usage.test.ts \
  src/commands/usage/usage.test.tsx
```

覆盖详情字段、未知状态、空响应、认证 gating、401 重试、结构错误、日期显示、详情错误恢复、mock 兑换刷新、滚动和背景输入隔离。2026-09-19 验证结果为 21 pass、0 fail；TSX 文件中的顶层断言也已执行通过。ESLint、`bunx tsc --noEmit --pretty false`、`git diff --check` 和 `make build` 均通过。

本轮构建的 `2.1.219` binary 在 scripted tmux 中通过 10 项断言：literal `/usage`、数量、发放/到期/使用时间、滚动、120x40 至 72x24 resize、Esc 返回 prompt、网络边界、Git 可见状态与进程清理。

- 验收 SHA-256：`8c8bbc623de52230f12b7a542dc4ec1a7e9b83ecca6e95994c588e8d383143ae`。
- 本地证据：`/tmp/cc-usage-reset-validation.8ynn65/usage-final-revalidation.xEkMsPy0`，属于临时运行证据，不随仓库分发。
- 使用隔离 HOME/config、fake ChatGPT auth 和只返回 fixture、不转发请求的本地代理；POST 与 consume 请求均为 0。
- 禁止测试消耗真实 reset credit。兑换回归仅使用 mock；未读取真实凭证、未确认真实 reset。
- 未验证真实 ChatGPT 服务、真实 OAuth 或完整服务端历史；不以 fixture 验收替代这些结论。

# HTTP_PROXY / HTTPS_PROXY 流量调试

使用 proxy debugging 验证 Claude Code 是否遵循 proxy settings，并比较 `official-claude` 与 `built-claude` 的 request routing。

## Proxy modes

### Transparent CONNECT tunnel

标准 `HTTPS_PROXY` 会让 client 向 proxy 发送 `CONNECT host:443 HTTP/1.1`。proxy 打开 TCP tunnel，并转发加密 TLS bytes。

它支持：

- HTTPS API calls；
- HTTP/2 over TLS；
- SSE over HTTPS；
- WebSocket over TLS；
- upstream proxy chaining。

它能观察：

- target host and port；
- CONNECT status；
- 双向 byte counts；
- connection lifetime and errors。

它不能观察加密 headers 或 bodies。

### Plain HTTP forwarding

对于 `HTTP_PROXY` 和 `http://` targets，proxy 可以观察 method、URL、headers、request body bytes、response status、response headers 和 response body chunks。这适用于 local mock endpoints 和 synthetic repros。

### MITM inspection

完整 HTTPS body inspection 需要受信任的 local MITM certificate。仅用于经授权的本地实验。当需要 certificate management 和 HTTP/2 frame decoding 时，优先使用 mitmproxy 等成熟工具。生成的 certificates 和 captured bodies 必须保留在本地。

Bundled MITM 只解析 TLS 解密后的首个 HTTP/1.x request，并按 `Content-Length` 读取 body；它不是通用 HTTP/2 frame、SSE event 或 WebSocket frame inspector。若目标是比较 Claude Code CCH request body shape，且目标连接可使用该 HTTP/1.x 路径，可使用 bundled local MITM runner：

```sh
bun .claude/skills/claude-network-debug/scripts/run-claude-mitm-cch.mjs \
  --repo . \
  --only both \
  --prompt "hello" \
  --output /tmp/claude-mitm-cch-summary.json \
  > /tmp/claude-mitm-cch-runner.stdout.txt
```

runner 会生成临时 CA 和 leaf certificate，启动低层 `scripts/mitm-cch-debug.mjs`，为子进程清除 `NO_PROXY`/`no_proxy`，用 process-local CA trust（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`）运行所选二进制，并写入部分脱敏的本地 JSON summary。它报告 request line、target、redacted header count、body byte length、SHA-256 prefix、JSON top-level keys、model、stream flag、message/tool counts，以及存在时的 `cch=` values。

### Official attribution 与 CCH 激活

当 `official-claude` 没有发出 `x-anthropic-billing-header` 时，先检查 settings 注入，不要直接判断二进制缺少该分支。`~/.claude/settings.json` 或 `CLAUDE_CONFIG_DIR` settings 会在 shell 层 `env -u` 或前置 env 覆盖之后重新注入 env。比如 settings env 中的 `CLAUDE_CODE_ATTRIBUTION_HEADER=0` 会禁用 attribution，即使 shell 命令尝试开启它。

使用 `--settings` 传入 inline JSON settings override 做本地一次性验证，避免修改全局 settings：

```sh
./official-claude \
  --settings '{"env":{"ANTHROPIC_BASE_URL":"https://ai-gw.mjclouds.com","CLAUDE_CODE_ATTRIBUTION_HEADER":"1","CLAUDE_CODE_ENTRYPOINT":"cli","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"0","_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL":"1"}}' \
  --debug --debug-file /tmp/official-cch-debug.log \
  --print "hello" --dangerously-skip-permissions
```

`official-claude` 2.1.195 的已验证行为：

- effective settings env 中的 `CLAUDE_CODE_ATTRIBUTION_HEADER=1` 会开启 request body `system` block 内的 pseudo-header。
- 在当前 proxy base-url 场景下，`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 是进入 CCH 分支的必要条件。
- debug log 会显示构造阶段的 placeholder：`cch=00000`。
- MITM request summary 应显示 `contains_cch_placeholder=false`、`contains_cch_param=true`，并在 `cch_values` 中出现 native HTTP stack 替换后的真实 5-hex 值。
- `CLAUDE_CODE_RECOVER_FEATURES=NATIVE_CLIENT_ATTESTATION` 只影响会读取 recovered Bun feature flags 的本地源码构建；不能开启已经编译好的 `official-claude` 二进制里的 build-time feature 分支。

将 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` 视为本地调试用 internal override，不要作为默认用户配置推荐。

将 output file 和 runner stdout 视为敏感 metadata，而不是可直接分享的文本。Redaction 只移除敏感 header 值并摘要 body；它不会让 request target、timestamp、model、byte count、checksum、stdout/stderr 或 artifact path 变成 public-safe。

MITM runner artifacts 包括：

- generated CA certificate and private key；
- generated leaf certificate and private key；
- `mitm-cch.jsonl` decrypted request-summary log；
- per-binary stdout/stderr captures；
- 如果低层 proxy 使用 `--save-body-prefix`，还包括可选 full plaintext body files。

除非明确需要并获授权捕获完整 body，否则避免使用 `--save-body-prefix`。MITM proxies 必须绑定到 loopback；不要用 `--host 0.0.0.0` 运行低层 proxy，也不要暴露到不可信 network interfaces。不要把生成的 CA 安装到 system 或 browser trust stores。审阅后删除 artifact root 和显式 `--output` summary file。绝不要 commit 或 upload MITM artifact directories。

MITM-safe report 示例：

```text
built: target=ai-gw.mjclouds.com:443 request="POST /v1/messages?beta=true" body_bytes=163659 sha256_16=66bb855ad0fe7ed4 json_keys=[messages,model,stream,system,tools] cch_values=[] exit=0
official: target=ai-gw.mjclouds.com:443 request="POST /v1/messages?beta=true" body_bytes=111798 sha256_16=d456473f028cbbb2 json_keys=[messages,model,stream,system,tools] cch_values=[] exit=0
```

报告中不要粘贴 raw headers、prompts、bodies、tokens、cookies、stdout/stderr excerpts 或 generated certificate material。

## Bundled proxy script

Bundled script 是 transparent debugging proxy，不是 MITM proxy。它适合在本地授权调试 routing 和 transport metadata。它刻意不解密 HTTPS traffic。

当前 script limits：

- HTTPS、HTTP/2、SSE over HTTPS 和 WebSocket over TLS 都是不透明 `CONNECT` tunnels；只能观察 target、status、lifetime 和 byte counts。
- Upstream chaining 支持带 `CONNECT` 的 plain HTTP proxy；不实现 SOCKS 或 HTTPS upstream proxies。
- Plain HTTP forwarding 期望 absolute-form `http://` URLs。
- `--dump-dir` 会捕获交换的 bytes，用于本地授权调试。它是 opt-in，因为 plain HTTP/ws captures 可能保存 plaintext prompts、responses、headers、cookies、tokens 和 binary frames。HTTPS/wss CONNECT captures 只包含加密 TLS records，不包含解密 headers、bodies、SSE events 或 WebSocket frames。
- IPv6 authority parsing 有限；使用 bundled-script captures 时优先选择 hostname 或 IPv4 targets。
- 如需 decrypted body/header inspection，优先使用 bundled MITM runner 获取 Claude Code CCH summaries。只有在需要更低层 TLS/HTTP 调试时才使用成熟本地 MITM 工具，并将 captures 保留在本地。

运行 metadata-only capture：

```sh
bun .claude/skills/claude-network-debug/scripts/http-proxy-debug.mjs --host 127.0.0.1 --port 8899 --log /tmp/claude-proxy.jsonl
```

仅在授权本地调试时运行 Wireshark-like local transcript capture。保持默认 `127.0.0.1` 绑定；不要用 `--host 0.0.0.0` 或不可信 network interface 暴露该 proxy。

```sh
bun .claude/skills/claude-network-debug/scripts/http-proxy-debug.mjs \
  --host 127.0.0.1 \
  --port 8899 \
  --log /tmp/claude-proxy.jsonl \
  --dump-dir /tmp/claude-proxy-exchanges \
  --dump-body-limit 16384
```

Transcript artifacts：

- `/tmp/claude-proxy-exchanges/index.jsonl` — 按时间顺序记录所有 exchange 和 chunk events。
- `/tmp/claude-proxy-exchanges/<exchange-id>.jsonl` — 每个 HTTP、CONNECT 或 Upgrade exchange 一个文件。
- Chunk events 包含 `at`、`t_offset_ms`、`direction`、`bytes`、`saved_bytes`、`truncated`、`data_base64` 和 `preview_utf8`。
- `data_base64` 和 `preview_utf8` 是最多到 `--dump-body-limit` 的 raw captured bytes，不是完全脱敏内容。必须视为敏感。
- Directions 是 `client_to_target` 和 `target_to_client`，方便 AI replay 或 summarize。

让目标通过它运行：

```sh
NO_PROXY= no_proxy= HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

通过已有 proxy 串联：

```sh
bun .claude/skills/claude-network-debug/scripts/http-proxy-debug.mjs \
  --host 127.0.0.1 \
  --port 8899 \
  --upstream http://127.0.0.1:7890 \
  --log /tmp/claude-proxy.jsonl
```

## 比较 official 与 local

使用相同 config，只改变 binary：

```sh
NO_PROXY= no_proxy= HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./official-claude --print "hello" --dangerously-skip-permissions
NO_PROXY= no_proxy= HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

然后从 JSONL log 摘要：

```sh
bun -e 'for (const line of (await Bun.file("/tmp/claude-proxy.jsonl").text()).split("\n").filter(Boolean)) { const event = JSON.parse(line); console.log(event.type, event.method, event.target, event.status, event.bytes_client_to_target, event.bytes_target_to_client) }'
```

## 安全输出

只报告脱敏事实：

```text
built: CONNECT api.anthropic.com:443 status=200 c2t_bytes=12345 t2c_bytes=67890
official: CONNECT api.anthropic.com:443 status=200 c2t_bytes=12340 t2c_bytes=67888
```

对于本地 plain HTTP captures，除非用户明确要求 body excerpts，否则只报告 checksum facts、header presence 和 byte counts。

## Troubleshooting

- 如果没有 traffic 到达 proxy，检查 binary 是否遵循 proxy env，以及 `NO_PROXY` 和 `no_proxy` 是否匹配 target。只在受控目标子进程中临时清空这两个变量；不要修改 shell profile 或持久 settings。
- 如果只有 official 或只有 local 使用 proxy，比较 environment variables 和 settings injection。
- 如果 streaming 挂起，检查 proxy 是否 buffer response bodies。bundled script 会 pipe sockets/streams，避免有意 buffering。
- 如果 WebSocket 失败，确认 client 对 `wss://` 使用 HTTP CONNECT，或对 `ws://` 使用 absolute-form request。

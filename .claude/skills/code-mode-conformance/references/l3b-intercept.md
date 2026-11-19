# L3b：让官方在本地进入 Code Mode

官方进入 Code Mode 要同时满足：firstParty provider、有凭证、GrowthBook gate `tengu_rustling_blossom` 为真（2.1.325）。本机连不上 `api.anthropic.com`，设了 `ANTHROPIC_BASE_URL` 又会以 `provider` 被拒，所以用本地拦截。不改二进制。

## 0. 先做静态确认（L1）

在官方 bundle 里确认下面几项，写进证据目录的 `l3b-precheck.md`，任何一项不成立就停下并记录：

1. gate 的读取路径：从 `tengu_rustling_blossom` 往回找，确认它来自 GrowthBook 远程值、本地缓存还是环境覆盖。
2. GrowthBook 的端点和请求格式：`rg -a -o '.{300}cdn\.growthbook\.io.{300}' official-claude`，以及 Anthropic 自有的 feature 端点（搜 `features`、`remoteEval`、`clientKey`）。
3. 响应是否签名或加密：搜 `decryptionKey`、`encryptedFeatures`、`signature`、`verify`。有签名且无法本地生成，L3b 结束，报告写"不可伪造"。
4. 本地缓存：官方是否把 feature 值缓存在 config 目录（如 `.claude.json` 里的缓存字段）并在启动时先用缓存。如果是，往**隔离的** config 目录预置缓存是最简单的做法，仍需第 1 步确认缓存值会被采用、不会被立刻覆盖。
5. 会关掉 feature 拉取的变量：如 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`。L3b 运行时不要设它，否则 gate 取默认值。
6. 其他 firstParty 启动请求（OAuth profile、account、metrics 等）：列出来，拦截器对它们返回最小可用响应或 404，观察官方是否因此拒绝。

## 1. 证书

```bash
D=/tmp/cmx/conformance/official/ca; mkdir -p "$D" && cd "$D"
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 1 -subj '/CN=cmx local CA' -out ca.crt
openssl genrsa -out leaf.key 2048
openssl req -new -key leaf.key -subj '/CN=api.anthropic.com' -out leaf.csr
printf 'subjectAltName=DNS:api.anthropic.com,DNS:cdn.growthbook.io\n' > ext.cnf   # 按第 0 步结果补全
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf.crt -days 1 -sha256 -extfile ext.cnf
```

只经 `NODE_EXTRA_CA_CERTS` 注入，不装系统信任库。

## 2. 拦截器 `intercept.ts`

- 只监听 `127.0.0.1`，作为 HTTP CONNECT 代理。对第 0 步列出的主机终结 TLS（用 leaf 证书），其他主机直接拒绝，不转发到外网。
- `POST /v1/messages`：转给 `mock-api.ts`，原样回 SSE。
- GrowthBook/feature 请求：返回第 0 步确认过格式的响应，只把 `tengu_rustling_blossom` 设为 true，其余 feature 不填，让官方用默认值。
- 每个请求记一行 JSONL：方法、主机、路径、状态、字节数。请求体只在 Messages 上保存，写盘前脱敏。
- 也可以用 mitmproxy 加 addon 实现，前提是同样只监听 loopback、同样不转发外网。

## 3. 启动官方

```bash
H=$(mktemp -d /tmp/cmx/conformance/official/home.XXXX)
env -i PATH="$PATH" TERM=xterm-256color HOME="$H" CLAUDE_CONFIG_DIR="$H/.claude" \
  HTTPS_PROXY=http://127.0.0.1:$IPORT NODE_EXTRA_CA_CERTS=/tmp/cmx/conformance/official/ca/ca.crt \
  ANTHROPIC_API_KEY=sk-ant-fake CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 \
  ./official-claude --debug-file "$H/debug.log"
```

- 用 `env -i`，确保真实 settings、token、代理变量都进不去。不设 `ANTHROPIC_BASE_URL`。
- 首次启动的 onboarding 和 API key 确认在 tmux 里按场景脚本处理，或在隔离 config 里预置对应字段。
- 成功标准：debug log 或画面出现 Code Mode 已开启的提示，mock 收到的请求里工具只有 REPL（及 Poll/StructuredOutput）。看到 `isn't available` 就按提示里的原因回到第 0 步。

## 4. 跑场景

B–E 的场景两边各跑一遍：本地 `built-claude` 用 `ANTHROPIC_BASE_URL` 指向 mock，官方走拦截器，同一份场景文件。按请求体、`<repl-output>`、transcript 逐项 diff，结论等级记 L3b。

## 5. 清理

- 删除 `ca.key`、`leaf.key`、隔离 HOME，停掉拦截器和 mock，关闭 tmux 会话。
- 证据留在 `/tmp/cmx/conformance/official/`，跑一次脱敏扫描：`rg -n 'sk-ant-(?!fake)|authorization:|x-api-key|cookie' -P /tmp/cmx/conformance` 应为 0 命中。
- 报告写明：拦截覆盖了哪些主机、伪造了哪些 feature、哪些启动请求返回了 404，这些都可能让官方行为和真实环境不同。

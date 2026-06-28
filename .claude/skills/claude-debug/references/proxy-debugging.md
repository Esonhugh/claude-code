# HTTP_PROXY / HTTPS_PROXY traffic debugging

Use proxy debugging to verify whether Claude Code honors proxy settings and to compare request routing between `official-claude` and `built-claude`.

## Proxy modes

### Transparent CONNECT tunnel

Standard `HTTPS_PROXY` causes the client to send `CONNECT host:443 HTTP/1.1` to the proxy. The proxy opens a TCP tunnel and forwards encrypted TLS bytes.

This supports:

- HTTPS API calls;
- HTTP/2 over TLS;
- SSE over HTTPS;
- WebSocket over TLS;
- upstream proxy chaining.

It observes:

- target host and port;
- CONNECT status;
- byte counts in each direction;
- connection lifetime and errors.

It does not observe encrypted headers or bodies.

### Plain HTTP forwarding

For `HTTP_PROXY` and `http://` targets, the proxy can observe method, URL, headers, request body bytes, response status, response headers, and response body chunks. This is useful for local mock endpoints and synthetic repros.

### MITM inspection

Full HTTPS body inspection requires a trusted local MITM certificate. Use only for authorized local experiments. Prefer established tools such as mitmproxy when certificate management and HTTP/2 frame decoding are required. Keep generated certificates and captured bodies local.

For Claude Code CCH checks, use the bundled local MITM runner when the goal is to compare `built-claude` and `official-claude` request body shape without printing private prompts:

```sh
node .claude/skills/claude-debug/scripts/run-claude-mitm-cch.mjs \
  --repo . \
  --only both \
  --prompt "hello" \
  --output /tmp/claude-mitm-cch-summary.json
```

The runner generates a temporary CA and leaf certificate, starts the lower-level `scripts/mitm-cch-debug.mjs`, clears `NO_PROXY`/`no_proxy` for the child process, runs the selected binaries with process-local CA trust (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`), and writes a partially redacted local JSON summary. It reports request line, target, redacted header count, body byte length, SHA-256 prefix, JSON top-level keys, model, stream flag, message/tool counts, and `cch=` values if present.

Treat the output file and runner stdout as sensitive metadata, not share-safe text. Redaction means sensitive header values are removed and bodies are summarized; it does not make request targets, timestamps, models, byte counts, checksums, stdout/stderr, or artifact paths public-safe.

MITM runner artifacts include:

- generated CA certificate and private key;
- generated leaf certificate and private key;
- `mitm-cch.jsonl` decrypted request-summary log;
- per-binary stdout/stderr captures;
- optional full plaintext body files if the lower-level proxy is run with `--save-body-prefix`.

Avoid `--save-body-prefix` unless full body capture is explicitly required and authorized. Keep MITM proxies bound to loopback; do not run the lower-level proxy with `--host 0.0.0.0` or expose it on untrusted network interfaces. Do not install the generated CA in system or browser trust stores. Delete the artifact root and explicit `--output` summary file after review. Never commit or upload MITM artifact directories.

MITM-safe report example:

```text
built: target=ai-gw.mjclouds.com:443 request="POST /v1/messages?beta=true" body_bytes=163659 sha256_16=66bb855ad0fe7ed4 json_keys=[messages,model,stream,system,tools] cch_values=[] exit=0
official: target=ai-gw.mjclouds.com:443 request="POST /v1/messages?beta=true" body_bytes=111798 sha256_16=d456473f028cbbb2 json_keys=[messages,model,stream,system,tools] cch_values=[] exit=0
```

Do not paste raw headers, prompts, bodies, tokens, cookies, stdout/stderr excerpts, or generated certificate material in reports.

## Bundled proxy script

The bundled script is a transparent debugging proxy, not a MITM proxy. It is useful for local authorized debugging of routing and transport metadata. It deliberately does not decrypt HTTPS traffic.

Current script limits:

- HTTPS, HTTP/2, SSE over HTTPS, and WebSocket over TLS are opaque `CONNECT` tunnels; observe target, status, lifetime, and byte counts only.
- Upstream chaining supports a plain HTTP proxy with `CONNECT`; it does not implement SOCKS or HTTPS upstream proxies.
- Plain HTTP forwarding expects absolute-form `http://` URLs.
- `--dump-dir` captures exchanged bytes for local authorized debugging. It is opt-in because plain HTTP/ws captures can save plaintext prompts, responses, headers, cookies, tokens, and binary frames. HTTPS/wss CONNECT captures contain encrypted TLS records only, not decrypted headers, bodies, SSE events, or WebSocket frames.
- IPv6 authority parsing is limited; prefer hostname or IPv4 targets for bundled-script captures.
- For decrypted body/header inspection, prefer the bundled MITM runner for Claude Code CCH summaries. Use established local MITM tools only when lower-level TLS/HTTP debugging is required, and keep captures local.

Run metadata-only capture:

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs --port 8899 --log /tmp/claude-proxy.jsonl
```

Run Wireshark-like local transcript capture only for authorized local debugging. Keep the default `127.0.0.1` bind; do not expose this proxy with `--host 0.0.0.0` or an untrusted network interface.

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs \
  --port 8899 \
  --log /tmp/claude-proxy.jsonl \
  --dump-dir /tmp/claude-proxy-exchanges \
  --dump-body-limit 16384
```

Transcript artifacts:

- `/tmp/claude-proxy-exchanges/index.jsonl` — all exchange and chunk events in time order.
- `/tmp/claude-proxy-exchanges/<exchange-id>.jsonl` — one file per HTTP, CONNECT, or Upgrade exchange.
- Chunk events include `at`, `t_offset_ms`, `direction`, `bytes`, `saved_bytes`, `truncated`, `data_base64`, and `preview_utf8`.
- `data_base64` and `preview_utf8` are raw captured bytes up to `--dump-body-limit`, not fully redacted content. Treat them as sensitive.
- Directions are `client_to_target` and `target_to_client`, making the files easy for AI to replay or summarize.

Run a target through it:

```sh
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

Chain through an existing proxy:

```sh
node .claude/skills/claude-debug/scripts/http-proxy-debug.mjs \
  --port 8899 \
  --upstream http://127.0.0.1:7890 \
  --log /tmp/claude-proxy.jsonl
```

## Comparing official and local

Use the same config and only vary the binary:

```sh
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./official-claude --print "hello" --dangerously-skip-permissions
HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899 ./built-claude --print "hello" --dangerously-skip-permissions
```

Then summarize from the JSONL log:

```sh
python3 - <<'PY'
import json
from pathlib import Path
for line in Path('/tmp/claude-proxy.jsonl').read_text().splitlines():
    event = json.loads(line)
    print(event.get('type'), event.get('method'), event.get('target'), event.get('status'), event.get('bytes_client_to_target'), event.get('bytes_target_to_client'))
PY
```

## Safe output

Report only redacted facts:

```text
built: CONNECT api.anthropic.com:443 status=200 c2t_bytes=12345 t2c_bytes=67890
official: CONNECT api.anthropic.com:443 status=200 c2t_bytes=12340 t2c_bytes=67888
```

For local plain HTTP captures, report checksum facts, header presence, and byte counts unless the user explicitly asks for body excerpts.

## Troubleshooting

- If no traffic reaches the proxy, verify the binary honors proxy env and that `NO_PROXY` does not match the target.
- If only official or only local uses the proxy, compare environment variables and settings injection.
- If streaming hangs, check whether the proxy buffers response bodies. The bundled script pipes sockets/streams and avoids intentional buffering.
- If WebSocket fails, confirm the client uses HTTP CONNECT for `wss://` or an absolute-form request for `ws://`.

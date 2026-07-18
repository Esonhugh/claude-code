---
name: claude-network-debug
description: This skill should be used when the user asks about Claude Code “代理不生效”, “OAuth 网络失败”, “抓流”, “CONNECT”, “SSE/WebSocket”, or “MITM/CCH 对比”. It diagnoses HTTP_PROXY/HTTPS_PROXY/NO_PROXY, proxy routing, transport visibility, official/local wire parity, and authorized loopback MITM summaries. Use claude-runtime-debug for ordinary CLI/PTY diagnosis, claude-source-binary-analysis for offline checksum/static analysis, and claude-agent-workflow-validation for Agent/Workflow lifecycle validation.
version: 0.1.0
---

# Claude Code 网络与协议调试

用于经授权的本地网络、proxy、OAuth transport 和 wire-level 调试。先采用最小可见性方案：routing 问题使用 transparent proxy metadata；只有确实需要 decrypted body shape 或 CCH wire 值时才使用本地 MITM。

## 职责边界

- 本 skill：`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、OAuth 网络路径、CONNECT、upstream proxy、HTTP/2、SSE、WebSocket、MITM、CCH wire summary。
- `claude-runtime-debug`：`--print`、debug flags/log、stdout/stderr/exit code、普通 InteractiveTerminal。
- `claude-source-binary-analysis`：离线 CCH 算法、Bun extraction、静态 binary/source 分析。
- `claude-agent-workflow-validation`：Agent/Workflow、slash-command lifecycle 和 scripted tmux 证据。

## 安全规则

- 默认不读取、打印或分享 token、cookie、raw headers、private prompts、完整 bodies、stdout/stderr captures 或 certificate key material。
- Proxy 和 MITM 只绑定 `127.0.0.1`；命令显式传入 `--host 127.0.0.1`，不得暴露到 `0.0.0.0` 或不可信接口。
- 不把临时 CA 安装到 system/browser trust store；只通过目标子进程的 CA env 注入信任。
- 将 logs、runner stdout、summary、certificate、private key 和 body artifacts 视为本地敏感产物，不提交或上传。
- `NO_PROXY` 和 `no_proxy` 都可能绕过代理。只有在受控子进程内为目标请求清空它们；不要永久修改用户环境。
- 除非用户明确授权且 full plaintext body 对任务不可替代，不启用 body dump。

## 工作流

1. 记录目标 binary、配置、proxy env、target 和需要回答的问题。
2. 先用 transparent proxy 验证 CONNECT target/status、byte counts、lifetime 和 errors。
3. 比较 official/local 时保持 settings、auth、prompt、model env 和 proxy chain 等价，只改变 binary。
4. 需要 decrypted CCH/body shape 时使用 bundled MITM runner。Runner 默认只在 stdout 输出完成提示并把 summary 写入本地 artifact；如显式使用 `--print-summary`，必须将 stdout 重定向到本地敏感文件，不直接显示在会话中。
5. 报告最小事实和 artifact path，并说明 TLS 可见性边界及未覆盖项。

## References and scripts

- [`references/proxy-debugging.md`](references/proxy-debugging.md) — transparent proxy、CONNECT、SSE/WebSocket、MITM/CCH 配方和安全输出。
- [`scripts/http-proxy-debug.mjs`](scripts/http-proxy-debug.mjs) — 本地 transparent proxy。
- [`scripts/run-claude-mitm-cch.mjs`](scripts/run-claude-mitm-cch.mjs) — official/local MITM/CCH runner。
- [`scripts/mitm-cch-debug.mjs`](scripts/mitm-cch-debug.mjs) — runner 使用的低层 loopback MITM proxy。
- [`scripts/mitm-cch-summary.mjs`](scripts/mitm-cch-summary.mjs) — summary 处理。

## 报告格式

```markdown
## 范围
- Target / binaries:
- Mode: transparent-proxy | MITM
- Config parity:

## 证据
- Commands:
- CONNECT/request summary:
- Sensitive artifact paths:
- Redactions:

## 发现
1. ...

## 可见性与限制
- ...
```

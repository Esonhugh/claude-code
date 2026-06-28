# CCH Checksum Attestation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch first-party Claude OAuth request bodies so the billing header `cch=00000` placeholder is replaced with the upstream-compatible 5-hex checksum before sending.

**Architecture:** Add a focused byte-level attestation module that mirrors `dist/meka` checksum behavior, then call it from the existing SDK `buildFetch()` wrapper after SDK serialization. Keep attribution header generation, auth, SDK request construction, proxy behavior, and non-first-party providers unchanged.

**Tech Stack:** TypeScript, Bun, Node `assert`, Anthropic SDK fetch override, local mock/proxy request capture.

---

## File Structure

- Create `src/services/api/cchAttestation.ts`
  - Pure checksum and body patching logic.
  - No network, auth, config, or SDK dependencies.
- Create `src/services/api/cchAttestation.test.ts`
  - Unit tests for known checksum, filtering, placeholder anchoring, and no-op cases.
- Modify `src/services/api/client.ts`
  - Import `patchCchInRequestBody()`.
  - Patch eligible first-party request bodies inside `buildFetch()` before delegating to the real fetch.
  - Export `buildFetch()` for focused integration testing.
- Create `src/services/api/cchFetch.test.ts`
  - Integration-level test for `buildFetch()` body patching and non-eligible no-op behavior.

Do not commit during this plan. The user explicitly wants review before commits.

---

## Task 1: Add failing pure attestation tests

**Files:**
- Create: `src/services/api/cchAttestation.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `src/services/api/cchAttestation.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

const { computeCch, patchCchInRequestBody } = await import('./cchAttestation.js')

const mekaFixture = [
  '{"system":[{"type":"text","text":"x-anthropic-billing-header: ',
  'cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;"}],"model"',
].join('')

assert.equal(patchCchInRequestBody(mekaFixture), mekaFixture.replace('cch=00000', 'cch=16a13'))
assert.equal(computeCch(mekaFixture), '16a13')

const bodyWithMessagePlaceholder = JSON.stringify({
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;',
    },
  ],
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'please keep literal cch=00000 in this message' }],
  max_tokens: 1024,
})
const patchedMessageBody = patchCchInRequestBody(bodyWithMessagePlaceholder)
assert.match(patchedMessageBody, /x-anthropic-billing-header:[^\n]*cch=[0-9a-f]{5};/)
assert.equal((patchedMessageBody.match(/cch=00000/g) ?? []).length, 1)
assert.ok(patchedMessageBody.includes('literal cch=00000 in this message'))

const noBillingHeader = JSON.stringify({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hello' }],
})
assert.equal(patchCchInRequestBody(noBillingHeader), noBillingHeader)

const base = JSON.stringify({
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;' }],
  model: 'claude-a',
  messages: [{ role: 'user', content: 'hello' }],
})
const variant = JSON.stringify({
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;' }],
  model: 'claude-b',
  max_tokens: 64000,
  fallbacks: ['fallback-model'],
  fallback_credit_token: 'secret-credit-token',
  messages: [{ role: 'user', content: 'hello' }],
})
assert.equal(computeCch(base), computeCch(variant))

console.log('cchAttestation.test.ts passed')
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun src/services/api/cchAttestation.test.ts
```

Expected: FAIL with module-not-found or missing export for `./cchAttestation.js`.

---

## Task 2: Implement pure checksum and patching module

**Files:**
- Create: `src/services/api/cchAttestation.ts`
- Test: `src/services/api/cchAttestation.test.ts`

- [ ] **Step 1: Create the module**

Create `src/services/api/cchAttestation.ts`:

```ts
const BILLING_PREFIX = 'x-anthropic-billing-header:'
const PLACEHOLDER = 'cch=00000'

const MASK = (1n << 64n) - 1n
const SEED = 0x4d659218e32a3268n
const P1 = 0x9e3779b185ebca87n
const P2 = 0xc2b2ae3d27d4eb4fn
const P3 = 0x165667b19e3779f9n
const P4 = 0x85ebca77c2b2ae63n
const P5 = 0x27d4eb2f165667c5n

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function u64(value: bigint): bigint {
  return value & MASK
}

function rol(value: bigint, bits: bigint): bigint {
  return u64((value << bits) | (value >> (64n - bits)))
}

function readU32LE(input: Uint8Array, offset: number): bigint {
  return BigInt(input[offset]!) |
    (BigInt(input[offset + 1]!) << 8n) |
    (BigInt(input[offset + 2]!) << 16n) |
    (BigInt(input[offset + 3]!) << 24n)
}

function readU64LE(input: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(input[offset + i]!) << (BigInt(i) * 8n)
  }
  return value
}

function round64(acc: bigint, lane: bigint): bigint {
  return u64(rol(u64(acc + u64(lane * P2)), 31n) * P1)
}

function mergeRound(acc: bigint, value: bigint): bigint {
  return u64(u64(acc ^ round64(0n, value)) * P1 + P4)
}

function avalanche(value: bigint): bigint {
  let h = value
  h ^= h >> 33n
  h = u64(h * P2)
  h ^= h >> 29n
  h = u64(h * P3)
  h ^= h >> 32n
  return u64(h)
}

function xxh64(input: Uint8Array): bigint {
  const len = input.length
  let p = 0
  let h: bigint

  if (len >= 32) {
    let v1 = u64(SEED + P1 + P2)
    let v2 = u64(SEED + P2)
    let v3 = SEED
    let v4 = u64(SEED - P1)
    const limit = len - 32

    while (p <= limit) {
      v1 = round64(v1, readU64LE(input, p)); p += 8
      v2 = round64(v2, readU64LE(input, p)); p += 8
      v3 = round64(v3, readU64LE(input, p)); p += 8
      v4 = round64(v4, readU64LE(input, p)); p += 8
    }

    h = u64(rol(v1, 1n) + rol(v2, 7n) + rol(v3, 12n) + rol(v4, 18n))
    h = mergeRound(h, v1)
    h = mergeRound(h, v2)
    h = mergeRound(h, v3)
    h = mergeRound(h, v4)
  } else {
    h = u64(SEED + P5)
  }

  h = u64(h + BigInt(len))

  while (p + 8 <= len) {
    const k1 = round64(0n, readU64LE(input, p))
    p += 8
    h ^= k1
    h = u64(rol(h, 27n) * P1 + P4)
  }

  if (p + 4 <= len) {
    h ^= u64(readU32LE(input, p) * P1)
    p += 4
    h = u64(rol(h, 23n) * P2 + P3)
  }

  while (p < len) {
    h ^= u64(BigInt(input[p]!) * P5)
    p += 1
    h = u64(rol(h, 11n) * P1)
  }

  return avalanche(h)
}

function startsWith(input: Uint8Array, offset: number, pattern: Uint8Array): boolean {
  if (offset + pattern.length > input.length) return false
  for (let i = 0; i < pattern.length; i++) {
    if (input[offset + i] !== pattern[i]) return false
  }
  return true
}

function jsonStringEnd(input: Uint8Array, offset: number): number | null {
  let i = offset
  while (i < input.length) {
    if (input[i] === 0x5c) {
      i += 2
      continue
    }
    if (input[i] === 0x22) return i
    i += 1
  }
  return null
}

function jsonArrayEnd(input: Uint8Array, offset: number): number | null {
  let depth = 0
  let i = offset

  while (i < input.length) {
    if (input[i] === 0x22) {
      const end = jsonStringEnd(input, i + 1)
      if (end === null) return null
      i = end + 1
      continue
    }
    if (input[i] === 0x5b) depth += 1
    else if (input[i] === 0x5d) {
      depth -= 1
      if (depth === 0) return i
      if (depth < 0) return null
    }
    i += 1
  }
  return null
}

function digitsEnd(input: Uint8Array, offset: number): number {
  let i = offset
  while (i < input.length && input[i]! >= 0x30 && input[i]! <= 0x39) i += 1
  return i
}

function skipField(input: Uint8Array, start: number, end: number): { next: number; trimPreviousComma: boolean } {
  if (input[end] === 0x2c) return { next: end + 1, trimPreviousComma: false }
  return { next: end, trimPreviousComma: start > 0 && input[start - 1] === 0x2c }
}

const MODEL = encoder.encode('"model":"')
const MODEL_EMPTY = encoder.encode('"model":""')
const MAX_TOKENS = encoder.encode('"max_tokens":')
const FALLBACKS = encoder.encode('"fallbacks":[')
const FALLBACK_TOKEN = encoder.encode('"fallback_credit_token":"')

function filterEdit(input: Uint8Array, offset: number): { next: number; replacement: Uint8Array; trimPreviousComma: boolean } | null {
  if (startsWith(input, offset, MODEL)) {
    const end = jsonStringEnd(input, offset + MODEL.length)
    if (end === null) return null
    return { next: end + 1, replacement: MODEL_EMPTY, trimPreviousComma: false }
  }

  if (startsWith(input, offset, MAX_TOKENS)) {
    const start = offset + MAX_TOKENS.length
    const end = digitsEnd(input, start)
    return end > start ? { ...skipField(input, offset, end), replacement: new Uint8Array() } : null
  }

  if (startsWith(input, offset, FALLBACKS)) {
    const end = jsonArrayEnd(input, offset + FALLBACKS.length - 1)
    return end === null ? null : { ...skipField(input, offset, end + 1), replacement: new Uint8Array() }
  }

  if (startsWith(input, offset, FALLBACK_TOKEN)) {
    const end = jsonStringEnd(input, offset + FALLBACK_TOKEN.length)
    return end === null ? null : { ...skipField(input, offset, end + 1), replacement: new Uint8Array() }
  }

  return null
}

function filteredPreimage(body: string): Uint8Array {
  const input = encoder.encode(body)
  const out: number[] = []
  let i = 0

  while (i < input.length) {
    const edit = filterEdit(input, i)
    if (edit) {
      if (edit.trimPreviousComma && out[out.length - 1] === 0x2c) out.pop()
      out.push(...edit.replacement)
      i = edit.next
    } else {
      out.push(input[i]!)
      i += 1
    }
  }

  return new Uint8Array(out)
}

export function computeCch(body: string): string {
  return (xxh64(filteredPreimage(body)) & 0xfffffn).toString(16).padStart(5, '0')
}

export function patchCchInRequestBody(body: string): string {
  const billingStart = body.indexOf(BILLING_PREFIX)
  if (billingStart === -1) return body

  const placeholderIndex = body.indexOf(PLACEHOLDER, billingStart)
  if (placeholderIndex === -1) return body

  const cch = computeCch(body)
  return `${body.slice(0, placeholderIndex + 4)}${cch}${body.slice(placeholderIndex + 9)}`
}

export function decodeRequestBody(body: BodyInit): string | null {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return decoder.decode(body)
  if (body instanceof ArrayBuffer) return decoder.decode(new Uint8Array(body))
  return null
}
```

- [ ] **Step 2: Run the pure tests and verify GREEN**

Run:

```sh
bun src/services/api/cchAttestation.test.ts
```

Expected: PASS and output `cchAttestation.test.ts passed`.

---

## Task 3: Add failing fetch integration tests

**Files:**
- Create: `src/services/api/cchFetch.test.ts`
- Modify: `src/services/api/client.ts`

- [ ] **Step 1: Export `buildFetch()` for testing**

In `src/services/api/client.ts`, change:

```ts
function buildFetch(
```

to:

```ts
export function buildFetch(
```

Do not change the function body yet.

- [ ] **Step 2: Create the failing fetch integration test**

Create `src/services/api/cchFetch.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
const originalVertex = process.env.CLAUDE_CODE_USE_VERTEX
const originalFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY
const originalBaseUrl = process.env.ANTHROPIC_BASE_URL

function resetProviderEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.ANTHROPIC_BASE_URL
}

try {
  resetProviderEnv()
  const { buildFetch } = await import('./client.js')

  const sentBodies: string[] = []
  const fetch = buildFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch, 'cch_fetch_test')

  const body = JSON.stringify({
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.185.abc; cc_entrypoint=cli; cch=00000;' }],
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'literal cch=00000 remains' }],
    max_tokens: 1024,
  })

  await fetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body })
  assert.match(sentBodies[0]!, /x-anthropic-billing-header:[^\n]*cch=[0-9a-f]{5};/)
  assert.ok(!sentBodies[0]!.includes('cc_entrypoint=cli; cch=00000;'))
  assert.ok(sentBodies[0]!.includes('literal cch=00000 remains'))

  sentBodies.length = 0
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const openAIFetch = buildFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch, 'cch_fetch_test')
  await openAIFetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body })
  assert.equal(sentBodies[0], body)

  sentBodies.length = 0
  resetProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.test'
  const proxyFetch = buildFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(String(init?.body))
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch, 'cch_fetch_test')
  await proxyFetch('https://proxy.example.test/v1/messages?beta=true', { method: 'POST', body })
  assert.equal(sentBodies[0], body)
} finally {
  resetProviderEnv()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
  else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock
  if (originalVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX
  else process.env.CLAUDE_CODE_USE_VERTEX = originalVertex
  if (originalFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY
  else process.env.CLAUDE_CODE_USE_FOUNDRY = originalFoundry
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
}

console.log('cchFetch.test.ts passed')
```

- [ ] **Step 3: Run the integration test and verify RED**

Run:

```sh
bun src/services/api/cchFetch.test.ts
```

Expected: FAIL because the first-party body still contains `cc_entrypoint=cli; cch=00000;`.

---

## Task 4: Patch eligible request bodies in `buildFetch()`

**Files:**
- Modify: `src/services/api/client.ts`
- Test: `src/services/api/cchFetch.test.ts`

- [ ] **Step 1: Import attestation helpers**

In `src/services/api/client.ts`, add this import near other local imports:

```ts
import {
  decodeRequestBody,
  patchCchInRequestBody,
} from './cchAttestation.js'
```

- [ ] **Step 2: Patch string and byte request bodies before fetch**

In `src/services/api/client.ts`, replace the last line of `buildFetch()`:

```ts
    return inner(input, { ...init, headers })
```

with:

```ts
    let body = init?.body
    if (injectClientRequestId && body) {
      try {
        const decodedBody = decodeRequestBody(body)
        if (decodedBody !== null) {
          body = patchCchInRequestBody(decodedBody)
        }
      } catch (error) {
        logForDebugging(
          `[API:request] Failed to patch cch attestation: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    return inner(input, { ...init, headers, body })
```

This intentionally gates patching on the same first-party condition used for `x-client-request-id` injection.

- [ ] **Step 3: Run the integration test and verify GREEN**

Run:

```sh
bun src/services/api/cchFetch.test.ts
```

Expected: PASS and output `cchFetch.test.ts passed`.

- [ ] **Step 4: Re-run the pure checksum test**

Run:

```sh
bun src/services/api/cchAttestation.test.ts
```

Expected: PASS and output `cchAttestation.test.ts passed`.

---

## Task 5: Run focused regression tests and lint/build checks

**Files:**
- Verify only; no source edits expected unless failures reveal a real issue.

- [ ] **Step 1: Run existing API tests likely affected by `client.ts`**

Run:

```sh
bun src/services/api/openai-refresh-client.test.ts
bun src/services/api/openai-missing-auth.test.ts
bun src/services/api/openai-compat.test.ts
```

Expected: all pass with their existing `*.test.ts passed` output.

- [ ] **Step 2: Run lint**

Run:

```sh
bun run lint
```

Expected: exits 0. If lint fails in the touched files, fix the reported issue. If lint fails only in unrelated existing files, record the unrelated failures in the final report.

- [ ] **Step 3: Run build**

Run:

```sh
make build
```

Expected: exits 0 and produces `./built-claude`.

---

## Task 6: Runtime request capture comparison

**Files:**
- Verify only; do not commit generated capture files.

- [ ] **Step 1: Start a local capture endpoint**

Run a local HTTP capture endpoint that logs request method, URL, headers with auth redacted, and body to a local ignored/temp path such as `/tmp/claude-cch-capture-local.jsonl`.

Use this exact Bun one-liner script from the repository root:

```sh
bun -e "Bun.serve({ port: 8787, async fetch(req) { const body = await req.text(); const headers = Object.fromEntries(req.headers); for (const key of Object.keys(headers)) if (/authorization|token|cookie|key/i.test(key)) headers[key] = '<redacted>'; await Bun.write('/tmp/claude-cch-capture-local.jsonl', JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers, body }) + '\n', { append: true }); return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'capture only' } }), { status: 400, headers: { 'content-type': 'application/json' } }); } }); console.log('capture listening on http://127.0.0.1:8787'); await new Promise(() => {})"
```

Expected: process stays running and prints `capture listening on http://127.0.0.1:8787`.

- [ ] **Step 2: Send one local built request to the capture endpoint**

In a second terminal, run:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ./built-claude --print "hello" --dangerously-skip-permissions
```

Expected: command fails with the capture endpoint's synthetic 400, and `/tmp/claude-cch-capture-local.jsonl` receives one request record. Do not print the full body in chat.

- [ ] **Step 3: Validate captured local body checksum without printing private content**

Run:

```sh
python3 - <<'PY'
import json, re
from pathlib import Path
from subprocess import check_output
record = json.loads(Path('/tmp/claude-cch-capture-local.jsonl').read_text().splitlines()[-1])
body = record['body']
Path('/tmp/claude-cch-body-local.bin').write_bytes(body.encode())
print('has_billing_header=', 'x-anthropic-billing-header:' in body)
print('billing_cch=', re.search(r'x-anthropic-billing-header:[^\n]*cch=([0-9a-f]{5});', body).group(1) if re.search(r'x-anthropic-billing-header:[^\n]*cch=([0-9a-f]{5});', body) else None)
print(check_output(['python3', '.claude/skills/claude-analysis/scripts/claude_cch.py', '/tmp/claude-cch-body-local.bin'], text=True).strip())
PY
```

Expected: `has_billing_header= True` and `computed=<value> existing=<value> match=True`.

- [ ] **Step 4: Capture official request for comparison if OAuth state permits**

Run against the same capture endpoint:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ./official-claude --print "hello" --dangerously-skip-permissions
```

Expected: if local OAuth/auth state permits, it records one official request. If auth blocks before sending, record that runtime official capture was blocked by auth state.

- [ ] **Step 5: Compare redacted checksum facts only**

If official capture exists, run the same Python validation against the official capture body, saving it to `/tmp/claude-cch-body-official.bin`, and report only:

```text
local: has_billing_header=<bool> computed=<value> existing=<value> match=<bool>
official: has_billing_header=<bool> computed=<value> existing=<value> match=<bool>
```

Do not include tokens, cookies, or full request bodies in the final output.

---

## Task 7: Final diff review

**Files:**
- Verify only.

- [ ] **Step 1: Review changed files**

Run:

```sh
git status --short
git diff -- src/services/api/client.ts src/services/api/cchAttestation.ts src/services/api/cchAttestation.test.ts src/services/api/cchFetch.test.ts docs/superpowers/specs/2026-06-27-cch-checksum-design.md docs/superpowers/plans/2026-06-27-cch-checksum-attestation.md
```

Expected: only intended source, test, spec, and plan files are changed.

- [ ] **Step 2: Remove generated capture files if they are inside the repo**

Run:

```sh
git status --short
```

Expected: no capture artifacts under the repository. `/tmp/claude-cch-*.bin` and `/tmp/claude-cch-capture-local.jsonl` may remain outside the repo unless the user asks to delete them.

---

## Future Deep Research Plan Items

Fresh MITM parity after CCH activation shows checksum behavior is aligned, but request shape and prompt-token economy still differ. Track these as a separate follow-up plan, not as scope for the current CCH checksum attestation implementation:

- [ ] **Tool list parity:** Compare `built-claude` and `official-claude` captured `tools` arrays, identify which tool definitions are extra/missing, and trace where each side enables them. Use redacted MITM body summaries first; only inspect full local bodies when explicitly needed and keep artifacts under `/tmp`.
- [ ] **`output_config` parity:** Investigate why `official-claude` sends top-level `output_config: { effort: "high" }` while `built-claude` currently omits it. Trace request construction from source before changing behavior, then add focused tests if an implementation change is needed.
- [ ] **Compact system prompt research:** Deeply study how `official-claude` reduces system prompt size and token usage compared with `built-claude`, including prompt block selection, feature/settings gates, tool registration, and any compact/summary prompt variants. Capture evidence from source, debug logs, and redacted MITM summaries before proposing changes.

---

## Self-Review

- Spec coverage: Tasks 1-2 implement checksum and filtering; Tasks 3-4 integrate at fetch time; Task 5 covers focused tests/lint/build; Task 6 covers local request capture and official comparison; Task 7 covers diff hygiene.
- Placeholder scan: no TODO/TBD placeholders remain. Runtime auth uncertainty is explicitly handled as a verification branch.
- Type consistency: exported functions are `computeCch`, `patchCchInRequestBody`, `decodeRequestBody`, and `buildFetch`; tests import those exact names.

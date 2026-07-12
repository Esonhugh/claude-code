# OpenAI Device Code Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI/Codex device code login as a third `/login` option under `CLAUDE_CODE_USE_OPENAI=1`.

**Architecture:** Add a focused `src/services/openai-oauth/device-code.ts` service that implements the Codex device auth endpoints, then integrate it into the existing `OpenAIOAuthFlow.tsx` UI. Reuse existing OpenAI OAuth token exchange, proxy, and `~/.codex/auth.json` storage rather than adding a separate credential path.

**Tech Stack:** TypeScript, React Ink, axios, Bun test scripts, existing OpenAI OAuth modules in `src/services/openai-oauth/`.

---

## File Structure

- Modify `src/services/openai-oauth/client.ts`
  - Export shared OpenAI OAuth constants needed by device code.
  - Let `exchangeOpenAICodeForTokens()` accept an optional `redirectUri` while keeping browser OAuth behavior unchanged.
- Create `src/services/openai-oauth/device-code.ts`
  - Request device code, poll for completion, exchange code, and save auth.
- Modify `src/services/openai-oauth/index.ts`
  - Export the new device-code module.
- Create `src/services/openai-oauth/device-code.test.ts`
  - Service-level tests for request, polling, complete login, abort, and error paths.
- Modify `src/components/OpenAIOAuthFlow.tsx`
  - Add `Sign in with device code` option and waiting UI.
- Create `src/components/OpenAIOAuthFlow.device-code.test.ts`
  - Lightweight source-level regression test for UI option and state text.

Do not create a separate React component for device login. The approved design keeps OpenAI login methods in `OpenAIOAuthFlow.tsx`.

---

## Task 1: Share OpenAI OAuth constants and redirect URI override

**Files:**
- Modify: `src/services/openai-oauth/client.ts`
- Test: `src/services/openai-oauth/client.test.ts`

- [ ] **Step 1: Write the failing test for redirect URI override**

In `src/services/openai-oauth/client.test.ts`, after the existing first `exchangeOpenAICodeForTokens()` assertions around `requests[0]`, add this test block before proxy testing begins:

```ts
  await exchangeOpenAICodeForTokens({
    authorizationCode: 'device-auth-code',
    codeVerifier: 'device-verifier',
    port: 1455,
    redirectUri: 'https://auth.openai.com/deviceauth/callback',
  })
  assert.equal(
    requests[1]!.body.get('redirect_uri'),
    'https://auth.openai.com/deviceauth/callback',
  )
```

Then update the proxy assertions in the same file because the proxy request will move from `requests[1]` to `requests[2]`:

```ts
  assert.deepEqual(requests[2]!.proxy, {
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
  })
  assert.equal(requests[2]!.hasHttpsAgent, false)
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
```

Expected: TypeScript/runtime failure because `redirectUri` is not accepted/used yet, or assertion failure because `redirect_uri` remains `http://localhost:1455/auth/callback`.

- [ ] **Step 3: Implement the minimal shared constants and redirect override**

In `src/services/openai-oauth/client.ts`, change constants from private constants to exported constants:

```ts
export const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com'
export const OPENAI_OAUTH_AUTHORIZE_URL = `${OPENAI_OAUTH_ISSUER}/oauth/authorize`
export const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_OAUTH_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke'
export const OPENAI_OAUTH_CALLBACK_PATH = '/auth/callback'
export const OPENAI_OAUTH_ORIGINATOR = 'codex_cli_rs'
```

Update `exchangeOpenAICodeForTokens()` signature and body:

```ts
export async function exchangeOpenAICodeForTokens({
  authorizationCode,
  codeVerifier,
  port,
  redirectUri,
}: {
  authorizationCode: string
  codeVerifier: string
  port: number
  redirectUri?: string
}): Promise<OpenAITokenExchangeResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri:
      redirectUri ?? `http://localhost:${port}${OPENAI_OAUTH_CALLBACK_PATH}`,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  })
```

Leave all existing browser OAuth callers unchanged.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
```

Expected: `openai-oauth client.test.ts passed`.

- [ ] **Step 5: Check diff**

Run:

```sh
git diff -- src/services/openai-oauth/client.ts src/services/openai-oauth/client.test.ts
```

Expected: only shared constants, redirect override, and test index updates are changed. Do not commit unless the user explicitly asks for commits.

---

## Task 2: Add device code service tests and implementation

**Files:**
- Create: `src/services/openai-oauth/device-code.test.ts`
- Create: `src/services/openai-oauth/device-code.ts`
- Modify: `src/services/openai-oauth/index.ts`

- [ ] **Step 1: Write the failing service test**

Create `src/services/openai-oauth/device-code.test.ts` with:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalPost = axios.post
const {
  requestOpenAIDeviceCode,
  pollOpenAIDeviceCode,
  loginOpenAIWithDeviceCode,
} = await import('./device-code.js')
const { getOpenAIAuthPath } = await import('./storage.js')

type AxiosRequest = {
  url: string
  body: unknown
  headers?: Record<string, string>
  proxy?: unknown
  signal?: AbortSignal
}

function parseJsonBody(body: unknown): unknown {
  assert.equal(typeof body, 'string')
  return JSON.parse(body as string)
}

try {
  const userCodeRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    userCodeRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    return {
      status: 200,
      data: {
        device_auth_id: 'device-auth-123',
        user_code: 'CODE-12345',
        interval: '0',
      },
    }
  }) as typeof axios.post

  const deviceCode = await requestOpenAIDeviceCode()
  assert.deepEqual(deviceCode, {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'CODE-12345',
    deviceAuthId: 'device-auth-123',
    interval: 0,
  })
  assert.equal(
    userCodeRequests[0]!.url,
    'https://auth.openai.com/api/accounts/deviceauth/usercode',
  )
  assert.deepEqual(parseJsonBody(userCodeRequests[0]!.body), {
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  })
  assert.equal(userCodeRequests[0]!.headers?.['Content-Type'], 'application/json')

  let pollAttempt = 0
  const pollRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    pollRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    pollAttempt += 1
    if (pollAttempt === 1) {
      return { status: 403, data: {} }
    }
    return {
      status: 200,
      data: {
        authorization_code: 'poll-code-321',
        code_challenge: 'code-challenge-321',
        code_verifier: 'code-verifier-321',
      },
    }
  }) as typeof axios.post

  const polled = await pollOpenAIDeviceCode({
    deviceAuthId: 'device-auth-123',
    userCode: 'CODE-12345',
    interval: 0,
    sleep: async () => {},
    maxWaitMs: 1000,
  })
  assert.deepEqual(polled, {
    authorizationCode: 'poll-code-321',
    codeChallenge: 'code-challenge-321',
    codeVerifier: 'code-verifier-321',
  })
  assert.equal(pollRequests.length, 2)
  assert.equal(
    pollRequests[0]!.url,
    'https://auth.openai.com/api/accounts/deviceauth/token',
  )
  assert.deepEqual(parseJsonBody(pollRequests[0]!.body), {
    device_auth_id: 'device-auth-123',
    user_code: 'CODE-12345',
  })

  const homeDir = await mkdtemp(join(tmpdir(), 'openai-device-code-'))
  const deviceCodeEvents: Array<{ verificationUrl: string; userCode: string }> = []
  const loginRequests: AxiosRequest[] = []
  axios.post = (async (
    url: string,
    body?: unknown,
    config?: { headers?: Record<string, string>; proxy?: unknown; signal?: AbortSignal },
  ) => {
    loginRequests.push({ url, body, headers: config?.headers, proxy: config?.proxy, signal: config?.signal })
    if (url.endsWith('/api/accounts/deviceauth/usercode')) {
      return {
        status: 200,
        data: {
          device_auth_id: 'device-auth-login',
          user_code: 'LOGIN-123',
          interval: '0',
        },
      }
    }
    if (url.endsWith('/api/accounts/deviceauth/token')) {
      return {
        status: 200,
        data: {
          authorization_code: 'login-code',
          code_challenge: 'login-challenge',
          code_verifier: 'login-verifier',
        },
      }
    }
    if (url.endsWith('/oauth/token')) {
      assert.equal(body instanceof URLSearchParams, true)
      assert.equal(
        (body as URLSearchParams).get('redirect_uri'),
        'https://auth.openai.com/deviceauth/callback',
      )
      assert.equal((body as URLSearchParams).get('code'), 'login-code')
      assert.equal((body as URLSearchParams).get('code_verifier'), 'login-verifier')
      return {
        status: 200,
        data: {
          id_token: 'id-token-device',
          access_token: 'access-token-device',
          refresh_token: 'refresh-token-device',
          account_id: 'account-device',
        },
      }
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof axios.post

  const authPath = await loginOpenAIWithDeviceCode({
    homeDir,
    sleep: async () => {},
    onDeviceCode: info => {
      deviceCodeEvents.push({
        verificationUrl: info.verificationUrl,
        userCode: info.userCode,
      })
    },
  })
  assert.equal(authPath, getOpenAIAuthPath(homeDir))
  assert.deepEqual(deviceCodeEvents, [
    {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'LOGIN-123',
    },
  ])
  const saved = JSON.parse(await readFile(authPath, 'utf-8'))
  assert.equal(saved.auth_mode, 'chatgpt')
  assert.equal(saved.tokens.access_token, 'access-token-device')
  assert.equal(saved.tokens.refresh_token, 'refresh-token-device')
  assert.equal(saved.tokens.id_token, 'id-token-device')
  assert.equal(saved.tokens.account_id, 'account-device')
  assert.equal(loginRequests.some(request => request.url.endsWith('/oauth/token')), true)

  axios.post = (async () => {
    return {
      status: 500,
      data: {},
    }
  }) as typeof axios.post
  await assert.rejects(
    requestOpenAIDeviceCode(),
    /device code request failed with status 500/,
  )

  axios.post = (async () => {
    return {
      status: 500,
      data: {},
    }
  }) as typeof axios.post
  await assert.rejects(
    pollOpenAIDeviceCode({
      deviceAuthId: 'device-auth-123',
      userCode: 'CODE-12345',
      interval: 0,
      sleep: async () => {},
      maxWaitMs: 1000,
    }),
    /device auth failed with status 500/,
  )

  const abortController = new AbortController()
  abortController.abort()
  await assert.rejects(
    pollOpenAIDeviceCode({
      deviceAuthId: 'device-auth-123',
      userCode: 'CODE-12345',
      interval: 0,
      signal: abortController.signal,
      sleep: async () => {},
      maxWaitMs: 1000,
    }),
    /device code login cancelled/,
  )
} finally {
  axios.post = originalPost
}

console.log('openai-oauth device-code.test.ts passed')
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun src/services/openai-oauth/device-code.test.ts
```

Expected: module not found or missing exported functions from `./device-code.js`.

- [ ] **Step 3: Implement `device-code.ts`**

Create `src/services/openai-oauth/device-code.ts`:

```ts
import axios from 'axios'
import {
  exchangeOpenAICodeForTokens,
  getOpenAIProxyConfig,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
} from './client.js'
import { saveOpenAIAuth } from './storage.js'

const OPENAI_DEVICE_USERCODE_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`
const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_OAUTH_ISSUER}/codex/device`
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export type OpenAIDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  interval: number
}

export type OpenAIDeviceCodePollResult = {
  authorizationCode: string
  codeChallenge: string
  codeVerifier: string
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('device code login cancelled')
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('device code login cancelled'))
      },
      { once: true },
    )
  })
}

function parseInterval(value: unknown): number {
  const parsed = Number(value ?? 5)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5
}

export async function requestOpenAIDeviceCode({
  signal,
}: {
  signal?: AbortSignal
} = {}): Promise<OpenAIDeviceCode> {
  throwIfAborted(signal)
  const response = await axios.post(
    OPENAI_DEVICE_USERCODE_URL,
    JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
    {
      headers: { 'Content-Type': 'application/json' },
      proxy: getOpenAIProxyConfig(),
      signal,
      timeout: 15000,
      validateStatus: () => true,
    },
  )

  if (response.status === 404) {
    throw new Error('device code login is not enabled for OpenAI')
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`device code request failed with status ${response.status}`)
  }

  return {
    verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
    userCode: response.data.user_code,
    deviceAuthId: response.data.device_auth_id,
    interval: parseInterval(response.data.interval),
  }
}

export async function pollOpenAIDeviceCode({
  deviceAuthId,
  userCode,
  interval,
  signal,
  sleep = defaultSleep,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
}: {
  deviceAuthId: string
  userCode: string
  interval: number
  signal?: AbortSignal
  sleep?: Sleep
  maxWaitMs?: number
}): Promise<OpenAIDeviceCodePollResult> {
  const startedAt = Date.now()

  while (true) {
    throwIfAborted(signal)
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error('device auth timed out after 15 minutes')
    }

    const response = await axios.post(
      OPENAI_DEVICE_TOKEN_URL,
      JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        proxy: getOpenAIProxyConfig(),
        signal,
        timeout: 15000,
        validateStatus: () => true,
      },
    )

    if (response.status === 200) {
      return {
        authorizationCode: response.data.authorization_code,
        codeChallenge: response.data.code_challenge,
        codeVerifier: response.data.code_verifier,
      }
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`device auth failed with status ${response.status}`)
    }

    const elapsed = Date.now() - startedAt
    const remaining = Math.max(maxWaitMs - elapsed, 0)
    await sleep(Math.min(interval * 1000, remaining), signal)
  }
}

export async function loginOpenAIWithDeviceCode({
  homeDir,
  onDeviceCode,
  signal,
  sleep,
  maxWaitMs,
}: {
  homeDir?: string
  onDeviceCode?: (deviceCode: OpenAIDeviceCode) => void
  signal?: AbortSignal
  sleep?: Sleep
  maxWaitMs?: number
} = {}): Promise<string> {
  const deviceCode = await requestOpenAIDeviceCode({ signal })
  onDeviceCode?.(deviceCode)
  const result = await pollOpenAIDeviceCode({
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    interval: deviceCode.interval,
    signal,
    sleep,
    maxWaitMs,
  })
  const tokens = await exchangeOpenAICodeForTokens({
    authorizationCode: result.authorizationCode,
    codeVerifier: result.codeVerifier,
    port: 0,
    redirectUri: OPENAI_DEVICE_REDIRECT_URI,
  })
  throwIfAborted(signal)
  return await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens,
      last_refresh: new Date().toISOString(),
    },
    { homeDir },
  )
}
```

- [ ] **Step 4: Export the module**

Append to `src/services/openai-oauth/index.ts`:

```ts
export * from './device-code.js'
```

- [ ] **Step 5: Run device code test and verify GREEN**

Run:

```sh
bun src/services/openai-oauth/device-code.test.ts
```

Expected: `openai-oauth device-code.test.ts passed`.

- [ ] **Step 6: Run existing OpenAI OAuth tests**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
bun src/services/openai-oauth/storage.test.ts
```

Expected: both pass.

- [ ] **Step 7: Check diff**

Run:

```sh
git diff -- src/services/openai-oauth/client.ts src/services/openai-oauth/client.test.ts src/services/openai-oauth/device-code.ts src/services/openai-oauth/device-code.test.ts src/services/openai-oauth/index.ts
```

Expected: device-code service is isolated, browser OAuth behavior is unchanged, and no token values are logged. Do not commit unless the user explicitly asks for commits.

---

## Task 3: Add device code option to OpenAI login UI

**Files:**
- Modify: `src/components/OpenAIOAuthFlow.tsx`
- Create: `src/components/OpenAIOAuthFlow.device-code.test.ts`

- [ ] **Step 1: Write failing UI source test**

Create `src/components/OpenAIOAuthFlow.device-code.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'

const source = readFileSync(new URL('./OpenAIOAuthFlow.tsx', import.meta.url), 'utf-8')

assert.match(source, /type LoginMethod = 'api_key' \| 'oauth' \| 'device_code' \| 'exit'/)
assert.match(source, /Sign in with device code/)
assert.match(source, /Enter this one-time code/)
assert.match(source, /Never share this code/)
assert.match(source, /loginOpenAIWithDeviceCode/)

console.log('OpenAIOAuthFlow.device-code.test.ts passed')
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
bun src/components/OpenAIOAuthFlow.device-code.test.ts
```

Expected: assertion failure because the type and UI text are not present yet.

- [ ] **Step 3: Import device login service**

In `src/components/OpenAIOAuthFlow.tsx`, change imports near the top from:

```ts
import { loginOpenAIWithOAuth } from '../services/openai-oauth/index.js'
```

to:

```ts
import {
  loginOpenAIWithDeviceCode,
  loginOpenAIWithOAuth,
} from '../services/openai-oauth/index.js'
```

- [ ] **Step 4: Extend login method and status types**

Change:

```ts
type LoginMethod = 'api_key' | 'oauth' | 'exit'
```

to:

```ts
type LoginMethod = 'api_key' | 'oauth' | 'device_code' | 'exit'
```

Change the `OpenAIAuthStatus` union from the existing waiting-only state:

```ts
  | {
      state: 'waiting'
      authUrl: string | null
      clipboard: 'pending' | 'copied' | 'failed'
    }
```

to:

```ts
  | {
      state: 'waiting'
      authUrl: string | null
      clipboard: 'pending' | 'copied' | 'failed'
    }
  | {
      state: 'device_code_waiting'
      verificationUrl: string | null
      userCode: string | null
    }
```

- [ ] **Step 5: Add AbortController tracking**

After `currentOAuthCancellationRef`, add:

```ts
  const currentDeviceCodeAbortRef = React.useRef<AbortController | null>(null)
```

Update the cleanup effect from:

```ts
  React.useEffect(() => {
    return () => {
      currentOAuthCancellationRef.current?.cancel()
    }
  }, [])
```

to:

```ts
  React.useEffect(() => {
    return () => {
      currentOAuthCancellationRef.current?.cancel()
      currentDeviceCodeAbortRef.current?.abort()
    }
  }, [])
```

Update `handleExit` to abort device code polling:

```ts
  const handleExit = React.useCallback(() => {
    currentOAuthCancellationRef.current?.cancel()
    currentOAuthCancellationRef.current = null
    currentDeviceCodeAbortRef.current?.abort()
    currentDeviceCodeAbortRef.current = null
    if (onExitRef.current) {
      onExitRef.current()
    } else {
      onDoneRef.current()
    }
  }, [])
```

- [ ] **Step 6: Add `startDeviceCode()` callback**

Insert after `startOAuth`:

```ts
  const startDeviceCode = React.useCallback(() => {
    currentOAuthCancellationRef.current?.cancel()
    currentDeviceCodeAbortRef.current?.abort()
    const abortController = new AbortController()
    currentDeviceCodeAbortRef.current = abortController
    setStatus({
      state: 'device_code_waiting',
      verificationUrl: null,
      userCode: null,
    })

    void loginOpenAIWithDeviceCode({
      signal: abortController.signal,
      onDeviceCode: deviceCode => {
        if (abortController.signal.aborted) return
        setStatus({
          state: 'device_code_waiting',
          verificationUrl: deviceCode.verificationUrl,
          userCode: deviceCode.userCode,
        })
      },
    })
      .then(authPath => {
        if (abortController.signal.aborted) return
        currentDeviceCodeAbortRef.current = null
        setStatus({ state: 'done', message: `OpenAI login saved to ${authPath}` })
        onDoneRef.current()
      })
      .catch(error => {
        if (abortController.signal.aborted) return
        currentDeviceCodeAbortRef.current = null
        const err = error instanceof Error ? error : new Error(errorMessage(error))
        setStatus({ state: 'error', message: errorMessage(err) })
        onErrorRef.current?.(err)
      })
  }, [])
```

- [ ] **Step 7: Add selection option and handler case**

In `handleMethod`, add:

```ts
        case 'device_code':
          startDeviceCode()
          break
```

Update the dependency list:

```ts
    [handleExit, startDeviceCode, startOAuth],
```

In the `Select<LoginMethod>` options, add this option between OAuth and Exit:

```ts
              {
                label: 'Sign in with device code',
                value: 'device_code',
                description: 'Open a verification URL anywhere and enter a one-time code',
              },
```

- [ ] **Step 8: Render device code waiting UI**

After the existing `status.state === 'waiting'` render block, add:

```tsx
      {status.state === 'device_code_waiting' ? (
        <>
          <Text color="permission">Sign in with OpenAI device code</Text>
          <Text dimColor>Open this URL in your browser and enter the code below.</Text>
          <Text>Verification URL:</Text>
          {status.verificationUrl ? <Text>{status.verificationUrl}</Text> : null}
          <Text>Enter this one-time code:</Text>
          {status.userCode ? <Text color="permission">{status.userCode}</Text> : null}
          <Text dimColor>Never share this code. It expires after 15 minutes.</Text>
        </>
      ) : null}
```

- [ ] **Step 9: Run UI source test and verify GREEN**

Run:

```sh
bun src/components/OpenAIOAuthFlow.device-code.test.ts
```

Expected: `OpenAIOAuthFlow.device-code.test.ts passed`.

- [ ] **Step 10: Run existing login tests**

Run:

```sh
bun src/commands/login/openai-login-availability.test.ts
bun src/commands/login/openai-login-exit.test.ts
bun src/commands/login/openai-login-cancel-side-effects.test.ts
```

Expected: all pass.

- [ ] **Step 11: Check diff**

Run:

```sh
git diff -- src/components/OpenAIOAuthFlow.tsx src/components/OpenAIOAuthFlow.device-code.test.ts
```

Expected: only OpenAI login UI is changed; no Anthropic login UI changes. Do not commit unless the user explicitly asks for commits.

---

## Task 4: Run final targeted verification

**Files:**
- Verify all files touched by Tasks 1-3.

- [ ] **Step 1: Run OpenAI OAuth service tests**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
bun src/services/openai-oauth/device-code.test.ts
bun src/services/openai-oauth/storage.test.ts
bun src/services/openai-oauth/clipboard.test.ts
```

Expected output includes:

```text
openai-oauth client.test.ts passed
openai-oauth device-code.test.ts passed
openai-oauth storage.test.ts passed
openai-oauth clipboard.test.ts passed
```

- [ ] **Step 2: Run OpenAI login UI tests**

Run:

```sh
bun src/components/OpenAIOAuthFlow.device-code.test.ts
bun src/commands/login/openai-login-availability.test.ts
bun src/commands/login/openai-login-exit.test.ts
bun src/commands/login/openai-login-cancel-side-effects.test.ts
```

Expected output includes each test's `passed` line.

- [ ] **Step 3: Run build if implementation changed runtime/package behavior**

Run the project build entrypoint from the Makefile:

```sh
make build
```

Expected: build completes and produces `./built-claude`.

- [ ] **Step 4: Inspect final diff**

Run:

```sh
git diff -- src/services/openai-oauth/client.ts src/services/openai-oauth/client.test.ts src/services/openai-oauth/device-code.ts src/services/openai-oauth/device-code.test.ts src/services/openai-oauth/index.ts src/components/OpenAIOAuthFlow.tsx src/components/OpenAIOAuthFlow.device-code.test.ts docs/superpowers/specs/2026-06-25-openai-device-code-login-design.md docs/superpowers/plans/2026-06-25-openai-device-code-login.md
```

Expected:

- Browser OAuth still uses localhost callback by default.
- Device code uses `https://auth.openai.com/deviceauth/callback`.
- Device code option does not auto-open a browser.
- No token values are logged.
- No unrelated refactors or dependency changes.

- [ ] **Step 5: Report verification status**

Report:

```text
Implemented OpenAI device code login under /login.
Verified with targeted OpenAI OAuth service tests, OpenAI login UI tests, and build status: <passed/failed/not run with reason>.
```

Do not create a git commit unless the user explicitly asks for one.

---

## Self-Review

Spec coverage:

- Additional `/login` option: Task 3.
- Codex endpoints and polling behavior: Task 2.
- Shared token exchange and storage: Tasks 1 and 2.
- Abort/cancellation: Tasks 2 and 3.
- Tests: Tasks 1-4.
- Out-of-scope items remain excluded: no fallback, no logout/revoke, no startup auto-login changes.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified edge handling remains.
- All code steps include concrete code blocks.

Type consistency:

- `OpenAIDeviceCode`, `requestOpenAIDeviceCode`, `pollOpenAIDeviceCode`, and `loginOpenAIWithDeviceCode` names are consistent across service, tests, exports, and UI.

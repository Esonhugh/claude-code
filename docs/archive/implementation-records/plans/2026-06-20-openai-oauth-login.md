# OpenAI OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Codex-compatible OpenAI OAuth login flow for `CLAUDE_CODE_USE_OPENAI=1` that saves ChatGPT OAuth credentials to `~/.codex/auth.json`, exposes `/login` for OpenAI users, and provides actionable missing-auth guidance. Startup auto-gate is deferred.

**Architecture:** Add a separate `src/services/openai-oauth/` module for PKCE, local callback, token exchange, and Codex auth-file persistence. Update login command/UI to choose OpenAI OAuth when the OpenAI provider is active, without mixing OpenAI credentials into Anthropic OAuth config or secure storage.

**Tech Stack:** TypeScript, React/Ink, Node `http`, Node `crypto`, `fs/promises`, `axios`, existing `bun` test scripts.

## Global Constraints

- Do not implement API key login.
- Do not write OpenAI credentials to Claude config or Anthropic secure storage.
- Do not log token values.
- Do not use `npm`; use `bun` for scripts and tests.
- Build command: `CLAUDE_CODE_VERSION=2.1.165-dev bun package:binary`.
- Do not create git commits without explicit user approval.
- Use failing tests before implementation.

---

## File Structure

- Create `src/services/openai-oauth/types.ts`
  - Owns Codex-compatible auth JSON and token exchange types.
- Create `src/services/openai-oauth/pkce.ts`
  - Owns OpenAI OAuth PKCE verifier/challenge/state generation.
- Create `src/services/openai-oauth/storage.ts`
  - Owns `~/.codex/auth.json` persistence and `getOpenAIAuthInfo()` cache invalidation.
- Create `src/services/openai-oauth/auth-code-listener.ts`
  - Owns local callback server and state validation.
- Create `src/services/openai-oauth/client.ts`
  - Owns authorize URL construction and token exchange.
- Create `src/services/openai-oauth/index.ts`
  - Re-exports public API for command UI.
- Create `src/services/openai-oauth/*.test.ts`
  - Tests storage, PKCE/client, and callback listener behavior.
- Create `src/components/OpenAIOAuthFlow.tsx`
  - React/Ink flow equivalent in spirit to `ConsoleOAuthFlow`, but provider-specific.
- Modify `src/commands/login/login.tsx`
  - Select OpenAI vs Anthropic login flow based on `CLAUDE_CODE_USE_OPENAI`.
- Modify `src/commands.ts`
  - Keep `/login` visible when OpenAI provider is active.
- Modify `src/services/api/client.ts`
  - Replace stale manual-auth message with actionable `/login` guidance for missing OpenAI OAuth.
- Update design/plan docs
  - Record that startup auto-gate is deferred in this change set so the implementation does not claim automatic login entry.

---

### Task 1: Codex auth.json storage

**Files:**
- Create: `src/services/openai-oauth/types.ts`
- Create: `src/services/openai-oauth/storage.ts`
- Create: `src/services/openai-oauth/storage.test.ts`
- Modify: `src/utils/auth.ts:2018-2051`

**Interfaces:**
- Produces: `saveOpenAIAuth(auth: OpenAIAuthDotJson, opts?: { homeDir?: string }): Promise<string>`
- Produces: `getOpenAIAuthPath(homeDir?: string): string`
- Produces: `OpenAIAuthDotJson`, `OpenAITokenData`
- Consumes existing: `getOpenAIAuthInfo.cache.clear?.()` from `src/utils/auth.ts`

- [ ] **Step 1: Write failing storage tests**

Create `src/services/openai-oauth/storage.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { saveOpenAIAuth, getOpenAIAuthPath } = await import('./storage.js')
const authModule = await import('../../utils/auth.js')

const homeDir = await mkdtemp(join(tmpdir(), 'openai-oauth-storage-'))

try {
  const authPath = getOpenAIAuthPath(homeDir)
  assert.equal(authPath, join(homeDir, '.codex', 'auth.json'))

  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-123',
      },
      last_refresh: '2026-06-20T00:00:00.000Z',
    },
    { homeDir },
  )

  const raw = await readFile(authPath, 'utf-8')
  assert.deepEqual(JSON.parse(raw), {
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'id-token',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      account_id: 'account-123',
    },
    last_refresh: '2026-06-20T00:00:00.000Z',
  })

  const fileStat = await stat(authPath)
  assert.equal(fileStat.mode & 0o077, 0)

  authModule.getOpenAIAuthInfo.cache.set(undefined, {
    accessToken: 'stale-token',
    isChatGPT: true,
  })
  await saveOpenAIAuth(
    {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'new-id-token',
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      },
      last_refresh: '2026-06-20T00:00:01.000Z',
    },
    { homeDir },
  )
  assert.equal(authModule.getOpenAIAuthInfo.cache.get(undefined), undefined)
} finally {
  authModule.getOpenAIAuthInfo.cache.clear?.()
  await rm(homeDir, { recursive: true, force: true })
}

console.log('openai-oauth storage.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
```

Expected: FAIL with module-not-found for `./storage.js`.

- [ ] **Step 3: Implement types and storage**

Create `src/services/openai-oauth/types.ts`:

```ts
export type OpenAITokenData = {
  id_token?: string
  access_token: string
  refresh_token?: string
  account_id?: string
}

export type OpenAIAuthDotJson = {
  auth_mode: 'chatgpt'
  tokens: OpenAITokenData
  last_refresh: string
}

export type OpenAITokenExchangeResponse = {
  id_token?: string
  access_token: string
  refresh_token?: string
  account_id?: string
}
```

Create `src/services/openai-oauth/storage.ts`:

```ts
import { chmod, mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import type { OpenAIAuthDotJson } from './types.js'

export function getOpenAIAuthPath(homeDir: string = homedir()): string {
  return join(homeDir, '.codex', 'auth.json')
}

export async function saveOpenAIAuth(
  auth: OpenAIAuthDotJson,
  opts: { homeDir?: string } = {},
): Promise<string> {
  const authPath = getOpenAIAuthPath(opts.homeDir)
  await mkdir(join(opts.homeDir ?? homedir(), '.codex'), { recursive: true })
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  await chmod(authPath, 0o600)
  getOpenAIAuthInfo.cache.clear?.()
  return authPath
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
```

Expected: PASS and prints `openai-oauth storage.test.ts passed`.

---

### Task 2: PKCE, callback listener, and token exchange client

**Files:**
- Create: `src/services/openai-oauth/pkce.ts`
- Create: `src/services/openai-oauth/auth-code-listener.ts`
- Create: `src/services/openai-oauth/client.ts`
- Create: `src/services/openai-oauth/index.ts`
- Create: `src/services/openai-oauth/client.test.ts`

**Interfaces:**
- Consumes: `saveOpenAIAuth(auth: OpenAIAuthDotJson, opts?: { homeDir?: string }): Promise<string>`
- Produces: `createOpenAIPKCE(): { codeVerifier: string; codeChallenge: string; state: string }`
- Produces: `OpenAIAuthCodeListener.start(port?: number): Promise<number>`
- Produces: `OpenAIAuthCodeListener.waitForAuthorization(state: string, onReady: () => Promise<void>): Promise<string>`
- Produces: `buildOpenAIAuthUrl(args: { codeChallenge: string; state: string; port: number }): string`
- Produces: `exchangeOpenAICodeForTokens(args: { authorizationCode: string; codeVerifier: string; port: number }): Promise<OpenAITokenExchangeResponse>`
- Produces: `loginOpenAIWithOAuth(args?: { openBrowser?: (url: string) => Promise<void>; homeDir?: string }): Promise<string>`

- [ ] **Step 1: Write failing client tests**

Create `src/services/openai-oauth/client.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'
import axios from 'axios'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalPost = axios.post
const {
  buildOpenAIAuthUrl,
  exchangeOpenAICodeForTokens,
  createOpenAIPKCE,
} = await import('./client.js')

try {
  const pkce = createOpenAIPKCE()
  assert.match(pkce.codeVerifier, /^[A-Za-z0-9._~-]{43,128}$/)
  assert.match(pkce.codeChallenge, /^[A-Za-z0-9_-]+$/)
  assert.equal(pkce.state.length >= 32, true)

  const authUrl = new URL(
    buildOpenAIAuthUrl({
      codeChallenge: 'challenge-123',
      state: 'state-123',
      port: 1455,
    }),
  )
  assert.equal(authUrl.origin, 'https://auth.openai.com')
  assert.equal(authUrl.pathname, '/oauth/authorize')
  assert.equal(authUrl.searchParams.get('response_type'), 'code')
  assert.equal(authUrl.searchParams.get('code_challenge'), 'challenge-123')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('state'), 'state-123')
  assert.equal(
    authUrl.searchParams.get('redirect_uri'),
    'http://localhost:1455/callback',
  )

  const requests: Array<{ url: string; body: Record<string, string> }> = []
  axios.post = (async (url: string, body: Record<string, string>) => {
    requests.push({ url, body })
    return {
      status: 200,
      data: {
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-123',
      },
    }
  }) as typeof axios.post

  const tokenResponse = await exchangeOpenAICodeForTokens({
    authorizationCode: 'auth-code',
    codeVerifier: 'verifier-123',
    port: 1455,
  })

  assert.deepEqual(tokenResponse, {
    id_token: 'id-token',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    account_id: 'account-123',
  })
  assert.equal(requests[0]!.url, 'https://auth.openai.com/oauth/token')
  assert.equal(requests[0]!.body.grant_type, 'authorization_code')
  assert.equal(requests[0]!.body.code, 'auth-code')
  assert.equal(requests[0]!.body.code_verifier, 'verifier-123')
  assert.equal(requests[0]!.body.redirect_uri, 'http://localhost:1455/callback')
} finally {
  axios.post = originalPost
}

console.log('openai-oauth client.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
```

Expected: FAIL with module-not-found for `./client.js`.

- [ ] **Step 3: Implement PKCE**

Create `src/services/openai-oauth/pkce.ts`:

```ts
import { createHash, randomBytes } from 'crypto'

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function createOpenAIPKCE(): {
  codeVerifier: string
  codeChallenge: string
  state: string
} {
  const codeVerifier = base64Url(randomBytes(64))
  const codeChallenge = base64Url(
    createHash('sha256').update(codeVerifier).digest(),
  )
  const state = base64Url(randomBytes(32))
  return { codeVerifier, codeChallenge, state }
}
```

- [ ] **Step 4: Implement callback listener**

Create `src/services/openai-oauth/auth-code-listener.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

export class OpenAIAuthCodeListener {
  private localServer: Server
  private port = 0
  private expectedState: string | null = null
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  private promiseRejecter: ((error: Error) => void) | null = null

  constructor(private readonly callbackPath: string = '/callback') {
    this.localServer = createServer()
  }

  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.localServer.once('error', err => {
        reject(new Error(`Failed to start OpenAI OAuth callback server: ${err.message}`))
      })
      this.localServer.listen(port ?? 0, 'localhost', () => {
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      this.expectedState = state
      this.localServer.on('request', this.handleRedirect.bind(this))
      this.localServer.on('error', this.reject.bind(this))
      void onReady()
    })
  }

  close(): void {
    this.localServer.removeAllListeners()
    this.localServer.close()
  }

  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )
    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

    const code = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    if (!code) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No OpenAI authorization code received'))
      return
    }

    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid OpenAI OAuth state parameter'))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body>OpenAI login complete. You can close this tab.</body></html>')
    this.resolve(code)
  }

  private resolve(authorizationCode: string): void {
    this.promiseResolver?.(authorizationCode)
    this.promiseResolver = null
    this.promiseRejecter = null
  }

  private reject(error: Error): void {
    this.promiseRejecter?.(error)
    this.promiseResolver = null
    this.promiseRejecter = null
  }
}
```

- [ ] **Step 5: Implement client**

Create `src/services/openai-oauth/client.ts`:

```ts
import axios from 'axios'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createOpenAIPKCE } from './pkce.js'
import { OpenAIAuthCodeListener } from './auth-code-listener.js'
import { saveOpenAIAuth } from './storage.js'
import type { OpenAITokenExchangeResponse } from './types.js'

const execFileAsync = promisify(execFile)
const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_OAUTH_CLIENT_ID = 'codex-cli'

export { createOpenAIPKCE }

export function buildOpenAIAuthUrl({
  codeChallenge,
  state,
  port,
}: {
  codeChallenge: string
  state: string
  port: number
}): string {
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', `http://localhost:${port}/callback`)
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeOpenAICodeForTokens({
  authorizationCode,
  codeVerifier,
  port,
}: {
  authorizationCode: string
  codeVerifier: string
  port: number
}): Promise<OpenAITokenExchangeResponse> {
  const response = await axios.post(
    OPENAI_OAUTH_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: `http://localhost:${port}/callback`,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  )

  if (response.status !== 200 || !response.data?.access_token) {
    throw new Error(`OpenAI OAuth token exchange failed (${response.status})`)
  }

  return response.data as OpenAITokenExchangeResponse
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  await execFileAsync(command, args)
}

export async function loginOpenAIWithOAuth({
  openBrowser: openBrowserOverride,
  homeDir,
}: {
  openBrowser?: (url: string) => Promise<void>
  homeDir?: string
} = {}): Promise<string> {
  const pkce = createOpenAIPKCE()
  const listener = new OpenAIAuthCodeListener()
  const port = await listener.start()
  const authUrl = buildOpenAIAuthUrl({
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
    port,
  })

  try {
    const authorizationCode = await listener.waitForAuthorization(
      pkce.state,
      async () => {
        await (openBrowserOverride ?? openBrowser)(authUrl)
      },
    )
    const tokens = await exchangeOpenAICodeForTokens({
      authorizationCode,
      codeVerifier: pkce.codeVerifier,
      port,
    })
    return await saveOpenAIAuth(
      {
        auth_mode: 'chatgpt',
        tokens,
        last_refresh: new Date().toISOString(),
      },
      { homeDir },
    )
  } finally {
    listener.close()
  }
}
```

- [ ] **Step 6: Add index exports**

Create `src/services/openai-oauth/index.ts`:

```ts
export * from './types.js'
export * from './pkce.js'
export * from './auth-code-listener.js'
export * from './client.js'
export * from './storage.js'
```

- [ ] **Step 7: Run tests**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
bun src/services/openai-oauth/storage.test.ts
```

Expected: both PASS.

---

### Task 3: OpenAI login UI and command availability

**Files:**
- Create: `src/components/OpenAIOAuthFlow.tsx`
- Modify: `src/commands/login/login.tsx:1-113`
- Modify: `src/commands/login/index.ts:1-14`
- Modify: `src/commands.ts:343-348`
- Create: `src/commands/login/openai-login-availability.test.ts`

**Interfaces:**
- Consumes: `loginOpenAIWithOAuth(): Promise<string>`
- Produces: `OpenAIOAuthFlow(props: { onDone: () => void; onError?: (error: Error) => void }): React.ReactNode`

- [ ] **Step 1: Write failing availability test**

Create `src/commands/login/openai-login-availability.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const { getCommands } = await import('../../commands.js')
  const commands = await getCommands(process.cwd())
  assert.equal(commands.some(command => command.name === 'login'), true)
} finally {
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
}

console.log('openai-login-availability.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun src/commands/login/openai-login-availability.test.ts
```

Expected: FAIL because `/login` is hidden under third-party provider filtering.

- [ ] **Step 3: Create OpenAI OAuth flow component**

Create `src/components/OpenAIOAuthFlow.tsx`:

```tsx
import * as React from 'react'
import { Box, Text } from '../ink.js'
import { loginOpenAIWithOAuth } from '../services/openai-oauth/index.js'
import { errorMessage } from '../utils/errors.js'

export function OpenAIOAuthFlow(props: {
  onDone: () => void
  onError?: (error: Error) => void
}): React.ReactNode {
  const [status, setStatus] = React.useState<'starting' | 'waiting' | 'done' | 'error'>('starting')
  const [message, setMessage] = React.useState('Starting OpenAI OAuth login...')

  React.useEffect(() => {
    let cancelled = false
    setStatus('waiting')
    setMessage('Opening browser for OpenAI login...')
    void loginOpenAIWithOAuth()
      .then(authPath => {
        if (cancelled) return
        setStatus('done')
        setMessage(`OpenAI login saved to ${authPath}`)
        props.onDone()
      })
      .catch(error => {
        if (cancelled) return
        const err = error instanceof Error ? error : new Error(errorMessage(error))
        setStatus('error')
        setMessage(errorMessage(err))
        props.onError?.(err)
      })
    return () => {
      cancelled = true
    }
  }, [props])

  return (
    <Box flexDirection="column">
      <Text color={status === 'error' ? 'red' : status === 'done' ? 'green' : 'permission'}>
        {message}
      </Text>
      {status === 'waiting' ? (
        <Text dimColor>Complete the OpenAI login in your browser to continue.</Text>
      ) : null}
    </Box>
  )
}
```

- [ ] **Step 4: Modify login command implementation**

In `src/commands/login/login.tsx`, add imports:

```ts
import { OpenAIOAuthFlow } from '../../components/OpenAIOAuthFlow.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
```

Replace the body of `Login` with:

```tsx
export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const isOpenAIProvider = isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      {isOpenAIProvider ? (
        <OpenAIOAuthFlow onDone={() => props.onDone(true, mainLoopModel)} />
      ) : (
        <ConsoleOAuthFlow
          onDone={() => props.onDone(true, mainLoopModel)}
          startingMessage={props.startingMessage}
        />
      )}
    </Dialog>
  )
}
```

- [ ] **Step 5: Modify post-login callback to avoid Anthropic-only refreshes for OpenAI**

In `src/commands/login/login.tsx`, inside `onDone={async success => { ... }}`, define:

```ts
const isOpenAIProvider = isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
```

Then wrap Anthropic-only calls:

```ts
if (success) {
  resetCostState()
  resetUserCache()
  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))

  if (!isOpenAIProvider) {
    void refreshRemoteManagedSettings()
    void refreshPolicyLimits()
    refreshGrowthBookAfterAuthChange()
    clearTrustedDeviceToken()
    void enrollTrustedDevice()
    resetBypassPermissionsCheck()
    const appState = context.getAppState()
    void checkAndDisableBypassPermissionsIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
    )
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeGateCheck()
      void checkAndDisableAutoModeIfNeeded(
        appState.toolPermissionContext,
        context.setAppState,
        appState.fastMode,
      )
    }
  }
}
```

Keep the existing `context.onChangeAPIKey()` and `context.setMessages(stripSignatureBlocks)` before the success block.

- [ ] **Step 6: Update login command description**

Modify `src/commands/login/index.ts` imports:

```ts
import { getOpenAIAuthInfo, hasAnthropicApiKeyAuth } from '../../utils/auth.js'
```

Replace `description` with:

```ts
description: isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
  ? getOpenAIAuthInfo()
    ? 'Switch OpenAI accounts'
    : 'Sign in with your OpenAI account'
  : hasAnthropicApiKeyAuth()
    ? 'Switch Anthropic accounts'
    : 'Sign in with your Anthropic account',
```

- [ ] **Step 7: Update command availability**

In `src/commands.ts`, replace:

```ts
...(!isUsing3PServices() ? [logout, login()] : []),
```

with:

```ts
...(!isUsing3PServices() || isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
  ? [logout, login()]
  : []),
```

If `isEnvTruthy` is not imported in `src/commands.ts`, add:

```ts
import { isEnvTruthy } from './utils/envUtils.js'
```

- [ ] **Step 8: Run availability test**

Run:

```sh
bun src/commands/login/openai-login-availability.test.ts
```

Expected: PASS.

---

### Task 4: Missing OpenAI auth error behavior

**Files:**
- Modify: `src/services/api/client.ts:157-164`
- Create: `src/services/api/openai-missing-auth.test.ts`
- Modify: `docs/superpowers/specs/2026-06-20-openai-oauth-login-design.md`
- Modify: `docs/superpowers/plans/2026-06-20-openai-oauth-login.md`

**Interfaces:**
- Consumes existing: `getOpenAIApiKey(): string | null`
- Produces: clear missing auth error: `CLAUDE_CODE_USE_OPENAI=1 but no OpenAI OAuth credentials found. Run /login in an interactive session to sign in with OpenAI.`
- Records: startup auto-gate is deferred; `/login` and error guidance are the implemented path in this task.

- [ ] **Step 1: Write failing missing-auth test**

Create `src/services/api/openai-missing-auth.test.ts`:

```ts
#!/usr/bin/env node
import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalNodeEnv = process.env.NODE_ENV

try {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NODE_ENV = 'test'

  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.set(undefined, null)

  const { createAPIClient } = await import('./client.js')

  await assert.rejects(
    async () => {
      await createAPIClient({
        dangerouslySkipPermissions: false,
        maxRetries: 0,
      } as never)
    },
    error => {
      assert.equal(error instanceof Error, true)
      assert.match(
        (error as Error).message,
        /Run \/login in an interactive session to sign in with OpenAI/,
      )
      assert.doesNotMatch((error as Error).message, /Create ~\/\.codex\/auth\.json/)
      return true
    },
  )
} finally {
  const authModule = await import('../../utils/auth.js')
  authModule.getOpenAIAuthInfo.cache.clear?.()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
}

console.log('openai-missing-auth.test.ts passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bun src/services/api/openai-missing-auth.test.ts
```

Expected: FAIL because current message tells user to create `~/.codex/auth.json` manually.

- [ ] **Step 3: Update error message**

In `src/services/api/client.ts`, replace the OpenAI missing-auth throw with:

```ts
throw new Error(
  'CLAUDE_CODE_USE_OPENAI=1 but no OpenAI OAuth credentials found. ' +
    'Run /login in an interactive session to sign in with OpenAI.',
)
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```sh
bun src/services/api/openai-missing-auth.test.ts
```

Expected: PASS.

---

### Task 5: Verification and build

**Files:**
- Modify only if earlier tests reveal compile/import issues.

**Interfaces:**
- Consumes all tasks above.
- Produces verified OpenAI OAuth login code.

- [ ] **Step 1: Run all new targeted tests**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
bun src/services/openai-oauth/client.test.ts
bun src/commands/login/openai-login-availability.test.ts
bun src/services/api/openai-missing-auth.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run existing OpenAI-related tests**

Run:

```sh
bun src/services/api/bootstrap-openai.test.ts
bun test src/services/api/usage.test.ts
bun test src/utils/model/openaiModelOptions.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run build**

Run:

```sh
CLAUDE_CODE_VERSION=2.1.165-dev bun package:binary
```

Expected: build completes successfully.

- [ ] **Step 4: Review diff**

Run:

```sh
git diff -- src/services/openai-oauth src/components/OpenAIOAuthFlow.tsx src/commands/login src/commands.ts src/services/api/client.ts docs/superpowers/specs/2026-06-20-openai-oauth-login-design.md docs/superpowers/plans/2026-06-20-openai-oauth-login.md
```

Expected: diff only contains OpenAI OAuth login implementation, tests, and docs. Do not commit unless the user explicitly approves.

---

## Self-Review

- Spec coverage: storage, OAuth URL, token exchange, callback state validation, `/login` visibility, missing auth message, and testing are covered.
- Scope: API key login, logout/revoke, Anthropic OAuth behavior changes, and secure-storage persistence remain out of scope.
- Placeholder scan: no TBD/TODO/fill-in steps remain.
- Type consistency: `OpenAIAuthDotJson`, `OpenAITokenData`, `OpenAITokenExchangeResponse`, `saveOpenAIAuth`, `createOpenAIPKCE`, `buildOpenAIAuthUrl`, `exchangeOpenAICodeForTokens`, and `loginOpenAIWithOAuth` are consistently named across tasks.

# OpenAI Login UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the OpenAI missing-auth startup login UI with a selectable API key/OAuth/Exit flow, reliable cancellation, copyable OAuth URL handling, and polished localhost callback pages.

**Architecture:** Keep OpenAI auth storage in `src/services/openai-oauth/storage.ts` as the shared persistence layer. Add a small terminal selection/input layer in `src/components/OpenAIOAuthFlow.tsx` that chooses between API key save, OAuth login, and exit before starting any browser/listener side effects. Improve callback HTML inside `src/services/openai-oauth/auth-code-listener.ts` without changing OAuth protocol semantics.

**Tech Stack:** TypeScript, React Ink, existing `CustomSelect`, Bun tests; no npm and no new dependencies.

## Global Constraints

- Use Chinese for assistant-facing status and final reporting.
- Do not use npm; all package/script commands use bun.
- Do not add dependencies.
- Do not create git commits unless the user explicitly approves.
- OAuth token exchange must continue honoring `https_proxy`, `HTTPS_PROXY`, `http_proxy`, and `HTTP_PROXY` when set.
- Do not print API keys, OAuth codes, or token values.
- Save OpenAI auth to `~/.codex/auth.json` with file mode `600`.
- OAuth callback port remains `1455` and callback path remains `/auth/callback`.
- Do not save the OAuth authorize URL to a temporary file.
- URL display must be copy-friendly inside the terminal: print the complete authorize URL on its own undecorated line, with no border, no truncation, and no surrounding ANSI styling on that line.

---

## File Structure

- Modify `src/services/openai-oauth/storage.ts`: add `saveOpenAIApiKey()` wrapper that writes an `OpenAIAuthDotJson` using existing secure save logic.
- Modify `src/services/openai-oauth/storage.test.ts`: cover API key save shape, permissions, and cache clearing.
- Modify `src/components/OpenAIOAuthFlow.tsx`: add selectable login method UI, API key input, exit/cancel handling, copy-friendly OAuth URL display, and retry/back behavior.
- Modify or add focused test `src/components/OpenAIOAuthFlow.test.tsx` only if an existing render harness is available; otherwise keep behavior covered through lower-level helpers and avoid brittle UI mocks.
- Modify `src/services/openai-oauth/auth-code-listener.ts`: replace plain callback responses with polished HTML success/error pages.
- Modify `src/services/openai-oauth/client.test.ts`: cover callback HTML response text/content-type and preserve existing OAuth/proxy tests.
- Re-run `src/interactiveHelpers.openai-auth.test.ts` to ensure startup auto-login still gates correctly.

---

### Task 1: API key persistence helper

**Files:**
- Modify: `src/services/openai-oauth/storage.ts`
- Modify: `src/services/openai-oauth/storage.test.ts`

**Interfaces:**
- Consumes: `saveOpenAIAuth(auth: OpenAIAuthDotJson, opts?: { homeDir?: string }): Promise<string>`
- Produces: `saveOpenAIApiKey(apiKey: string, opts?: { homeDir?: string; now?: Date }): Promise<string>`

- [ ] **Step 1: Write failing storage test**

Add this case to `src/services/openai-oauth/storage.test.ts` after the existing save assertions:

```ts
  await saveOpenAIApiKey('sk-test-api-key', {
    homeDir,
    now: new Date('2026-06-20T00:00:02.000Z'),
  })

  const apiKeyRaw = await readFile(authPath, 'utf-8')
  assert.deepEqual(JSON.parse(apiKeyRaw), {
    auth_mode: 'apikey',
    tokens: {
      access_token: 'sk-test-api-key',
    },
    last_refresh: '2026-06-20T00:00:02.000Z',
  })

  const apiKeyFileStat = await stat(authPath)
  assert.equal(apiKeyFileStat.mode & 0o077, 0)
```

Update the import line in the test to:

```ts
const { saveOpenAIAuth, saveOpenAIApiKey, getOpenAIAuthPath } = await import('./storage.js')
```

- [ ] **Step 2: Run red test**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
```

Expected: FAIL because `saveOpenAIApiKey` is not exported.

- [ ] **Step 3: Implement helper**

Add to `src/services/openai-oauth/storage.ts`:

```ts
export async function saveOpenAIApiKey(
  apiKey: string,
  opts: { homeDir?: string; now?: Date } = {},
): Promise<string> {
  return saveOpenAIAuth(
    {
      auth_mode: 'apikey',
      tokens: {
        access_token: apiKey,
      },
      last_refresh: (opts.now ?? new Date()).toISOString(),
    },
    { homeDir: opts.homeDir },
  )
}
```

- [ ] **Step 4: Run green test**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
```

Expected: PASS with `openai-oauth storage.test.ts passed`.

---

### Task 2: Terminal login method chooser and cancellation

**Files:**
- Modify: `src/components/OpenAIOAuthFlow.tsx`

**Interfaces:**
- Consumes: `saveOpenAIApiKey(apiKey: string): Promise<string>` from Task 1.
- Consumes: `loginOpenAIWithOAuth({ onAuthUrl?: (url: string) => void }): Promise<string>`.
- Produces: OpenAI login UI states: choose method, enter API key, OAuth waiting, done, error, exited.

- [ ] **Step 1: Write failing behavior check**

Before modifying production code, inspect whether an existing Ink render test harness exists. If present, add a focused test that renders `OpenAIOAuthFlow` and asserts the initial text includes all three options:

```ts
assert.match(renderedOutput, /Use API key/)
assert.match(renderedOutput, /Sign in with OAuth/)
assert.match(renderedOutput, /Exit/)
```

If no stable harness exists, document that UI interaction will be verified by focused interactive test after implementation and rely on Task 1/Task 3 automated coverage.

- [ ] **Step 2: Implement chooser without starting OAuth on mount**

Change `OpenAIOAuthFlow` so the first rendered state is a `Select` with exact options:

```ts
type LoginMethod = 'api_key' | 'oauth' | 'exit'
```

Render:

```tsx
<Text color="permission">Sign in to use OpenAI</Text>
<Text dimColor>Choose how Claude Code should authenticate with OpenAI.</Text>
<Select<LoginMethod>
  options={[
    { label: 'Use API key', value: 'api_key' },
    { label: 'Sign in with OAuth', value: 'oauth' },
    { label: 'Exit', value: 'exit' },
  ]}
  onChange={handleMethod}
  onCancel={handleExit}
/>
```

`handleExit` must call `props.onDone()` for `/login` command usage and let the startup caller decide process exit behavior. The startup caller will be handled in Task 4 if needed.

- [ ] **Step 3: Add API key input flow**

Use existing text input component patterns in the repo for hidden input. On submit:

```ts
const trimmed = apiKey.trim()
if (!trimmed) {
  setStatus({ state: 'error', message: 'OpenAI API key cannot be empty' })
  return
}
const authPath = await saveOpenAIApiKey(trimmed)
setStatus({ state: 'done', message: `OpenAI API key saved to ${authPath}` })
props.onDone()
```

Do not display the entered key.

- [ ] **Step 4: Preserve OAuth flow behind the OAuth option**

Move the existing `loginOpenAIWithOAuth()` effect behind `startOAuth()` so it only runs after selecting `Sign in with OAuth`.

- [ ] **Step 5: Manual focused check**

Run the built or dev CLI in an interactive terminal with missing OpenAI auth and verify:

```sh
CLAUDE_CODE_USE_OPENAI=1 dist/release/claude-code-v2.1.165-dev-darwin-arm64 --dangerously-skip-permissions
```

Expected: the first OpenAI auth screen shows `Use API key`, `Sign in with OAuth`, and `Exit`; Ctrl+C or Escape does not trap the UI.

---

### Task 3: OAuth URL copy-friendly terminal display

**Files:**
- Modify: `src/components/OpenAIOAuthFlow.tsx`

**Interfaces:**
- Consumes: OAuth auth URL from `loginOpenAIWithOAuth({ onAuthUrl })`.
- Produces: terminal output where the full authorize URL is visible on a standalone undecorated line.

- [ ] **Step 1: Preserve full URL state only in memory**

In `onAuthUrl`, only store the URL in React state:

```ts
onAuthUrl: url => {
  if (!cancelled) setAuthUrl(url)
}
```

Do not write the URL to a temp file.

- [ ] **Step 2: Render copy-safe text**

During OAuth waiting state render exactly this structure:

```tsx
<Text>Open this URL:</Text>
{authUrl ? <Text>{authUrl}</Text> : null}
<Text dimColor>
  If the URL wraps visually, copy from the beginning of https:// through the final character on the wrapped line.
</Text>
```

The URL line must not be dim, colored, bordered, prefixed with bullets, or truncated.

- [ ] **Step 3: Verify OAuth URL display**

Run OAuth startup manually and confirm the terminal shows the complete authorize URL on its own line and no temp URL file path is printed.

---

### Task 4: Startup auto-login exit behavior

**Files:**
- Modify: `src/interactiveHelpers.tsx`
- Modify: `src/components/OpenAIOAuthFlow.tsx` if `onExit` prop is needed

**Interfaces:**
- Consumes: `shouldShowOpenAIAutoLogin(): boolean`.
- Produces: startup auto-login exits cleanly when user chooses Exit/Ctrl+C rather than continuing to unauthenticated main UI.

- [ ] **Step 1: Add explicit exit callback**

Extend `OpenAIOAuthFlow` props:

```ts
export function OpenAIOAuthFlow(props: {
  onDone: () => void
  onExit?: () => void
  onError?: (error: Error) => void
}): React.ReactNode
```

For Exit/Ctrl+C/Escape, call:

```ts
props.onExit?.() ?? props.onDone()
```

- [ ] **Step 2: Wire startup exit**

In `src/interactiveHelpers.tsx`, change startup auto-login call to:

```tsx
await showSetupDialog(root, done => (
  <OpenAIOAuthFlow
    onDone={done}
    onExit={() => gracefulShutdownSync(0)}
  />
))
```

Keep `/login` command using default `onDone` behavior.

- [ ] **Step 3: Verify cancel path manually**

Run missing-auth startup and press Ctrl+C or choose Exit.

Expected: process exits cleanly and does not proceed to the main UI with missing OpenAI auth.

---

### Task 5: Polished localhost callback HTML

**Files:**
- Modify: `src/services/openai-oauth/auth-code-listener.ts`
- Modify: `src/services/openai-oauth/client.test.ts`

**Interfaces:**
- Consumes: callback request with `code` and `state`.
- Produces: success/error HTML responses with `Content-Type: text/html; charset=utf-8`.

- [ ] **Step 1: Write failing callback HTML tests**

In `src/services/openai-oauth/client.test.ts`, add assertions for listener responses:

```ts
assert.match(successBody, /OpenAI login complete/)
assert.match(successBody, /return to Claude Code/)
assert.match(successContentType, /text\/html/)
```

For missing code and invalid state, assert:

```ts
assert.match(errorBody, /OpenAI login failed/)
assert.match(errorBody, /return to Claude Code/)
```

- [ ] **Step 2: Run red test**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
```

Expected: FAIL because the current HTML is too minimal and error pages are plain text.

- [ ] **Step 3: Implement shared HTML renderer**

Add private helpers in `auth-code-listener.ts`:

```ts
function renderOpenAIAuthPage(options: {
  title: string
  message: string
  tone: 'success' | 'error'
}): string {
  const accent = options.tone === 'success' ? '#10a37f' : '#ef4444'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #e5e7eb; }
    .card { max-width: 560px; margin: 24px; padding: 32px; border-radius: 20px; background: #111827; box-shadow: 0 24px 80px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08); }
    .mark { width: 48px; height: 48px; border-radius: 999px; display: grid; place-items: center; background: ${accent}; color: white; font-weight: 700; margin-bottom: 20px; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { margin: 0; line-height: 1.6; color: #cbd5e1; }
  </style>
</head>
<body>
  <main class="card">
    <div class="mark">${options.tone === 'success' ? '✓' : '!'}</div>
    <h1>${options.title}</h1>
    <p>${options.message}</p>
  </main>
</body>
</html>`
}
```

Use fixed strings only; do not interpolate user-controlled query parameters.

- [ ] **Step 4: Use HTML for all callback outcomes**

Success:

```ts
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
res.end(renderOpenAIAuthPage({
  title: 'OpenAI login complete',
  message: 'You can close this tab and return to Claude Code.',
  tone: 'success',
}))
```

Missing code and invalid state:

```ts
res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
res.end(renderOpenAIAuthPage({
  title: 'OpenAI login failed',
  message: 'Return to Claude Code and try signing in again.',
  tone: 'error',
}))
```

404:

```ts
res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
res.end(renderOpenAIAuthPage({
  title: 'OpenAI login page not found',
  message: 'Return to Claude Code and restart the login flow.',
  tone: 'error',
}))
```

- [ ] **Step 5: Run green test**

Run:

```sh
bun src/services/openai-oauth/client.test.ts
```

Expected: PASS with `openai-oauth client.test.ts passed`.

---

### Task 6: Final focused verification

**Files:**
- No production file changes unless tests expose a defect.

**Interfaces:**
- Verifies all prior tasks together.

- [ ] **Step 1: Run focused tests**

Run:

```sh
bun src/services/openai-oauth/storage.test.ts
bun src/services/openai-oauth/client.test.ts
bun src/interactiveHelpers.openai-auth.test.ts
bun src/commands/login/openai-login-availability.test.ts
bun src/services/api/openai-missing-auth.test.ts
bun src/services/api/bootstrap-openai.test.ts
```

Expected: all pass.

- [ ] **Step 2: Build**

Run:

```sh
CLAUDE_CODE_VERSION=2.1.165-dev bun package:binary
```

Expected: build succeeds.

- [ ] **Step 3: Interactive smoke test**

With `~/.codex/auth.json` temporarily hidden and restored afterward, run:

```sh
CLAUDE_CODE_USE_OPENAI=1 \
http_proxy=http://127.0.0.1:7890 \
https_proxy=http://127.0.0.1:7890 \
dist/release/claude-code-v2.1.165-dev-darwin-arm64 --dangerously-skip-permissions
```

Expected:
- Initial OpenAI auth screen offers `Use API key`, `Sign in with OAuth`, and `Exit`.
- Choosing OAuth prints the complete URL on its own undecorated terminal line and does not save it to a temp file.
- Ctrl+C/Exit exits cleanly.
- Callback page is a styled HTML page.
- No token or API key values are printed.

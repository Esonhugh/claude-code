# OpenAI Device Code Login for CLAUDE_CODE_USE_OPENAI

## Goal

Add OpenAI/Codex device code login as an additional `/login` option when `CLAUDE_CODE_USE_OPENAI=1`. The existing OpenAI API key and browser OAuth login options remain available.

Device code login is intended for Windows, remote, headless, SSH, and other environments where automatically launching a browser or receiving a localhost callback is unreliable.

## Reference Behavior

The implementation follows the Codex device code flow in `dist/codex/codex-rs/login/src/device_code_auth.rs`.

Codex uses OpenAI-specific device auth endpoints, not the generic OAuth RFC 8628 endpoint names:

1. Request a user code:
   - `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
   - JSON body: `{ "client_id": "<client_id>" }`
   - Response fields: `device_auth_id`, `user_code`, `interval`
2. Show the user:
   - verification URL: `https://auth.openai.com/codex/device`
   - one-time user code: `user_code`
3. Poll for completion:
   - `POST https://auth.openai.com/api/accounts/deviceauth/token`
   - JSON body: `{ "device_auth_id": "...", "user_code": "..." }`
   - `200` returns `authorization_code`, `code_challenge`, `code_verifier`
   - `403` or `404` means authorization is still pending
4. Exchange the returned authorization code for tokens using the existing OpenAI OAuth token endpoint with redirect URI `https://auth.openai.com/deviceauth/callback`.
5. Persist credentials to the existing Codex-compatible `~/.codex/auth.json` format.

## User Experience

When `CLAUDE_CODE_USE_OPENAI=1`, `src/components/OpenAIOAuthFlow.tsx` will show four choices:

- `Use API key`
- `Sign in with OAuth`
- `Sign in with device code`
- `Exit`

Selecting `Sign in with device code` starts the device code flow and renders:

- `https://auth.openai.com/codex/device`
- the returned one-time user code
- a short instruction to open the URL and enter the code
- a warning that device codes expire and should not be shared

The device code option will not automatically open a browser. Users can open the verification URL in any browser on any device. The existing browser OAuth option remains the path that attempts automatic browser launch.

## Architecture

### New service module

Add `src/services/openai-oauth/device-code.ts`.

Responsibilities:

- `requestOpenAIDeviceCode()`
  - Calls `POST https://auth.openai.com/api/accounts/deviceauth/usercode`.
  - Uses the same OpenAI OAuth client ID as browser OAuth.
  - Returns a normalized object with `verificationUrl`, `userCode`, `deviceAuthId`, and `interval`.
- `pollOpenAIDeviceCode()`
  - Calls `POST https://auth.openai.com/api/accounts/deviceauth/token` until authorized, cancelled, failed, or timed out.
  - Treats `403` and `404` as pending.
  - Returns `authorizationCode`, `codeChallenge`, and `codeVerifier` on success.
- `loginOpenAIWithDeviceCode()`
  - Requests a device code.
  - Invokes an `onDeviceCode` callback so the UI can render the URL and code.
  - Polls for completion.
  - Reuses the existing token exchange and storage path.

### Reuse existing OAuth logic

Keep token and storage logic shared with browser OAuth:

- Reuse `saveOpenAIAuth()` from `src/services/openai-oauth/storage.ts`.
- Reuse `getOpenAIProxyConfig()` for outbound HTTP proxy behavior.
- Extend `exchangeOpenAICodeForTokens()` in `src/services/openai-oauth/client.ts` with an optional `redirectUri` parameter.
  - Browser OAuth keeps the default `http://localhost:<port>/auth/callback` redirect URI.
  - Device code uses `https://auth.openai.com/deviceauth/callback`.

No OpenAI credentials are written to Claude secure storage or Claude config.

### UI integration

Update `OpenAIOAuthFlow.tsx` in place rather than introducing a separate component.

Add:

- `device_code` to the login method union.
- a device-code waiting status containing `verificationUrl`, `userCode`, and cancellation state.
- a `startDeviceCode()` callback that calls `loginOpenAIWithDeviceCode()`.
- cancellation through `Esc` / `Ctrl+C`, matching the existing OpenAI login cancellation behavior.

The component remains the single OpenAI login dialog for API key, browser OAuth, and device code.

## Error Handling

- User code request:
  - `404`: fail with `device code login is not enabled for OpenAI`.
  - other non-2xx: fail with `device code request failed with status <status>`.
- Polling:
  - `200`: continue to token exchange.
  - `403` / `404`: continue waiting.
  - timeout after 15 minutes: fail with `device auth timed out after 15 minutes`.
  - other non-2xx: fail with `device auth failed with status <status>`.
- Token exchange:
  - Reuse existing OpenAI OAuth token exchange error handling.
  - Do not log token values.
- Cancellation:
  - Use `AbortSignal` to stop pending network operations and polling.
  - Do not write `auth.json` after cancellation.

## Testing

Add `src/services/openai-oauth/device-code.test.ts`.

Targeted service tests:

1. `requestOpenAIDeviceCode()` posts to `https://auth.openai.com/api/accounts/deviceauth/usercode` with the OpenAI client ID and normalizes the response.
2. `pollOpenAIDeviceCode()` treats `403` or `404` as pending and succeeds on a later `200`.
3. `loginOpenAIWithDeviceCode()` invokes `onDeviceCode`, exchanges the returned authorization code with redirect URI `https://auth.openai.com/deviceauth/callback`, and persists Codex-compatible auth JSON.
4. Aborting the flow rejects the login and does not write `auth.json`.
5. Non-pending error statuses and timeout produce clear errors without real 15-minute waits by injecting `sleep` and `maxWaitMs` in tests.

Add a lightweight UI/source test if needed to verify `OpenAIOAuthFlow.tsx` exposes the `Sign in with device code` option and renders the device code URL/code state.

Run targeted tests with `bun`, then run the relevant build command if implementation changes affect packaging or CLI runtime behavior.

## Out of Scope

- Removing or replacing browser OAuth.
- API key login changes.
- OpenAI logout/revoke behavior.
- Automatic fallback from browser OAuth failure to device code.
- Startup auto-login behavior beyond the existing OpenAI login gate.

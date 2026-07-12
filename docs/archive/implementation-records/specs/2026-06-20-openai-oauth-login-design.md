# OpenAI OAuth Login for CLAUDE_CODE_USE_OPENAI

## Goal

When `CLAUDE_CODE_USE_OPENAI=1`, the CLI should support an OpenAI/Codex-style OAuth login flow and persist the resulting ChatGPT OAuth credentials to `~/.codex/auth.json`. If the OpenAI-compatible client path has no usable OpenAI OAuth credentials, interactive sessions should guide the user through login instead of only telling them to manually create the file.

API key login is intentionally out of scope.

## Background

The current OpenAI-compatible path already consumes Codex credentials but does not create them:

- `src/utils/auth.ts` reads `~/.codex/auth.json` via `getOpenAIAuthInfo()`.
- `src/services/api/openai-compat.ts` uses ChatGPT OAuth credentials against `https://chatgpt.com/backend-api/codex` when `auth_mode` is `chatgpt`.
- `src/services/api/client.ts` throws when `CLAUDE_CODE_USE_OPENAI=1` and no OpenAI auth is found.
- `/login` is hidden for third-party providers by the command list filter, so OpenAI users currently cannot use the normal login command.

Codex-style ChatGPT OAuth stores credentials in `~/.codex/auth.json` with `auth_mode: "chatgpt"`, token data, account id, and refresh timestamp. The implementation should write that compatible shape and keep existing readers working.

## User Experience

### Interactive OpenAI provider session

1. User starts the CLI with `CLAUDE_CODE_USE_OPENAI=1`.
2. If `~/.codex/auth.json` contains usable ChatGPT OAuth tokens, the session proceeds normally.
3. If credentials are missing, the current implementation does not auto-enter login during startup. Instead, interactive users receive actionable guidance to run `/login`, which then executes the OAuth flow:
   - The CLI starts a local callback listener.
   - The CLI opens or prints an OpenAI OAuth URL.
   - The user completes login in the browser.
   - The callback captures the authorization code.
   - Tokens are exchanged and saved to `~/.codex/auth.json`.
4. `/login` remains available under `CLAUDE_CODE_USE_OPENAI=1` and runs the OpenAI OAuth flow.

### Non-interactive session

If the session is non-interactive and no OpenAI OAuth credentials exist, the client should fail with an actionable error telling the user to run an interactive `/login`. It should not hang waiting for browser interaction.

## Architecture

### OpenAI OAuth service

Add a focused OpenAI OAuth module under `src/services/openai-oauth/`:

- `types.ts`
  - Defines `OpenAITokenData`, `OpenAIAuthDotJson`, and token exchange response types.
- `pkce.ts`
  - Generates verifier/challenge and state.
- `auth-code-listener.ts`
  - Localhost callback server, modeled after the existing Anthropic listener but kept separate to avoid mixing provider-specific success redirects and scopes.
- `client.ts`
  - Builds the authorize URL and exchanges authorization code for tokens.
  - Endpoint constants must be copied from verified Codex/OpenAI behavior, not guessed.
- `storage.ts`
  - Writes `~/.codex/auth.json` in Codex-compatible format.
  - Creates `~/.codex` when missing.
  - Writes file mode `0600` where supported.
  - Clears `getOpenAIAuthInfo()` memoization after save if needed.

The module should not write to Claude config or Anthropic secure storage.

### Login UI integration

Update `src/commands/login/login.tsx`:

- If `CLAUDE_CODE_USE_OPENAI=1`, render an `OpenAIOAuthFlow` inside the existing `Dialog` shell.
- Otherwise keep rendering the current `ConsoleOAuthFlow`.
- On success, reuse the existing post-login state refresh path where it is provider-neutral, especially `context.onChangeAPIKey()` and auth version bump.
- Avoid Anthropic-only post-login calls for OpenAI if they assume Claude OAuth account data.

Update command availability so `/login` is visible for OpenAI provider sessions. The current `...(!isUsing3PServices() ? [logout, login()] : [])` behavior should become provider-aware: hide Anthropic login for Bedrock/Vertex/Foundry as before, but allow OpenAI login when `CLAUDE_CODE_USE_OPENAI=1`.

### Missing-auth trigger

`src/services/api/client.ts` should not be responsible for rendering UI. It should keep a clear non-interactive error path.

In this change set, interactive startup auto-gating is deferred. The implemented behavior is:

- `CLAUDE_CODE_USE_OPENAI=1` with missing auth fails fast with an actionable `/login` message.
- `/login` is available in OpenAI provider sessions and runs the same OAuth flow on demand.
- No startup/auth gate is claimed as implemented in the main loop yet.

A future task can add the smallest OpenAI-specific startup gate near the interactive main loop if product requirements still require automatic entry into login.

## Data Format

Persist `~/.codex/auth.json` as:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "2026-06-20T00:00:00.000Z"
}
```

`account_id` may be absent only if the OAuth token response genuinely does not provide it. The reader should remain tolerant of existing Codex files.

## Error Handling

- Callback listener port failure: show a concise login error and close the listener.
- State mismatch: reject the callback and do not write credentials.
- Token exchange failure: show the provider response status/message without logging token bodies.
- User cancellation: close listener and leave existing `auth.json` untouched.
- Non-interactive missing auth: fail fast with a message instructing the user to run interactive `/login`.

Token values must never be logged.

## Testing

Use failing tests before implementation:

1. `getOpenAIAuthInfo()` reads Codex ChatGPT OAuth `auth.json` shape.
2. `saveOpenAIAuth()` writes the Codex-compatible JSON shape and preserves token fields.
3. `saveOpenAIAuth()` creates `~/.codex/auth.json` with restrictive file mode where supported.
4. `/login` is available when `CLAUDE_CODE_USE_OPENAI=1`.
5. `/login` still uses Anthropic flow when OpenAI provider is not active.
6. OpenAI OAuth client builds an authorization URL with PKCE and validates callback state.
7. OpenAI OAuth client exchanges `code` with `code_verifier` and saves the response.
8. Missing OpenAI auth in non-interactive mode returns an actionable error rather than a manual `auth.json` instruction.

Run targeted tests with `bun`, then run the project build command:

```sh
CLAUDE_CODE_VERSION=2.1.165-dev bun package:binary
```

## Out of Scope

- API key login.
- Token refresh implementation beyond preserving refresh token in `auth.json`, unless required by the existing OpenAI compat path during testing.
- Logout/revoke for OpenAI OAuth.
- Storing OpenAI credentials in Claude secure storage.
- Official Anthropic OAuth behavior changes.

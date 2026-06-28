# CCH checksum attestation design

## Scope

Implement Claude Code `cch` checksum patching in the recovered TypeScript client so first-party OAuth requests match the upstream wire behavior observed in `dist/meka` and `official-claude`-compatible request captures.

Out of scope:

- Changing authentication behavior.
- Replacing the Anthropic SDK serializer.
- Adding native Bun HTTP stack patches.
- Patching Bedrock, Vertex, Foundry, OpenAI-compatible, API-key-only, or non-first-party requests.

## Evidence

- Source-confirmed: `src/constants/system.ts` already emits `cch=00000` inside `x-anthropic-billing-header` when `NATIVE_CLIENT_ATTESTATION` is enabled.
- Source-confirmed: `src/services/api/client.ts` centralizes first-party SDK fetch behavior in `buildFetch()`.
- Source-confirmed: `dist/meka/src/provider/claude/oauth/attestation.rs` computes `xxh64(filtered_preimage(body), 0x4d659218e32a3268) & 0xfffff` and replaces only the billing-header placeholder.
- Source-confirmed: meka filters `model`, `max_tokens`, `fallbacks`, and `fallback_credit_token` before hashing.
- Inference / needs verification: official Claude's native client attestation runs after JSON serialization and before sending the request body; implementing in `buildFetch()` matches that timing closely in this TypeScript codebase.

## Architecture

Add a focused module at `src/services/api/cchAttestation.ts` with pure functions:

- `computeCch(body: string): string`
- `patchCchInRequestBody(body: string): string`
- internal `filteredPreimage(body: Uint8Array): Uint8Array`
- internal `xxh64(input: Uint8Array, seed: bigint): bigint`

The module is byte-oriented and does not parse general JSON. It follows the meka implementation:

- Replace only a `cch=00000` occurrence after `x-anthropic-billing-header:`.
- Hash a filtered copy of the serialized body.
- Normalize `"model":"..."` to `"model":""`.
- Remove fields matching `"max_tokens":<digits>`.
- Remove `"fallbacks":[...]`.
- Remove `"fallback_credit_token":"..."`.
- Preserve all other bytes exactly.

`src/services/api/client.ts` calls this module inside `buildFetch()` immediately before delegating to the underlying fetch.

## Data flow

1. Request construction keeps the existing flow:
   - `claude.ts` / `sideQuery.ts` compute fingerprint.
   - `getAttributionHeader(fingerprint)` inserts `cch=00000` into the first system text block.
   - Anthropic SDK serializes the request.
2. `buildFetch()` receives final `input` and `init`.
3. For first-party Anthropic requests, if `init.body` is a string or byte buffer, patch it before sending.
4. Headers, client request ID injection, retries, timeout, and proxy settings remain unchanged.

## Error handling

- If no billing header placeholder exists, return the original body unchanged.
- If the body type cannot be safely patched, leave it unchanged and emit debug logging only.
- If checksum computation fails, leave the original body unchanged and emit debug logging only.
- Do not throw from the attestation path, because checksum patching must not break unrelated request types.

## Testing

Add unit tests for the pure module and the fetch integration:

1. Known meka fixture patches to `cch=16a13`.
2. User-message occurrences of `cch=00000` remain untouched.
3. Bodies without `x-anthropic-billing-header:` remain unchanged.
4. `model`, `max_tokens`, `fallbacks`, and `fallback_credit_token` do not affect the computed checksum.
5. `buildFetch()` patches eligible first-party request bodies before invoking the underlying fetch.

## Runtime verification

After implementation:

1. Build with the existing project command (`make build` if the Makefile still matches current build flow).
2. Run a local authorized mock/proxy endpoint to capture request bodies from `built-claude` and `official-claude`.
3. Compare body shape and billing-header `cch` behavior.
4. Validate captured bodies with the local checksum script or equivalent local checker.
5. Store only local, redacted artifacts; do not upload request bodies, tokens, binaries, or extracted code.

## Risks and limits

- The byte filter intentionally mirrors observed meka behavior, not a complete JSON parser.
- SDK serialization differences can still affect checksum if upstream changes request shape.
- Runtime comparison may require valid local OAuth state or a mock auth/proxy setup; captured artifacts must be redacted.

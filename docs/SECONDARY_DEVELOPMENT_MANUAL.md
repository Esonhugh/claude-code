# Secondary Development Manual

This guide is for developers maintaining or extending the recovered Claude Code source tree.

## Development goals

Work in this repository should preserve these properties in order:

1. The project builds.
2. The CLI starts and exposes help/version output.
3. TypeScript passes.
4. Missing import audit stays clean.
5. Recovered source becomes more readable and maintainable over time.

Do not trade long-term maintainability for short-term error suppression.

## Baseline workflow

Before changing code:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm audit:missing
```

After changing code:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
```

For CLI-facing changes:

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

For UI changes, run the CLI and test the changed path manually.

## Type recovery rules

Recovered code often has incomplete SDK, message, UI, and task shapes. Fix those with explicit boundaries.

Prefer:

- narrow interfaces that describe the exact caller contract;
- `unknown` at external or recovered boundaries;
- type guards such as `isToolUseBlock`, `isBase64ImageBlock`, or `hasAssistantContent`;
- assertion functions when the caller must fail fast on invalid data;
- discriminated unions for result objects.

Avoid:

- broad `any` in shared message, tool, settings, or app-state types;
- global index signatures added only to silence a local error;
- changing runtime behavior while fixing a type-only problem;
- replacing a real union with `string` or `unknown` when variants are known.

Example pattern:

```ts
type ToolResultBlockLike = {
  type: 'tool_result'
  tool_use_id: string
}

function isToolResultBlockLike(value: unknown): value is ToolResultBlockLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'tool_result' &&
    typeof (value as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}
```

## Recovery stubs

When an implementation is missing from the recovered bundle:

1. Find all call sites first.
2. Define the smallest interface those call sites need.
3. Implement a minimal stub that is explicit about unavailable behavior.
4. Keep feature-gated/internal stubs isolated.
5. Record the stub in `CHANGELOG.md` if it affects behavior.

Good stub behavior:

- return an empty list when the feature can naturally be absent;
- return `null` or `undefined` only when callers already handle it;
- throw a clear recovery-specific error if using the path would be unsafe or misleading.

Avoid silent success for operations that would imply real external work happened.

## Directory guidance

### Entrypoints

Key files:

- `src/entrypoints/cli.tsx`
- `src/entrypoints/fastPathDispatch.ts`
- `src/main.tsx`

Guidance:

- Keep early startup lightweight.
- Prefer dynamic imports for feature-gated fast paths.
- Move isolated dispatch logic out of `main.tsx` when it reduces startup coupling.

### Commands

Key files:

- `src/commands.ts`
- `src/commands/*`

Guidance:

- Commands should have clear user-facing descriptions.
- Register new commands in one place.
- Verify `--help` after changing command flags or options.

### Tools

Key files:

- `src/tools/*`
- `src/Tool.ts`
- `src/types/tools.ts`

Guidance:

- Keep input schema, output shape, progress shape, and UI rendering aligned.
- If a progress or result object gains fields, update the relevant shared type instead of casting at every call site.

### Messages and UI

Key files:

- `src/types/message.ts`
- `src/utils/messages.ts`
- `src/components/Message.tsx`
- `src/components/MessageRow.tsx`
- `src/components/Messages.tsx`

Guidance:

- Message types are central. Do not loosen them globally to fix one component.
- Add local guards at SDK/recovered boundaries.
- Keep `RenderableMessage`, normalized messages, grouped messages, and progress messages distinct.

### Plugins and marketplaces

Key files:

- `src/utils/plugins/*`
- `src/commands/plugin/*`

Guidance:

- Marketplace behavior should be policy-aware.
- User preferences such as favorites should live in settings, not installation metadata.
- Record marketplace source and auto-update behavior in the changelog.

### Telemetry and analytics

Key files:

- `src/services/analytics/*`
- `src/utils/telemetry/*`
- `src/services/api/metricsOptOut.ts`

Guidance:

- Keep Anthropic-bound telemetry default-off unless explicitly enabled.
- Preserve user-owned OTEL as explicit opt-in.
- Avoid network checks that are themselves telemetry unless gated.

## Documentation requirements

When behavior changes, update:

1. `CHANGELOG.md` for the strict change record.
2. `README.md` if user-facing setup or project purpose changes.
3. The relevant document under `docs/` if architecture, build, or development workflow changes.

`CHANGELOG.md` is mandatory for local changes after the `2.1.88` base.

## Validation expectations by change type

| Change type | Required validation |
| --- | --- |
| Types only | `pnpm exec tsc --noEmit --pretty false`, `pnpm lint` |
| Build system | `pnpm build`, `pnpm audit:missing`, CLI `--version`, CLI `--help` |
| Command registration | `pnpm build`, CLI `--help`, command-specific smoke test |
| UI | TypeScript, build, lint, manual interactive test |
| Plugin/marketplace | TypeScript, build, relevant plugin flow smoke test |
| Docs only | `git diff --check`; run broader checks if examples or scripts changed |

## Change discipline

- Keep changes scoped.
- Prefer deleting dead recovered code over preserving unused compatibility shims.
- Do not introduce new feature flags for simple local behavior changes.
- Do not commit unless explicitly asked.

# Default-True Ant Gate Helper Design

## Summary

Introduce a centralized `isAnt()` helper for recovered ant/external feature-gate checks and migrate direct literal comparisons to that helper.

The helper defaults to `true` in this project so ant-targeted functionality is visible by default. The migration replaces confusing source patterns such as:

```ts
("external" as string) === 'ant'
("external" as string) !== 'ant'
```

with:

```ts
isAnt()
!isAnt()
```

## Problem

The codebase contains recovered build-time gate expressions that read as if they compare the literal string `"external"` to `'ant'`. That is confusing in normal source code because the expression appears permanently false, even though its original purpose was to act as a build-time user-type gate.

Current tracked-source count:

- 123 positive checks: `("external" as string) === 'ant'`
- 15 negative checks: `("external" as string) !== 'ant'`
- 138 target checks total
- 54 files containing target checks

The checks are concentrated in UI, command exposure, internal diagnostics, AgentTool behavior, REPL/main flow, and user messaging.

## Goals

1. Centralize the recovered literal ant gate behind a clearly named helper.
2. Make ant behavior default to enabled in this recovery project.
3. Replace all target literal checks under `src/` in one migration.
4. Preserve existing boolean behavior under the requested default-true semantics.
5. Keep the helper small so it can later become build-define-backed without changing call sites again.

## Non-goals

1. Do not migrate `process.env.USER_TYPE === 'ant'` or `!== 'ant'` checks in this pass.
2. Do not redesign the full feature-flag system.
3. Do not restore build-time dead-code elimination in this first migration.
4. Do not change behavior based on user config, GrowthBook, Statsig, auth state, or subscription state.
5. Do not edit existing spec/plan documents or rely on untracked code.

## Proposed API

Create `src/utils/userType.ts`:

```ts
export function isAnt(): boolean {
  return true
}
```

Callers import it with the existing `src/*` path alias when practical:

```ts
import { isAnt } from 'src/utils/userType.js'
```

Then replace:

```ts
("external" as string) === 'ant'
```

with:

```ts
isAnt()
```

and replace:

```ts
("external" as string) !== 'ant'
```

with:

```ts
!isAnt()
```

## Semantics

`isAnt()` means "enable the ant-class behavior for this recovered source tree." It intentionally returns `true` for now.

This differs from the original literal expression in one important way: the original expression was designed for compile-time constant folding. The first implementation prioritizes readability and default ant access over dead-code elimination. Because every migrated call site uses `isAnt()`, a later implementation can change only `src/utils/userType.ts` if build-time behavior is needed again.

## Migration scope

Migrate every tracked `src/` occurrence of:

```ts
("external" as string) === 'ant'
("external" as string) !== 'ant'
```

Expected scope from the current tracked source:

- 138 replacements
- 54 files touched, plus one new helper file

The migration should keep expression structure minimal:

- `isAnt() && condition`
- `!isAnt() && condition`
- `isAnt() ? antValue : externalValue`
- `if (isAnt()) { ... }`
- `if (!isAnt()) { ... }`

## Files and responsibilities

### New file

- `src/utils/userType.ts`: owns the default-true ant classification helper.

### Existing files

Existing files should only receive imports and direct expression replacements. The migration should not refactor surrounding logic.

High-density files to handle carefully:

- `src/screens/REPL.tsx`
- `src/main.tsx`
- `src/components/LogoV2/LogoV2.tsx`
- `src/components/PromptInput/PromptInput.tsx`
- `src/tools/AgentTool/AgentTool.tsx`

## Data flow

There is no new persistent state or external data flow. Each caller asks `isAnt()` for the current ant classification and branches locally.

Current data flow:

```text
inline recovered literal -> local branch
```

New data flow:

```text
caller -> isAnt() -> local branch
```

## Error handling

`isAnt()` has no error path. It returns a boolean constant. Callers should not add defensive error handling around it.

## Testing and validation

Run these validations after implementation:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
```

Run grep checks to verify the target literal pattern is gone from tracked source:

```bash
git grep -n -e '("external" as string) === '\''ant'\''' -e '("external" as string) !== '\''ant'\''' -- src
```

Expected grep result: no matches.

Smoke-test the built CLI:

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

## Risks

1. **Dead-code elimination changes**: a function call may not fold the same way as the original literal expression.
2. **Import churn**: 54 files need imports, so automated replacement must still be reviewed for path and ordering issues.
3. **Hook rule sensitivity**: some React components used the literal gate before hooks to make the hook call compile-time constant. Replacing with a function may make lint rules stricter at those sites.
4. **Behavior expansion**: because `isAnt()` returns `true`, external-only restrictions guarded by `!isAnt()` become disabled in this recovery build.

## Risk handling

1. Keep `isAnt()` in a focused helper file so later DCE restoration is centralized.
2. Do not migrate `process.env.USER_TYPE` checks in the same pass.
3. Inspect React files where the old gate appeared before hooks, especially `src/components/MemoryUsageIndicator.tsx`.
4. Treat lint and typecheck output as authoritative before claiming completion.

## Acceptance criteria

1. `src/utils/userType.ts` exists and exports `isAnt()` returning `true`.
2. No tracked `src/` file contains the target literal ant/external checks.
3. Every migrated file imports `isAnt()` correctly.
4. Validation commands pass or any failures are documented with root cause.
5. The usage summary, design spec, and implementation plan remain separate documents.

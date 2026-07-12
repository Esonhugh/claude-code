# Ant Gate Usage Summary

## Scope

This summary only counts tracked source files under `src/`. It excludes existing spec/plan documents and untracked files.

The target pattern is the recovered build-time ant gate:

```ts
("external" as string) === 'ant'
("external" as string) !== 'ant'
```

It does not include `process.env.USER_TYPE === 'ant'` sites in the migration scope. Those runtime checks are noted separately because they often control process behavior, command registration, or environment-dependent behavior rather than the recovered literal gate itself.

## Counts

| Pattern | Count |
| --- | ---: |
| `("external" as string) === 'ant'` | 123 |
| `("external" as string) !== 'ant'` | 15 |
| Total target checks | 138 |
| Files containing target checks | 54 |

Related but out of scope for the first migration:

| Pattern family | Count |
| --- | ---: |
| `process.env.USER_TYPE === 'ant'` / `!== 'ant'` in `src` and `scripts` | 344 |
| Files containing those runtime checks | 162 |

## Distribution by source area

| Area | Target checks |
| --- | ---: |
| `src/components` | 64 |
| `src/screens` | 22 |
| `src/main.tsx` | 19 |
| `src/tools` | 11 |
| `src/commands` | 10 |
| `src/utils` | 6 |
| `src/hooks` | 3 |
| `src/buddy` | 2 |
| `src/state` | 1 |

## Highest-density files

| File | Target checks |
| --- | ---: |
| `src/screens/REPL.tsx` | 22 |
| `src/main.tsx` | 19 |
| `src/components/LogoV2/LogoV2.tsx` | 10 |
| `src/components/PromptInput/PromptInput.tsx` | 7 |
| `src/tools/AgentTool/AgentTool.tsx` | 6 |
| `src/components/PromptInput/PromptInputFooterLeftSide.tsx` | 4 |
| `src/commands/chrome/chrome.tsx` | 3 |
| `src/components/ContextVisualization.tsx` | 3 |
| `src/components/HelpV2/HelpV2.tsx` | 3 |
| `src/components/LogoV2/feedConfigs.tsx` | 3 |
| `src/tools/AgentTool/UI.tsx` | 3 |
| `src/utils/processUserInput/processSlashCommand.tsx` | 3 |

## What the gate is doing

The recovered literal gate appears to represent a build-time user-type distinction. In external builds, the literal is `"external"`, so `("external" as string) === 'ant'` folds to false and `!== 'ant'` folds to true. In ant builds, the corresponding source would be expected to fold the other way. The pattern is used to keep ant-only UI, commands, diagnostics, and internal integration paths separate from external user behavior.

Representative usage categories:

1. **Ant-only UI affordances**: DevBar, experiment notices, internal labels, prompt footer panels, coordinator/task panels, memory usage warning links, and extra status indicators.
2. **Internal command or workflow exposure**: commands such as ultraplan, thinkback behavior, MCP/plugin transition banners, slash-command handling, and ant-specific help text.
3. **Internal capability switches**: AgentTool behavior, panel-agent visibility, sandbox permission refinements, Tungsten/tool selector paths, and internal browser/chrome behavior.
4. **External user restrictions**: subscription messaging, disabled states, alternative feedback routing, and external-user notifications.
5. **Diagnostics and observability**: REPL/main diagnostics, stats, API metrics, context visualization, issue routing, and development-only warnings.

## Why replace it

The current literal gate is difficult to understand because business code appears to compare the string `"external"` to `'ant'`. That is meaningful only if the reader knows it came from a recovered build-time constant. Centralizing the check behind `isAnt()` makes intent explicit:

```ts
if (isAnt()) {
  // ant behavior
}
```

For this recovery project, `isAnt()` should temporarily default to `true`, so ant-targeted behavior is visible and usable by default while the source remains easier to read and migrate later.

## Migration boundary

The first migration should replace only the recovered literal target checks:

```ts
("external" as string) === 'ant'  -> isAnt()
("external" as string) !== 'ant'  -> !isAnt()
```

It should not broadly replace `process.env.USER_TYPE` checks in the same pass. Those checks are more numerous and may intentionally remain runtime-dependent.

## Known trade-off

The original literal comparison supports dead-code elimination because bundlers can constant-fold it. A normal function call can weaken that behavior. This is acceptable for the first recovery-project migration because the requested default is `true`, but the helper should live in one file so it can later evolve into a build-time constant export or define-backed implementation without changing every call site again.

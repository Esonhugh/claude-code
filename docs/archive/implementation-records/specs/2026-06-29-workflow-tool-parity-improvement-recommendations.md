# Workflow Tool Parity Improvement Recommendations

## Scope

This document records detailed improvement recommendations from comparing `recover/claude-v2.1.165.js` against the local workflow implementation.

It also incorporates the product feedback that the hidden bundled `workflow` and `interactive-terminal` skills are currently too terse to reliably teach the model how to act.

## Evidence boundary

- Recovered-observed: `recover/claude-v2.1.165.js` static analysis.
- Source-confirmed: local TypeScript source under `src/tools/WorkflowTool/`, `src/skills/bundled/`, and `src/commands/workflows/`.
- Runtime-observed: local `built-claude` interactive verification showed the model loads `Skill(workflow)` and `Skill(interactive-terminal)` for matching prompts.

Do not treat recovered variable names as stable official API names. Treat visible strings, tool object fields, schemas, and control flow as stronger evidence.

## Current local state

The local implementation now has:

- A `Workflow` facade tool in `src/tools/WorkflowTool/WorkflowFacadeTool.ts`.
- A `WorkflowTool` inspect/control tool in `src/tools/WorkflowTool/WorkflowTool.ts`.
- A script runtime in `src/tools/WorkflowTool/workflowScriptRuntime.ts`.
- Hidden bundled skills:
  - `src/skills/bundled/workflow.ts`
  - `src/skills/bundled/interactiveTerminal.ts`
- `/workflows` remains display/management UI only. It must not gain `list`, `show`, `dry-run`, `run`, or similar text-command routing semantics.

## Official recovered Workflow characteristics

### 1. Model-facing execution entry

Official recovered code exposes a model-facing tool named `Workflow` with alias `RunWorkflow`. The internal recovered export may be named `WorkflowTool`, but the actual tool name and user-facing name are `Workflow`.

Recommendation:

- Keep local `Workflow` as the primary model execution entry.
- Keep local `WorkflowTool` as an implementation-specific inspection/control tool if useful, but do not teach users to prefer it over `Workflow` for execution.
- The hidden `workflow` skill should explicitly say: use `Workflow` for execution and `WorkflowTool` for inspection/control when available.

### 2. Official prompt is a full orchestration manual

Official `Workflow` prompt is much more detailed than the local facade prompt and current hidden skill. It teaches:

- Workflow usage requires explicit opt-in.
- Valid opt-in sources include:
  - user says `ultracode` or session ultracode is enabled,
  - user directly asks for a workflow / multi-agent orchestration / fan-out agents,
  - a skill or slash command instructs the model to call `Workflow`,
  - user asks to run a named workflow.
- If there is no opt-in, do not silently call `Workflow`; use a single `Agent` or explain and ask.
- Inline scripts should be passed directly via `script`; do not first write a file solely to run it.
- Every script starts with `export const meta = {...}`.
- `meta` is a pure literal and drives permission/dialog/progress preview.
- `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, and child `workflow()` are the runtime vocabulary.
- Default to `pipeline()` for multi-stage per-item work; use `parallel()` barriers only when a stage genuinely needs all previous results.
- Workflows are expensive and can spawn many agents; scale to user request.
- Quality patterns include adversarial verify, perspective-diverse verify, judge panels, loop-until-dry, multi-modal sweep, completeness critic, and no silent caps.
- Scripts run without filesystem or Node APIs; phase work goes through agents.
- Resume uses `scriptPath` and `resumeFromRunId`.

Recommendation:

- Expand the hidden `workflow` skill substantially rather than bloating every user-facing command.
- Optionally expand `WorkflowFacadeTool.prompt()` to include the core official rules that are critical for model safety even if the skill is not loaded.
- Keep the hidden skill model-internal and non-user-invocable.

### 3. Input schema parity

Official input shape:

- `script?: string`
- `name?: string`
- `description?: string` ignored; use `meta.description`
- `title?: string` ignored; use `meta.title`
- `args?: unknown`
- `scriptPath?: string` takes precedence over `script` and `name`
- `resumeFromRunId?: string` matching `^wf_[a-z0-9-]{6,}$`
- at least one of `script`, `name`, `scriptPath` is required

Local differences:

- Local `Workflow` additionally accepts `plan`.
- Local `args` is JSON-like rather than `unknown`.
- Local `resumeFromRunId` is any string.
- Local inline script path requires `{ script, name }`.

Recommendations:

- Keep `plan` only if still needed for local direct runtime compatibility, but document it as local extension rather than official-compatible input.
- Add regex validation for `resumeFromRunId`.
- Consider allowing `{ script }` without separate `name` because official derives the name from `meta.name`.
- Keep `description` and `title` as ignored compatibility fields, but ensure docs and schema descriptions say `meta` is authoritative.

### 4. Output schema parity

Official output is structured:

- `status: "async_launched" | "remote_launched"`
- `taskId: string`
- optional `runId`
- optional `summary`
- optional `transcriptDir`
- optional `scriptPath`
- optional `sessionUrl`
- optional `warning`
- optional `error`

Local differences:

- Local `Workflow` returns a string.
- The string contains task ID, script path, and resume instructions, but the model cannot address fields structurally.

Recommendations:

- Move local `Workflow` output schema toward the official object shape.
- Preserve current text rendering via `mapToolResultToToolResultBlockParam` so users still see a readable message.
- If a full output migration is too large, first add a test documenting the desired official-compatible shape.

### 5. Validation and policy gates

Official validate path checks:

- managed `disableWorkflows`,
- workflows enabled for session/org/config,
- workflow existence / scriptPath readability,
- script meta parse errors,
- deterministic-script violations such as `Date.now()`, `Math.random()`, and argless `new Date()`,
- `resumeFromRunId` target still running.

Local differences:

- `Workflow` and `WorkflowTool` are currently always enabled.
- Deterministic restrictions are enforced mainly by the runtime sandbox rather than upfront validation.
- Resume target validation is less official-like.

Recommendations:

- Add a small validation helper for `Workflow` facade inputs.
- Preserve local feature flags if present; do not invent policy plumbing without reading existing config systems.
- Add tests for deterministic script rejection before launch.

### 6. Permission parity

Official permissions support per-workflow rules:

- named workflow deny rule blocks execution,
- named workflow ask/allow rule applies,
- no rule asks and can suggest adding an allow rule for that named workflow.

Local differences:

- Local `Workflow` always asks.
- Local `WorkflowTool.run` always asks.

Recommendations:

- Investigate existing tool permission rule helpers before implementing.
- Add per-workflow permission matching for named workflows only.
- Keep inline scripts and scriptPath calls as ask by default.

### 7. Parser hardening

Official parser uses a JavaScript AST parser and pure literal extraction for `meta`. Local parser uses a lightweight scanner and guarded object-literal evaluation.

Source-confirmed details from `recover/claude-v2.1.165.js`:

- `kZ(script)` parses the entire workflow file as an ECMAScript module with `sourceType: "module"`, `ecmaVersion: "latest"`, `allowAwaitOutsideFunction: true`, and `allowReturnOutsideFunction: true`.
- The first AST statement must be an `ExportNamedDeclaration` whose declaration is exactly one `const meta = <ObjectExpression>` variable declaration.
- The parser returns a targeted error when TypeScript syntax is present, because the script must be plain JavaScript.
- Meta extraction does not execute JavaScript. It walks AST nodes and accepts only literal data.
- Accepted value node shapes:
  - `Literal`.
  - `ArrayExpression` with no sparse holes and no spread elements.
  - `ObjectExpression` recursively.
  - `TemplateLiteral` only when it has no expressions.
  - `UnaryExpression` only for a negative numeric literal.
- Accepted object keys are identifier keys and literal keys only.
- Rejected object/meta constructs:
  - spread properties,
  - computed keys,
  - methods,
  - accessors,
  - template interpolation,
  - arbitrary identifiers or calls,
  - any non-literal AST node,
  - reserved key names `__proto__`, `constructor`, and `prototype`.
- Normalized meta requires non-empty string `name` and `description`.
- Optional normalized fields are `title`, `whenToUse`, and `phases`.
- `phases` keeps only object entries with a string `title`; optional `detail` and `model` are copied only when strings.
- The script body is the source text after the first export statement with leading semicolon/whitespace trimmed.

Local differences:

- Local `workflowScriptParser.ts` recognizes `export const meta =` with a scanner, finds the object literal end, then evaluates the object literal with `Function('"use strict"; return (...)')()` before applying `assertPlainLiteral`.
- Local post-validation blocks many unsafe values, but it still relies on JavaScript evaluation for the object literal. Official avoids evaluation entirely.
- Local parser should be treated as a compatibility gap, not just a hardening preference, because official accepts and rejects specific AST constructs with exact diagnostics.

Recommendations:

- Short-term hidden-skill pass: document `pure literal` accurately enough that model-authored scripts avoid computed values, spread, methods, accessors, and interpolated templates.
- Medium-term parser parity: replace local `Function`-based meta evaluation with AST literal extraction if an AST parser already exists in the project bundle.
- If adding a parser dependency would be required, do not do it without explicit user approval.
- Parser parity tests should include both accepted and rejected cases:
  - accepts string/number/boolean/null literals,
  - accepts negative numeric unary literals,
  - accepts no-expression template literals,
  - accepts nested arrays/objects,
  - rejects sparse arrays,
  - rejects array/object spread,
  - rejects computed keys,
  - rejects methods/accessors,
  - rejects template interpolation,
  - rejects identifier references and function calls,
  - rejects reserved keys,
  - rejects TypeScript annotations,
  - rejects missing-first-statement `export const meta`.

### 8. Workflow script VM/runtime parity

Official workflow scripts run in a constrained JavaScript VM rather than in the main process context.

Source-confirmed details from `recover/claude-v2.1.165.js`:

- Script body compilation first performs a strict async-function syntax check.
- The runtime transforms await/async iterator sites before compiling a `vm.Script` with filename `workflow.js`.
- Dynamic `import()` is disabled by `importModuleDynamically` throwing a workflow-specific error.
- VM contexts are created with `codeGeneration: { strings: false, wasm: false }`, preventing eval/function-string and wasm code generation from inside the workflow context.
- The VM hardener deletes or disables dangerous/non-deterministic globals such as `ShadowRealm`, `WebAssembly`, `FinalizationRegistry`, `WeakRef`, `Atomics`, `SharedArrayBuffer`, `queueMicrotask`, `$vm`, `gc`, `print`, `readFile`, and `Loader`.
- The hardener freezes a broad set of constructors and prototypes, including core objects, collections, promises, typed arrays, errors, `URL`, `Date`, `RegExp`, `Intl`, async/generator constructors, and iterator prototypes.
- `globalThis.then` is pinned as non-configurable `undefined` to avoid thenable-style escape behavior.
- Determinism shims reject `Math.random()`, `Date.now()`, bare `Date()`, and argless `new Date()` with messages explaining that these break resume.
- Timers are host-provided wrappers tied to the workflow abort signal; abort clears outstanding timers.
- Host functions crossing into the VM are wrapped, and returned values are cloned back across the boundary with cycle handling, array-size caps, function stripping, and `__proto__` skipping.
- Root runtime globals include `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `budget`, `console`, `setTimeout`, `clearTimeout`, and `args`.
- `args` is injected by JSON serialization and VM-side parsing rather than sharing host object identity.
- `budget` is frozen and exposes `total`, `spent()`, and `remaining()`.
- Child `workflow()` can run a saved workflow or scriptPath workflow, but deeper nesting is rejected.
- Child workflow contexts intentionally get a smaller global surface: `agent`, `parallel`, `pipeline`, and a child `workflow` function that rejects deeper nesting.

Local differences:

- Local `workflowScriptRuntime.ts` has a constrained runtime, but the parity gap should be evaluated feature-by-feature against the official VM hardening, determinism, await transform, cross-boundary clone, and child-workflow behavior.
- Hidden skill prompt work should not implement runtime parity, but it should teach model-authored workflow scripts to stay within the safe official subset: orchestrate agents only, avoid filesystem/shell APIs, avoid nondeterminism, and pass external values through `args`.

Recommendations:

- Short-term hidden-skill pass: include runtime-boundary language in the model-facing prompt so scripts do not rely on Node, filesystem, shell, random, current time, dynamic import, or deep child workflow nesting.
- Medium-term runtime parity: add focused tests for deterministic rejection, child workflow nesting, argument serialization, disabled dynamic import, and no direct filesystem/shell access.
- Treat broad VM hardening changes as a separate implementation plan because they can affect security and compatibility.

### 9. Agent orchestration runtime behavior

Official `agent()`, `parallel()`, and `pipeline()` are not just prompt conveniences; they drive task state, progress events, caching, stall handling, and budget enforcement.

Source-confirmed details from `recover/claude-v2.1.165.js`:

- `agent(prompt, opts)` records `workflow_agent` progress events with index, label, phase, agent id, agent type, isolation, model, state, prompt preview, tokens, tool calls, duration, and result preview.
- Agent count is capped at 1000. The official error warns that loops using `budget.remaining()` can run forever when no token budget is set because remaining is infinity.
- Token budget exhaustion stops further `agent()` calls while preserving in-flight results.
- `agent({ schema })` injects a StructuredOutput tool and requires the subagent to call it; if it does not, the runtime nudges twice and then fails.
- Workflow subagents receive explicit instructions that their final response is the return value to the script, not a message to a human.
- Workflow subagents disallow some coordination tools and otherwise run under normal tool permissions and app state.
- Worktree isolation can be requested for local agents and is cleaned up or preserved according to whether changes were made.
- Remote agent isolation exists in official code paths, but local support should remain a later parity item.
- Stalls are detected by lack of progress. The runtime retries stalled agents up to a fixed retry count and logs each retry.
- `parallel(thunks)` requires an array of functions, not promises, and wraps each thunk call; failures are logged as `parallel[index] failed` and return `null` in that slot.
- `pipeline(items, ...stages)` requires an array of items and function stages. Each item advances through all stages independently; failures are logged as `pipeline[index] failed` and return `null` for that item.
- Both `parallel()` and `pipeline()` preserve partial results instead of throwing the whole workflow for ordinary branch failures.
- Resume caching keys agent calls by prompt/options and prior result. Completed unchanged agents can be returned as cached results during resume.
- Phase registration emits `workflow_phase` progress events and maps later agent calls to phase indices.
- `log()` emits `workflow_log` progress events.

Recommendations:

- Hidden workflow skill should explicitly tell the model to pass thunks to `parallel()`, not promises.
- Hidden workflow skill should explain that `pipeline()` preserves per-item flow and should be the default for multi-stage per-item work.
- Hidden workflow skill should warn against unbounded loops and require explicit hard caps for loop-until-dry patterns.
- Hidden workflow skill should mention schema-based structured output only as a model-side usage pattern, not as a user-facing command.
- Hidden workflow skill should teach that failed branches can become `null`, so synthesis stages must handle missing results.

### 10. Remote workflow support

Official output includes `remote_launched` for CCR sessions. Local execution is local-task/session based.

Recommendation:

- Do not implement remote workflow launch as part of hidden skill detailedness.
- Track this as future parity work only.

## Skill detailedness recommendations

### Hidden workflow skill should include

- Explicit opt-in rules.
- Tool selection:
  - `Workflow` for execution,
  - `WorkflowTool` for list/show/dry-run/status/pause/resume when inspection/control is needed.
- Saved workflow preference.
- Inline script requirements.
- `meta` pure-literal requirements.
- Runtime globals and when to use each.
- `pipeline()` vs `parallel()` guidance.
- Quality patterns:
  - adversarial verification,
  - perspective-diverse verification,
  - judge panel,
  - loop-until-dry,
  - multi-modal sweep,
  - completeness critic,
  - no silent caps.
- Resume and iteration rules.
- Boundaries:
  - scripts do not do shell/filesystem work,
  - agents do the actual work,
  - preserve permissions and hooks,
  - do not route `/workflows` text commands.

### Hidden interactive-terminal skill should include

- Use `InteractiveTerminal` for persistent sessions, REPLs, TUIs, multi-step CLIs, special keys, size-sensitive programs, and long-lived processes.
- Use `Bash` for one-shot commands only.
- Use `Read`, `Edit`, `Write`, `Grep`, and `Glob` for file operations instead of terminal commands.
- Lifecycle:
  - `open`,
  - capture `sessionId`,
  - `read` before acting,
  - `write` for normal text,
  - `send_key` for Enter/Tab/Escape/arrows/Ctrl+C/Ctrl+D,
  - `resize` when layout matters,
  - `status` before assuming process state,
  - `signal` for SIGINT/SIGTERM,
  - `list` only to recover lost session IDs,
  - `close` when done.
- Failure modes without the skill:
  - Bash blocks or loses interactive state,
  - special keys encoded as text are misread,
  - stale screen assumptions cause wrong menu actions,
  - wrong terminal size breaks TUI layout,
  - lost `sessionId` loses control,
  - missing `close` leaves sessions/processes.

## Recommended implementation split

1. Short-term: expand hidden bundled skills and tests.
2. Medium-term: improve `Workflow` facade prompt and validation.
3. Medium-term: structured output parity for `Workflow`.
4. Later: per-workflow permission rules and AST parser hardening.
5. Later: remote workflow launch parity.

## Non-goals

- Do not expose `workflow` or `interactive-terminal` skills as user slash commands.
- Do not tell users to invoke the hidden skills.
- Do not add `/workflows list/show/dry-run/run` text semantics.
- Do not add dependencies without explicit approval.
- Do not implement remote CCR workflow launch as part of skill detailedness.

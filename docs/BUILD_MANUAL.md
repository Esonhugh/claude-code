# Build Manual

This guide explains how to install dependencies, build the recovered Claude Code CLI, run it locally, and verify the recovered source tree.

## Status

- Base version: `2.1.88`
- Local source version: `0.0.0-dev`
- Build output: `dist/cli.js`
- Package manager used in this workspace: `bun`
- Source state: recovered TypeScript/TSX with explicit recovery shims and type declarations

## Requirements

Required:

- Bun `>=1.3.14`
- Node.js `>=18` for Node-compatible tooling and inspector flows
- Network access to the configured npm registry

Recommended:

- macOS, Linux, or WSL
- Node.js 20+
- A clean shell environment when debugging CLI startup issues

## Install dependencies

```bash
bun install
```

If dependency resolution changes, keep `bun.lock` in sync with `package.json`.

## Build

```bash
bun run build
```

Expected outputs:

- `dist/cli.js`
- `dist/cli.js.map`

The build is driven by `scripts/build.mjs`. It handles recovery-specific build behavior such as Bun import shims, text asset loaders, and native-module fallbacks.

## Run the CLI

Check version:

```bash
bun ./dist/cli.js --version
```

Expected local source output:

```text
0.0.0-dev (Claude Code)
```

Build with a release version override when you want the built CLI to report a tagged release version:

```bash
CLAUDE_CODE_VERSION=2.1.89 bun run build
bun ./dist/cli.js --version
```

Expected release build output:

```text
2.1.89 (Claude Code)
```

Check help:

```bash
bun ./dist/cli.js --help
```

Run through the local script:

```bash
bun run cli:run
```

Check runtime status:

```bash
bun run cli:status
```

## Debugging with source maps and Ink

Build first so `dist/cli.js` and `dist/cli.js.map` are in sync:

```bash
bun run build
```

Run with mapped stack traces:

```bash
node --enable-source-maps ./dist/cli.js --help
bun run start:sourcemap --help
```

Run with mapped stack traces and Claude Code debug logging:

```bash
node --enable-source-maps ./dist/cli.js --debug --help
bun run debug:sourcemap --help
```

Run under the Node inspector:

```bash
CLAUDE_CODE_ALLOW_INSPECTOR=1 node --enable-source-maps --inspect-brk=9229 ./dist/cli.js --debug
bun run debug:inspect
```

`CLAUDE_CODE_ALLOW_INSPECTOR=1` is required because `src/main.tsx` blocks Node inspector/debugger startup by default in external builds. Keep it limited to local debugging sessions.

For VS Code debugging, use the checked-in `.vscode/launch.json` configurations. Interactive Ink sessions should run in the integrated terminal, not the Debug Console, because Ink needs a real TTY for stdin and screen rendering.

Ink rendering enters through `src/main.tsx`, wraps nodes with `ThemeProvider` in `src/ink.ts`, creates the managed Ink instance in `src/ink/root.ts`, and commonly waits for completion through `renderAndRun()` in `src/interactiveHelpers.tsx`.

`src/ink/root.ts` defaults `patchConsole` to `true`, so raw `console.log` can be captured or reordered after Ink starts. Prefer the existing debug channels when inspecting UI behavior:

```bash
node ./dist/cli.js --debug
node ./dist/cli.js --debug-to-stderr --help
node ./dist/cli.js --debug-file /tmp/claude-debug.log
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose node ./dist/cli.js --debug
```

Use `--debug-to-stderr` mainly for non-interactive flows or short smoke tests, because stderr output can still disturb interactive terminal UI readability.

## Validation checklist

Run these after TypeScript or build-system changes:

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run lint
bun run audit:missing
git diff --check
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

Current expectations:

- TypeScript should pass with no errors.
- Build should produce `dist/cli.js`.
- ESLint should report no errors. Warnings may remain while recovered source cleanup continues.
- `audit:missing` should report zero missing imports/assets.
- `git diff --check` should produce no output.

## Missing import audit

Run:

```bash
bun run audit:missing
```

The audit checks:

- missing `src/*` imports;
- missing relative code imports;
- missing text assets;
- missing type-only modules.

Treat runtime code and text asset misses as high priority. Type-only misses may not break the build, but they reduce maintainability and should be fixed during type recovery work.

## Binary packaging

Use the Bun packaging script to rebuild `dist/cli.js` with a release version override and produce a platform-specific binary for the current machine:

```bash
bun run build
CLAUDE_CODE_VERSION=2.1.89 bun run package:binary
```

The artifact is written under `dist/release/` and uses the runtime platform and architecture reported by Node, so the smoke-test path should be constructed with:

```bash
./dist/release/claude-code-v2.1.89-$(bun -e "console.log(process.platform)")-$(bun -e "console.log(process.arch)")
```

`bun run package:binary` always rebuilds `dist/cli.js` with the `CLAUDE_CODE_VERSION` override before compiling the binary. It does not rely on fake target environment variables for the artifact name.

## Recovery build behavior

The recovered build differs from a normal application build in several ways:

1. Some Bun virtual imports are shimmed for Node/esbuild compatibility.
2. Text assets are loaded explicitly.
3. Feature-gated internal modules may be represented by minimal recovery stubs.
4. Native packages may be redirected to TypeScript fallbacks.
5. Recovered source maps and declarations may require local type guards at API boundaries.

Keep these behaviors explicit. Do not hide missing runtime behavior behind broad global type loosening.

## Troubleshooting

### `bun run build` succeeds but the CLI crashes on `--help`

Check command registration and Commander option definitions. Commander short flags must be one dash and one character; multi-character aliases should be long flags such as `--d2e`.

### `audit:missing` reports missing code imports

1. Identify the import path.
2. Check whether the module is feature-gated or required at runtime.
3. Restore the real implementation when possible.
4. If unavailable, add a narrow recovery stub with the exact interface callers need.

### TypeScript errors around recovered messages or SDK blocks

Prefer:

- local interfaces for the boundary shape;
- `unknown` plus type guards;
- assertion functions for externally recovered structures.

Avoid broad `any` on core message or tool types.

### CLI can start but API calls fail

Check:

- authentication environment;
- `ANTHROPIC_BASE_URL` or other proxy settings;
- whether the configured endpoint supports the expected `/v1/messages` API;
- whether the token is valid for that endpoint.

## Release readiness checklist

Before treating a build as usable:

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run lint
bun run audit:missing
git diff --check
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

If the change affects interactive UI, also run the CLI interactively and test the changed flow manually.

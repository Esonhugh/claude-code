# Build Manual

This guide explains how to install dependencies, build the recovered Claude Code CLI, run it locally, and verify the recovered source tree.

## Status

- Base version: `2.1.88`
- Build output: `dist/cli.js`
- Package manager used in this workspace: `pnpm`
- Source state: recovered TypeScript/TSX with explicit recovery shims and type declarations

## Requirements

Required:

- Node.js `>=18`
- `pnpm`
- Network access to the configured npm registry

Recommended:

- macOS, Linux, or WSL
- Node.js 20+
- A clean shell environment when debugging CLI startup issues

## Install dependencies

```bash
pnpm install
```

If dependency resolution changes, keep `pnpm-lock.yaml` in sync with `package.json`.

## Build

```bash
pnpm build
```

Expected outputs:

- `dist/cli.js`
- `dist/cli.js.map`

The build is driven by `scripts/build.mjs`. It handles recovery-specific build behavior such as Bun import shims, text asset loaders, and native-module fallbacks.

## Run the CLI

Check version:

```bash
node ./dist/cli.js --version
```

Expected base output:

```text
2.1.88 (Claude Code)
```

Check help:

```bash
node ./dist/cli.js --help
```

Run through the local script:

```bash
pnpm cli:run
```

Check runtime status:

```bash
pnpm cli:status
```

## Validation checklist

Run these after TypeScript or build-system changes:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
node ./dist/cli.js --version
node ./dist/cli.js --help
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
pnpm audit:missing
```

The audit checks:

- missing `src/*` imports;
- missing relative code imports;
- missing text assets;
- missing type-only modules.

Treat runtime code and text asset misses as high priority. Type-only misses may not break the build, but they reduce maintainability and should be fixed during type recovery work.

## Recovery build behavior

The recovered build differs from a normal application build in several ways:

1. Some Bun virtual imports are shimmed for Node/esbuild compatibility.
2. Text assets are loaded explicitly.
3. Feature-gated internal modules may be represented by minimal recovery stubs.
4. Native packages may be redirected to TypeScript fallbacks.
5. Recovered source maps and declarations may require local type guards at API boundaries.

Keep these behaviors explicit. Do not hide missing runtime behavior behind broad global type loosening.

## Troubleshooting

### `pnpm build` succeeds but the CLI crashes on `--help`

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
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
node ./dist/cli.js --version
node ./dist/cli.js --help
```

If the change affects interactive UI, also run the CLI interactively and test the changed flow manually.

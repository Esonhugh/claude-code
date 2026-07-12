# Unofficial Claude Code Launcher Workspace

This repository is an unofficial Claude Code launcher and recovery workspace based on Claude Code `2.1.88`. It is not an Anthropic official product, official source distribution, or endorsed Claude Code release. The public npm package ships launch wrappers and platform binaries only, not this repository's source code.

## Project purpose

This project exists to:

1. Preserve a readable TypeScript/TSX source tree reconstructed from the distributed Claude Code bundle.
2. Provide a working local build of the Claude Code CLI for research, debugging, and controlled secondary development.
3. Track local feature changes clearly from the `2.1.88` base version.
4. Keep recovery-specific stubs, type declarations, and build shims explicit so they can be replaced with real implementations over time.

This is not an official Anthropic source distribution. Treat it as an unofficial launcher and recovery development workspace.

## Current baseline

- Base version: `2.1.88`
- Local source version: `0.0.0-dev`
- Runtime target: Node.js `>=18`
- Package manager used in this workspace: `bun`
- Build output: `dist/cli.js`

## Release and version flow

This repository keeps the recovered source tree on the local development version `0.0.0-dev` while preserving the recovered base version `2.1.88` in the project history and documentation.

- Local source builds use `0.0.0-dev` by default.
- Release builds derive their version from the Git tag, for example `v2.1.89`.
- The release process is tag-driven:
  1. create and push a release tag such as `git tag v2.1.89` and `git push origin v2.1.89`;
  2. the release workflow builds with `CLAUDE_CODE_VERSION=2.1.89`;
  3. the workflow packages per-runner binaries;
  4. the workflow attaches `SHA256SUMS.txt` alongside the release artifacts.
- The local packaging script also rebuilds `dist/cli.js` with the `CLAUDE_CODE_VERSION` override before compiling the binary artifact.

## Quick start

Install dependencies:

```bash
bun install
```

Build the CLI:

```bash
bun run build
```

Check the built CLI:

```bash
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

Expected local source version output:

```text
0.0.0-dev (Claude Code)
```

Build a tagged release locally by overriding the version during the build:

```bash
CLAUDE_CODE_VERSION=2.1.89 bun run build
bun run start --version
```

Expected release build output:

```text
2.1.89 (Claude Code)
```

Package a local binary after rebuilding with the release version override:

```bash
bun run build
CLAUDE_CODE_VERSION=2.1.89 bun run package:binary
```

The binary smoke-test path uses the actual runtime platform and architecture reported by Node:

```bash
./dist/release/claude-code-v2.1.89-$(bun -e "console.log(process.platform)")-$(bun -e "console.log(process.arch)")
```

`bun run package:binary` rebuilds `dist/cli.js` with the `CLAUDE_CODE_VERSION` override and names the artifact using the current runtime platform and architecture, not fake target environment variables.

Run validation checks:

```bash
bunx tsc --noEmit --pretty false
bun run lint
bun run audit:missing
git diff --check
```

## Useful scripts

| Script | Purpose |
| --- | --- |
| `bun run build` | Build `dist/cli.js` and source map. |
| `bun run start` | Run the local built CLI entrypoint. |
| `bun run lint` | Run ESLint over source, scripts, and type declarations. |
| `bun run lint:fix` | Run ESLint with autofix. Use only after reviewing lint output. |
| `bun run audit:missing` | Check for missing code, text, and type-only imports in the recovered tree. |
| `bun run cli:run` | Run the recovered CLI through the local runner. |
| `bun run cli:status` | Inspect recovered CLI runtime status. |

## Development workflow

Before changing code, capture the current baseline:

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run audit:missing
```

After changing TypeScript, run at least:

```bash
bunx tsc --noEmit --pretty false
bun run build
bun run lint
bun run audit:missing
git diff --check
```

For CLI-facing changes, also verify:

```bash
bun ./dist/cli.js --version
bun ./dist/cli.js --help
```

For UI or interactive behavior, start the CLI and test the target flow manually.


## npm launcher package

The public npm package is an unofficial launcher distribution:

- Main package: `@esonhugh/claude-code`
- Description: `unofficial claude code launch wrappers`
- Contents: a small `claude` launcher wrapper and metadata only
- Platform binaries: published as optional dependency subpackages, one package per platform/architecture, for example `@esonhugh/claude-code-darwin-arm64`
- Source code: not included in the npm package

Install with:

```bash
npm install -g @esonhugh/claude-code
claude --version
```

The launcher resolves the matching optional binary package for `process.platform` and `process.arch`. Unsupported platforms fail with a clear missing-binary message.

## Type recovery policy

This codebase still contains recovery-era type surfaces. When fixing types:

- Prefer precise interfaces, discriminated unions, `unknown`, assertion functions, and type guards.
- Avoid broad `any` casts except at unavoidable external or recovered-source boundaries.
- Keep boundary casts local and explain the shape they validate.
- Do not globally loosen core message or tool types to silence local errors.

## Documentation map

Start here:

- [`docs/README.md`](docs/README.md) — documentation index and reading order.
- [`docs/guides/build.md`](docs/guides/build.md) — build, run, and troubleshooting guide.
- [`docs/guides/secondary-development.md`](docs/guides/secondary-development.md) — secondary development practices.
- [`docs/architecture/runtime-internals.md`](docs/architecture/runtime-internals.md) — Claude Code runtime and Agent implementation index.
- [`CHANGELOG.md`](CHANGELOG.md) — strict local change log starting from base `2.1.88`.

Architecture references:

- [`docs/architecture/agent.md`](docs/architecture/agent.md)
- [`docs/architecture/agent-team.md`](docs/architecture/agent-team.md)
- [`docs/architecture/plugin-marketplace.md`](docs/architecture/plugin-marketplace.md)
- [`docs/architecture/agent-sdk-exports.md`](docs/architecture/agent-sdk-exports.md)

Design proposals and learning material:

- [`docs/design/private-plugin-marketplace.md`](docs/design/private-plugin-marketplace.md)
- [`docs/guides/agent-development.md`](docs/guides/agent-development.md)

## Change tracking

All local changes after the `2.1.88` base must be recorded in [`CHANGELOG.md`](CHANGELOG.md). Each entry should state:

- what changed;
- why it changed;
- affected files or subsystems;
- validation performed;
- known limitations or recovery stubs introduced.

## Safety and scope

This repository is intended for authorized development and research. Avoid using recovered or modified builds in production without a separate review of security, telemetry, update, and permission behavior.

# Claude Code Recovered Source

This repository is a recovered and actively maintained Claude Code source tree based on Claude Code `2.1.88`. The goal is to keep the recovered project readable, buildable, runnable, and suitable for secondary development.

## Project purpose

This project exists to:

1. Preserve a readable TypeScript/TSX source tree reconstructed from the distributed Claude Code bundle.
2. Provide a working local build of the Claude Code CLI for research, debugging, and controlled secondary development.
3. Track local feature changes clearly from the `2.1.88` base version.
4. Keep recovery-specific stubs, type declarations, and build shims explicit so they can be replaced with real implementations over time.

This is not an official Anthropic source distribution. Treat it as a recovery and development workspace.

## Current baseline

- Base version: `2.1.88`
- Runtime target: Node.js `>=18`
- Package manager used in this workspace: `pnpm`
- Build output: `dist/cli.js`

## Quick start

Install dependencies:

```bash
pnpm install
```

Build the CLI:

```bash
pnpm build
```

Check the built CLI:

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

Run validation checks:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm audit:missing
git diff --check
```

## Useful scripts

| Script | Purpose |
| --- | --- |
| `pnpm build` | Build `dist/cli.js` and source map. |
| `pnpm start` | Run the local built CLI entrypoint. |
| `pnpm lint` | Run ESLint over source, scripts, and type declarations. |
| `pnpm lint:fix` | Run ESLint with autofix. Use only after reviewing lint output. |
| `pnpm audit:missing` | Check for missing code, text, and type-only imports in the recovered tree. |
| `pnpm cli:run` | Run the recovered CLI through the local runner. |
| `pnpm cli:status` | Inspect recovered CLI runtime status. |

## Development workflow

Before changing code, capture the current baseline:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm audit:missing
```

After changing TypeScript, run at least:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
```

For CLI-facing changes, also verify:

```bash
node ./dist/cli.js --version
node ./dist/cli.js --help
```

For UI or interactive behavior, start the CLI and test the target flow manually.

## Type recovery policy

This codebase still contains recovery-era type surfaces. When fixing types:

- Prefer precise interfaces, discriminated unions, `unknown`, assertion functions, and type guards.
- Avoid broad `any` casts except at unavoidable external or recovered-source boundaries.
- Keep boundary casts local and explain the shape they validate.
- Do not globally loosen core message or tool types to silence local errors.

## Documentation map

Start here:

- [`docs/README.md`](docs/README.md) — documentation index and reading order.
- [`docs/BUILD_MANUAL.md`](docs/BUILD_MANUAL.md) — build, run, and troubleshooting guide.
- [`docs/SECONDARY_DEVELOPMENT_MANUAL.md`](docs/SECONDARY_DEVELOPMENT_MANUAL.md) — secondary development practices.
- [`docs/claude-code-internals-index.md`](docs/claude-code-internals-index.md) — Claude Code runtime and Agent implementation index.
- [`CHANGELOG.md`](CHANGELOG.md) — strict local change log starting from base `2.1.88`.

Architecture references:

- [`docs/agent-architecture-analysis.md`](docs/agent-architecture-analysis.md)
- [`docs/agent-team-architecture.md`](docs/agent-team-architecture.md)
- [`docs/plugin-marketplace-analysis.md`](docs/plugin-marketplace-analysis.md)
- [`docs/claude-agent-sdk-exports-analysis.md`](docs/claude-agent-sdk-exports-analysis.md)

Design proposals and learning material:

- [`docs/private-plugin-marketplace-enterprise-design.md`](docs/private-plugin-marketplace-enterprise-design.md)
- [`docs/beginner-agent-development-guide.md`](docs/beginner-agent-development-guide.md)

## Change tracking

All local changes after the `2.1.88` base must be recorded in [`CHANGELOG.md`](CHANGELOG.md). Each entry should state:

- what changed;
- why it changed;
- affected files or subsystems;
- validation performed;
- known limitations or recovery stubs introduced.

## Safety and scope

This repository is intended for authorized development and research. Avoid using recovered or modified builds in production without a separate review of security, telemetry, update, and permission behavior.

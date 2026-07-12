# Historical Upgrade Plan

Status: historical working note.

This document preserves the original implementation plan for the first local feature pass after the Claude Code `2.1.88` base. Completed behavior and validation belong in [`../CHANGELOG.md`](../../../CHANGELOG.md); use this file only for traceability.

## Scope originally planned

The plan covered:

1. Add an autonomous `/goal` slash command.
2. Embed `github.com/Esonhugh/Marketplace` as a built-in/default marketplace source.
3. Add plugin favorites and show them in a dedicated favorite scope.
4. Add marketplace `autoUpdate` controls in plugin marketplace UI.
5. Disable Anthropic-bound telemetry by default.

## Current status

These items have been implemented in the local recovered source tree and are recorded in the changelog under `Unreleased`.

## Original design constraints retained

- Reuse existing slash-command, plugin marketplace, settings, and telemetry systems.
- Avoid introducing parallel runtime frameworks when existing flows can be extended.
- Keep user-owned or explicit opt-in telemetry separate from Anthropic-bound default telemetry.
- Keep marketplace persistence and policy checks centralized.
- Keep autonomous `/goal` bounded by the active permission mode.

## Validation requirements for this feature set

The relevant validation commands are now:

```bash
pnpm exec tsc --noEmit --pretty false
pnpm build
pnpm lint
pnpm audit:missing
git diff --check
node ./dist/cli.js --version
node ./dist/cli.js --help
```

## See also

- [`../CHANGELOG.md`](../../../CHANGELOG.md)
- [`../../README.md`](../../README.md)
- [`BUILD_MANUAL.md`](../../guides/build.md)
- [`SECONDARY_DEVELOPMENT_MANUAL.md`](../../guides/secondary-development.md)

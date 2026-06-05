# Release automation design

## Goal

Create a tag-driven GitHub Actions release flow that builds the recovered Claude Code CLI into per-platform binaries, runs the existing validation checks, and injects the release version from the tag while keeping source code on a development version.

## Version strategy

Source-controlled code uses `0.0.0-dev` as the default non-release version. Release builds derive the real version from the git tag.

- `package.json` keeps `version` as `0.0.0-dev`.
- `scripts/build.mjs` must not hard-code a release version. It reads the build version from `CLAUDE_CODE_VERSION`, then falls back to `package.json.version`, then `0.0.0-dev`.
- The release workflow parses tags like `v2.1.89` into `2.1.89` and exports `CLAUDE_CODE_VERSION=2.1.89` before building.
- Local builds display `0.0.0-dev (Claude Code)`.
- Release binaries display the parsed tag version.

Implementation must search for all internal version constants and package metadata references, not only the current `MACRO.VERSION` line in `scripts/build.mjs`. Any code path that embeds or reports the product version should use the same resolved build version.

The workflow does not commit release versions back to the repository. The tag is the source of truth for release builds, and source remains clearly marked as development code.

## GitHub Actions workflow

Add `.github/workflows/release.yml` with these triggers:

- `push` on tags matching `v*`.
- `workflow_dispatch` for manual reruns when needed.

The workflow validates that the ref name matches semantic version tags in the form `vX.Y.Z`. It rejects invalid tags before installing dependencies or producing artifacts. It also verifies that source metadata still uses `0.0.0-dev` so release versions do not accidentally get committed to normal code.

## Checks before packaging

Each release job runs the existing project validation commands before packaging:

1. `pnpm install --frozen-lockfile`
2. `pnpm exec tsc --noEmit --pretty false`
3. `pnpm lint`
4. `pnpm audit:missing`
5. `git diff --check`
6. `CLAUDE_CODE_VERSION=$VERSION pnpm build`
7. `node ./dist/cli.js --version`
8. `node ./dist/cli.js --help`

The version smoke test must assert that `--version` contains the tag-derived version, not only that the command exits successfully.

## Packaging strategy

Packaging should be bun-first, because the user explicitly wants to try bun locally before choosing the final release packaging path.

Add a packaging script, likely `scripts/package-binary.mjs`, that rebuilds `dist/cli.js` with the requested release version, verifies the built entrypoint exists, and packages it into a platform binary. The first implementation should test Bun's executable compilation path locally and use it if it works for this bundle.

If Bun packaging cannot support the current ESM bundle or runtime behavior, stop and report the concrete failure rather than silently falling back. A later revision can choose Node SEA or archived Node runner artifacts if Bun is not viable.

Target artifact names:

- `claude-code-vX.Y.Z-linux-x64`
- `claude-code-vX.Y.Z-darwin-arm64`
- `claude-code-vX.Y.Z-win32-x64.exe`

The packaging script should keep platform naming deterministic by deriving platform and architecture from the runtime that actually performs Bun compilation (`process.platform` and `process.arch`). It must not accept target platform or architecture environment overrides that only change labels without changing Bun's emitted binary target. CI must run packaging jobs on the actual target OS/architecture for each artifact. The script should write artifacts to `dist/release/`.

## Release publication

The workflow uploads per-platform artifacts and a `SHA256SUMS.txt` file. A final release job creates or updates the GitHub Release for the tag and attaches all generated files.

The release body should include:

- tag name and parsed version
- commit SHA
- platforms built
- checks run
- checksum verification note

## Files expected to change

- `package.json`: set default version to `0.0.0-dev` and add any package script needed for binary packaging.
- `scripts/build.mjs`: resolve version dynamically and use it for all build macros.
- `scripts/package-binary.mjs`: bun-first binary packaging script after local validation.
- `.github/workflows/release.yml`: tag-triggered release workflow.
- `README.md` or `docs/BUILD_MANUAL.md`: document how to create a release tag and how local dev versions work.

## Verification plan

Before considering implementation complete:

- Search the repository for hard-coded `2.1.88`, `MACRO.VERSION`, `package.json`, and version-reporting code paths.
- Run local checks: `pnpm exec tsc --noEmit --pretty false`, `pnpm lint`, `pnpm audit:missing`, `git diff --check`.
- Run `pnpm build` and verify `node ./dist/cli.js --version` shows `0.0.0-dev` locally.
- Run `CLAUDE_CODE_VERSION=9.8.7 pnpm build` and verify `node ./dist/cli.js --version` shows `9.8.7`.
- Test Bun packaging locally before wiring it into CI.
- Execute the generated local binary and verify `--version` and `--help`.

## Open implementation constraint

The exact Bun packaging command must be confirmed locally during implementation. The implementation should not assume Bun can package this recovered CLI until a local proof succeeds.

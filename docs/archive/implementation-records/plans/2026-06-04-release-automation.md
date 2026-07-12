# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tag-driven release pipeline that injects tag versions, validates the CLI, packages per-platform binaries with Bun when viable, and publishes GitHub Release artifacts.

**Architecture:** Keep source-controlled builds on `0.0.0-dev` and resolve release versions at build time from `CLAUDE_CODE_VERSION`. Keep the existing esbuild CLI bundle as the canonical build input, add a focused Bun packaging script for executable artifacts, and wire GitHub Actions around the same local commands used by developers.

**Tech Stack:** Node.js ESM scripts, pnpm, esbuild, Bun executable compilation, GitHub Actions, GitHub Releases.

---

## File Structure

- Modify `package.json`
  - Set root version to `0.0.0-dev`.
  - Add a `package:binary` script that runs `node ./scripts/package-binary.mjs`.
- Modify `package-lock.json`
  - Keep root package metadata in sync with `package.json` by changing only the root version fields from `2.1.88` to `0.0.0-dev`.
- Modify `scripts/build.mjs`
  - Import package metadata.
  - Resolve build version from `CLAUDE_CODE_VERSION`, package metadata, and `0.0.0-dev` fallback.
  - Use the resolved version for `MACRO.VERSION`.
- Create `scripts/package-binary.mjs`
  - Validate Bun exists.
  - Build `dist/cli.js` with the requested version.
  - Validate `dist/cli.js` exists after the build.
  - Resolve version and actual runtime platform/architecture.
  - Run `bun build --compile` against `dist/cli.js`.
  - Write deterministic artifacts under `dist/release/`.
- Create `.github/workflows/release.yml`
  - Trigger on `v*` tags and `workflow_dispatch`.
  - Validate semver tag.
  - Install pnpm and Bun.
  - Run type/lint/audit/whitespace checks.
  - Build with tag-derived `CLAUDE_CODE_VERSION`.
  - Assert CLI version output contains the tag-derived version.
  - Package runner-native artifacts on each matrix OS.
  - Generate checksums and publish a GitHub Release.
- Modify `README.md`
  - Change current build/version expectations to `0.0.0-dev` for local builds.
  - Document tag release usage.
- Modify `docs/guides/build.md`
  - Change local version expectations to `0.0.0-dev`.
  - Document `CLAUDE_CODE_VERSION` release build override and Bun packaging smoke test.

---

### Task 1: Update source default version metadata

**Files:**
- Modify: `package.json:4`
- Modify: `package-lock.json:3-9`

- [ ] **Step 1: Change `package.json` version**

Replace this exact line in `package.json`:

```json
  "version": "2.1.88",
```

with:

```json
  "version": "0.0.0-dev",
```

- [ ] **Step 2: Change root `package-lock.json` version fields**

Replace this exact block in `package-lock.json`:

```json
  "version": "2.1.88",
```

with:

```json
  "version": "0.0.0-dev",
```

Then replace this exact package root metadata line in `package-lock.json`:

```json
      "version": "2.1.88",
```

with:

```json
      "version": "0.0.0-dev",
```

Only change the two root package version fields. Do not edit dependency versions.

- [ ] **Step 3: Verify metadata no longer reports the old root version**

Run:

```bash
grep -n '"version": "2\.1\.88"' package.json package-lock.json || true
```

Expected: no output from `package.json`; no output for the root package fields in `package-lock.json`.

- [ ] **Step 4: Commit metadata update**

```bash
git add package.json package-lock.json
git commit -m "chore: mark source builds as dev version"
```

---

### Task 2: Resolve build version dynamically

**Files:**
- Modify: `scripts/build.mjs:1-73`

- [ ] **Step 1: Add JSON import support and package metadata import**

At the top of `scripts/build.mjs`, after the existing imports:

```js
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
```

change the import block to:

```js
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  await fs.promises.readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ),
);
```

- [ ] **Step 2: Add a build version resolver**

After the `colorDiffFallbackPath` constant, add:

```js
const defaultVersion = '0.0.0-dev';
const buildVersion = String(
  process.env.CLAUDE_CODE_VERSION ?? packageJson.version ?? defaultVersion,
).trim() || defaultVersion;
```

- [ ] **Step 3: Replace hard-coded macro version**

Find this entry in `macroValues`:

```js
  'MACRO.VERSION': JSON.stringify('2.1.88'),
```

Replace it with:

```js
  'MACRO.VERSION': JSON.stringify(buildVersion),
```

- [ ] **Step 4: Search for remaining internal version constants**

Run:

```bash
grep -R "2\.1\.88\|MACRO.VERSION\|package.json" -n scripts src package.json README.md docs/guides/build.md | head -120
```

Expected at this point:

- `scripts/build.mjs` should still reference `package.json` and `MACRO.VERSION`.
- `src/main.tsx` references to `MACRO.VERSION` are expected because they consume the build macro.
- `README.md` and `docs/guides/build.md` may still mention `2.1.88`; those are handled in a documentation task.
- There should be no hard-coded `2.1.88` in `scripts/build.mjs` or `package.json`.

- [ ] **Step 5: Verify local dev build version**

Run:

```bash
pnpm build
node ./dist/cli.js --version
```

Expected version output contains:

```text
0.0.0-dev (Claude Code)
```

- [ ] **Step 6: Verify environment-injected release build version**

Run:

```bash
CLAUDE_CODE_VERSION=9.8.7 pnpm build
node ./dist/cli.js --version
```

Expected version output contains:

```text
9.8.7 (Claude Code)
```

- [ ] **Step 7: Restore local dev build output**

Run:

```bash
pnpm build
node ./dist/cli.js --version
```

Expected version output contains:

```text
0.0.0-dev (Claude Code)
```

- [ ] **Step 8: Commit dynamic version resolver**

```bash
git add scripts/build.mjs dist/cli.js dist/cli.js.map
git commit -m "build: resolve cli version at build time"
```

If `dist/cli.js` and `dist/cli.js.map` are ignored or intentionally untracked, omit them from `git add` and commit only `scripts/build.mjs`.

---

### Task 3: Add Bun-first binary packaging script

**Files:**
- Modify: `package.json:19-31`
- Create: `scripts/package-binary.mjs`

- [ ] **Step 1: Add package script**

In `package.json`, change the scripts block from:

```json
    "build": "node ./scripts/build.mjs",
    "start": "node ./dist/cli.js",
```

To:

```json
    "build": "node ./scripts/build.mjs",
    "package:binary": "node ./scripts/package-binary.mjs",
    "start": "node ./dist/cli.js",
```

- [ ] **Step 2: Create `scripts/package-binary.mjs`**

Create `scripts/package-binary.mjs` with exactly this content:

```js
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const distDir = path.join(projectDir, 'dist');
const releaseDir = path.join(distDir, 'release');
const entrypoint = path.join(distDir, 'cli.js');
const packageJson = JSON.parse(
  await fs.promises.readFile(path.join(projectDir, 'package.json'), 'utf8'),
);

const defaultVersion = '0.0.0-dev';
const version = String(
  process.env.CLAUDE_CODE_VERSION ?? packageJson.version ?? defaultVersion,
).trim() || defaultVersion;
const platform = process.platform;
const arch = process.arch;
const extension = platform === 'win32' ? '.exe' : '';
const artifactName = `claude-code-v${version}-${platform}-${arch}${extension}`;
const outfile = path.join(releaseDir, artifactName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

run('node', ['./scripts/build.mjs']);

if (!fs.existsSync(entrypoint)) {
  throw new Error('dist/cli.js does not exist after build. Check pnpm build output before packaging.');
}

const bunCheck = spawnSync('bun', ['--version'], {
  cwd: projectDir,
  encoding: 'utf8',
});

if (bunCheck.error || bunCheck.status !== 0) {
  throw new Error('Bun is required for binary packaging. Install bun and rerun pnpm package:binary.');
}

await fs.promises.mkdir(releaseDir, { recursive: true });

run('bun', [
  'build',
  '--compile',
  entrypoint,
  '--outfile',
  outfile,
]);

if (platform !== 'win32') {
  await fs.promises.chmod(outfile, 0o755);
}

console.log(outfile);
```

- [ ] **Step 3: Run local Bun packaging proof**

Run:

```bash
pnpm build
CLAUDE_CODE_VERSION=9.8.7 pnpm package:binary
```

Expected: script prints a path under `dist/release/` named for the local platform and arch, for example on Apple Silicon:

```text
/Users/esonhugh/workspace/projects/WebStormProjects/cc/claude-code_evil/dist/release/claude-code-v9.8.7-darwin-arm64
```

If Bun fails, copy the exact error output into the implementation notes and stop before adding the GitHub Actions packaging step.

- [ ] **Step 4: Smoke test the packaged binary**

On macOS/Linux, run:

```bash
./dist/release/claude-code-v9.8.7-$(node -p "process.platform")-$(node -p "process.arch") --version
./dist/release/claude-code-v9.8.7-$(node -p "process.platform")-$(node -p "process.arch") --help
```

On Windows, run the equivalent PowerShell commands:

```powershell
.\dist\release\claude-code-v9.8.7-win32-x64.exe --version
.\dist\release\claude-code-v9.8.7-win32-x64.exe --help
```

Expected version output contains:

```text
9.8.7 (Claude Code)
```

Expected help command exits successfully.

- [ ] **Step 5: Restore dev build after release packaging proof**

Run:

```bash
pnpm build
node ./dist/cli.js --version
```

Expected version output contains:

```text
0.0.0-dev (Claude Code)
```

- [ ] **Step 6: Commit packaging script**

```bash
git add package.json scripts/package-binary.mjs
git commit -m "build: add bun binary packaging script"
```

---

### Task 4: Add tag-driven GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/release.yml`**

Create `.github/workflows/release.yml` with exactly this content:

```yaml
name: Release binaries

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag to build, for example v2.1.89'
        required: true
        type: string

permissions:
  contents: write

jobs:
  validate-tag:
    name: Validate release tag
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.version.outputs.tag }}
      version: ${{ steps.version.outputs.version }}
    steps:
      - name: Resolve tag and version
        id: version
        shell: bash
        run: |
          if [[ "${{ github.event_name }}" == "workflow_dispatch" ]]; then
            TAG="${{ inputs.tag }}"
          else
            TAG="${GITHUB_REF_NAME}"
          fi

          if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "Invalid release tag: $TAG" >&2
            echo "Expected format: vX.Y.Z" >&2
            exit 1
          fi

          VERSION="${TAG#v}"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

  build:
    name: Build ${{ matrix.os }}
    needs: validate-tag
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os:
          - ubuntu-latest
          - macos-14
          - windows-latest
    env:
      CLAUDE_CODE_VERSION: ${{ needs.validate-tag.outputs.version }}
    steps:
      - name: Checkout tag
        uses: actions/checkout@v4
        with:
          ref: ${{ needs.validate-tag.outputs.tag }}

      - name: Verify source version is dev
        shell: bash
        run: |
          node -e "const p=require('./package.json'); if (p.version !== '0.0.0-dev') { console.error('package.json version must stay 0.0.0-dev, got ' + p.version); process.exit(1); }"

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm exec tsc --noEmit --pretty false

      - name: Lint
        run: pnpm lint

      - name: Audit missing recovered imports
        run: pnpm audit:missing

      - name: Check whitespace
        run: git diff --check

      - name: Build CLI with release version
        run: pnpm build

      - name: Verify CLI version
        shell: bash
        run: |
          VERSION_OUTPUT="$(node ./dist/cli.js --version)"
          echo "$VERSION_OUTPUT"
          if [[ "$VERSION_OUTPUT" != *"${CLAUDE_CODE_VERSION} (Claude Code)"* ]]; then
            echo "Expected version output to contain ${CLAUDE_CODE_VERSION} (Claude Code)" >&2
            exit 1
          fi

      - name: Verify CLI help
        run: node ./dist/cli.js --help

      - name: Package binary
        run: pnpm package:binary

      - name: Upload binary artifact
        uses: actions/upload-artifact@v4
        with:
          name: claude-code-v${{ needs.validate-tag.outputs.version }}-${{ matrix.os }}
          path: dist/release/*
          if-no-files-found: error

  release:
    name: Publish GitHub Release
    needs:
      - validate-tag
      - build
    runs-on: ubuntu-latest
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts
          merge-multiple: true

      - name: Generate checksums
        shell: bash
        run: |
          cd artifacts
          sha256sum * > SHA256SUMS.txt
          cat SHA256SUMS.txt

      - name: Write release notes
        shell: bash
        run: |
          cat > release-notes.md <<EOF
          Automated binary release for ${{ needs.validate-tag.outputs.tag }}.

          Version: ${{ needs.validate-tag.outputs.version }}
          Commit: ${{ github.sha }}

          Checks run before packaging:
          - pnpm exec tsc --noEmit --pretty false
          - pnpm lint
          - pnpm audit:missing
          - git diff --check
          - node ./dist/cli.js --version
          - node ./dist/cli.js --help

          Verify downloads with SHA256SUMS.txt.
          EOF

      - name: Publish release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.validate-tag.outputs.tag }}
          name: ${{ needs.validate-tag.outputs.tag }}
          body_path: release-notes.md
          files: artifacts/*
```

- [ ] **Step 2: Validate workflow syntax locally if actionlint is installed**

Run:

```bash
if command -v actionlint >/dev/null 2>&1; then actionlint .github/workflows/release.yml; else echo "actionlint not installed; skipping local workflow syntax check"; fi
```

Expected: either no output from `actionlint`, or the skip message.

- [ ] **Step 3: Commit release workflow**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish binaries from release tags"
```

---

### Task 5: Document dev version and release tag flow

**Files:**
- Modify: `README.md:16-90`
- Modify: `docs/guides/build.md:5-146`

- [ ] **Step 1: Update README current baseline section**

In `README.md`, replace:

```markdown
- Base version: `2.1.88`
```

with:

```markdown
- Base version: `2.1.88`
- Local source version: `0.0.0-dev`
```

- [ ] **Step 2: Add README release section**

After the CLI-facing verification block in `README.md`:

```markdown
node ./dist/cli.js --version
node ./dist/cli.js --help
```

insert:

```markdown
## Release builds

Source-controlled local builds use `0.0.0-dev` as the CLI version. Release builds derive the version from the git tag.

Create a release by pushing a semantic version tag:

```bash
git tag v2.1.89
git push origin v2.1.89
```

The GitHub Actions release workflow validates the tag, builds with `CLAUDE_CODE_VERSION=2.1.89`, packages per-platform binaries, and attaches them to the GitHub Release with `SHA256SUMS.txt`.
```

- [ ] **Step 3: Update build manual status**

In `docs/guides/build.md`, replace:

```markdown
- Base version: `2.1.88`
```

with:

```markdown
- Base version: `2.1.88`
- Local source version: `0.0.0-dev`
```

- [ ] **Step 4: Update build manual version expectation**

In `docs/guides/build.md`, replace:

```text
2.1.88 (Claude Code)
```

with:

```text
0.0.0-dev (Claude Code)
```

- [ ] **Step 5: Add build manual release override section**

After the expected base output block in `docs/guides/build.md`, insert:

```markdown
Release builds inject the tag-derived version through `CLAUDE_CODE_VERSION`:

```bash
CLAUDE_CODE_VERSION=2.1.89 pnpm build
node ./dist/cli.js --version
```

Expected release-style output:

```text
2.1.89 (Claude Code)
```
```

- [ ] **Step 6: Add build manual binary packaging section**

Before `## Debugging with source maps and Ink` in `docs/guides/build.md`, insert:

```markdown
## Package a local binary

Bun is used for the first binary packaging path. Build the CLI first, then compile the built entrypoint:

```bash
pnpm build
CLAUDE_CODE_VERSION=2.1.89 pnpm package:binary
```

The binary is written to `dist/release/` with the version, platform, and architecture in the filename. Verify it before publishing:

```bash
./dist/release/claude-code-v2.1.89-$(node -p "process.platform")-$(node -p "process.arch") --version
./dist/release/claude-code-v2.1.89-$(node -p "process.platform")-$(node -p "process.arch") --help
```
```

- [ ] **Step 7: Commit documentation updates**

```bash
git add README.md docs/guides/build.md
git commit -m "docs: describe tag-driven release builds"
```

---

### Task 6: Final verification

**Files:**
- Inspect all modified files.

- [ ] **Step 1: Search for stale hard-coded release version references**

Run:

```bash
grep -R "2\.1\.88" -n package.json package-lock.json scripts README.md docs/guides/build.md src | head -80
```

Expected: only documentation references to the base version should remain. There should be no `2.1.88` in `package.json`, root `package-lock.json` metadata, or `scripts/build.mjs`.

- [ ] **Step 2: Search version macro usage**

Run:

```bash
grep -R "MACRO.VERSION" -n scripts src | head -80
```

Expected: `scripts/build.mjs` defines the macro with `buildVersion`; runtime references in `src/main.tsx` and other source files consume the macro.

- [ ] **Step 3: Run full local validation**

Run:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit --pretty false
pnpm lint
pnpm audit:missing
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Verify local dev CLI output**

Run:

```bash
pnpm build
node ./dist/cli.js --version
node ./dist/cli.js --help
```

Expected: version output contains `0.0.0-dev (Claude Code)` and help exits 0.

- [ ] **Step 5: Verify injected release CLI output**

Run:

```bash
CLAUDE_CODE_VERSION=9.8.7 pnpm build
node ./dist/cli.js --version
node ./dist/cli.js --help
```

Expected: version output contains `9.8.7 (Claude Code)` and help exits 0.

- [ ] **Step 6: Verify Bun binary output**

Run:

```bash
CLAUDE_CODE_VERSION=9.8.7 pnpm package:binary
./dist/release/claude-code-v9.8.7-$(node -p "process.platform")-$(node -p "process.arch") --version
./dist/release/claude-code-v9.8.7-$(node -p "process.platform")-$(node -p "process.arch") --help
```

Expected: binary version output contains `9.8.7 (Claude Code)` and help exits 0.

- [ ] **Step 7: Restore dev build before handoff**

Run:

```bash
pnpm build
node ./dist/cli.js --version
```

Expected: version output contains `0.0.0-dev (Claude Code)`.

- [ ] **Step 8: Review git diff**

Run:

```bash
git status --short
git diff -- package.json package-lock.json scripts/build.mjs scripts/package-binary.mjs .github/workflows/release.yml README.md docs/guides/build.md
```

Expected: diff matches the planned release automation changes and contains no unrelated source changes.

- [ ] **Step 9: Commit final verification fixes if needed**

If verification required any fixes, commit them:

```bash
git add package.json package-lock.json scripts/build.mjs scripts/package-binary.mjs .github/workflows/release.yml README.md docs/guides/build.md
git commit -m "fix: finalize release automation checks"
```

Skip this commit if no verification fixes were needed.

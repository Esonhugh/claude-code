import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { getEnabledFeatures, macroValues } from './build.mjs';
import { feature } from './shims/bun-bundle.js';
import imageProcessor, {
  getNativeModule,
  sharp,
} from './shims/image-processor-napi.js';

assert.equal(getEnabledFeatures('').has('AGENT_TRIGGERS'), true);
assert.equal(getEnabledFeatures('').has('MCP_SKILLS'), true);
assert.equal(getEnabledFeatures('').has('SSH_REMOTE'), true);
assert.equal(getEnabledFeatures(undefined).has('AGENT_TRIGGERS'), true);
assert.equal(getEnabledFeatures(undefined).has('MCP_SKILLS'), true);
assert.equal(getEnabledFeatures(undefined).has('SSH_REMOTE'), true);
assert.equal(
  getEnabledFeatures('WORKFLOW_SCRIPTS').has('AGENT_TRIGGERS'),
  true,
);
assert.equal(
  getEnabledFeatures('WORKFLOW_SCRIPTS').has('WORKFLOW_SCRIPTS'),
  true,
);
assert.equal(feature('AGENT_TRIGGERS'), true);
assert.equal(feature('MCP_SKILLS'), true);
assert.equal(feature('SSH_REMOTE'), true);
assert.equal(getNativeModule(), null);
assert.equal(sharp, imageProcessor);
assert.throws(
  () => imageProcessor(),
  /Native image processor module not available/,
);
assert.equal(
  macroValues['MACRO.PACKAGE_URL'],
  JSON.stringify('@esonhugh/claude-code'),
);

const packageBinarySource = readFileSync(
  new URL('./package-binary.mjs', import.meta.url),
  'utf8',
);
assert.match(packageBinarySource, /CLAUDE_CODE_BINARY_TARGET/);
assert.match(packageBinarySource, /bun-linux-x64-baseline/);
assert.match(packageBinarySource, /bun-linux-x64-musl/);
assert.match(packageBinarySource, /bun-linux-arm64-musl/);
assert.match(packageBinarySource, /ripgrep-\$\{platform\}-\$\{arch\}/);
assert.match(packageBinarySource, /["']--target["']/);

const releaseWorkflowSource = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
assert.match(releaseWorkflowSource, /- ubuntu-24\.04-arm/);
assert.match(
  releaseWorkflowSource,
  /CLAUDE_CODE_BINARY_TARGET: bun-linux-x64-baseline/,
);
assert.match(
  releaseWorkflowSource,
  /runner\.os == 'Linux' && runner\.arch == 'X64'/,
);
assert.match(
  releaseWorkflowSource,
  /claude-code-v\$\{CLAUDE_CODE_VERSION\}-linux-x64-baseline/,
);
assert.match(
  releaseWorkflowSource,
  /claude-code-v\$\{VERSION\}-linux-x64-baseline/,
);
assert.match(
  releaseWorkflowSource,
  /claude-code-v\$\{VERSION\}-linux-x64-musl/,
);
assert.match(
  releaseWorkflowSource,
  /claude-code-v\$\{VERSION\}-linux-arm64-musl/,
);
assert.match(releaseWorkflowSource, /alpine:3\.22/);
assert.match(releaseWorkflowSource, /apk add --no-cache libstdc\+\+ libgcc/);
assert.match(
  releaseWorkflowSource,
  /--platform "linux\/\$\{ARCH\/x64\/amd64\}"/,
);
assert.doesNotMatch(releaseWorkflowSource, /sha256sum \* > SHA256SUMS\.txt/);
assert.match(releaseWorkflowSource, /group: release-/);

const prepareNpmPackageSource = readFileSync(
  new URL('./prepare-npm-package.mjs', import.meta.url),
  'utf8',
);
assert.match(
  prepareNpmPackageSource,
  /entry\.endsWith\('-linux-x64-baseline'\)/,
);

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const packageDir = mkdtempSync(join(tmpdir(), 'claude-npm-package-test-'));
const sourceDir = join(packageDir, 'artifacts');
const outDir = join(packageDir, 'npm');
mkdirSync(sourceDir);
for (const artifact of [
  'claude-code-v2.1.209-darwin-arm64',
  'claude-code-v2.1.209-linux-x64-baseline',
]) {
  writeFileSync(join(sourceDir, artifact), artifact);
}
try {
  execFileSync(
    process.execPath,
    ['./scripts/prepare-npm-package.mjs', sourceDir, outDir],
    {
      cwd: projectDir,
      env: { ...process.env, CLAUDE_CODE_VERSION: '2.1.209' },
      stdio: 'pipe',
    },
  );
  assert.equal(existsSync(join(outDir, 'darwin-arm64')), true);
  assert.equal(existsSync(join(outDir, 'linux-x64-baseline')), false);
  const mainPackage = JSON.parse(
    readFileSync(join(outDir, 'main', 'package.json'), 'utf8'),
  );
  assert.deepEqual(mainPackage.optionalDependencies, {
    '@esonhugh/claude-code-darwin-arm64': '2.1.209',
  });
} finally {
  rmSync(packageDir, { recursive: true, force: true });
}

console.log('build.test.mjs passed');

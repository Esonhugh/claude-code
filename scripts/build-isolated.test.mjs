import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import * as buildModule from './build.mjs';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const evidenceDir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'isolated-build-test-'));
console.log(`Retained build test evidence: ${evidenceDir}`);
assert.equal(typeof buildModule.prepareBuildDirectory, 'function');
const outputDir = path.join(evidenceDir, 'output');
assert.equal(buildModule.prepareBuildDirectory(outputDir), outputDir);
assert.equal(fs.statSync(outputDir).mode & 0o777, 0o700);
assert.throws(() => buildModule.prepareBuildDirectory(outputDir), /EEXIST/);
assert.throws(() => buildModule.prepareBuildDirectory(os.homedir()), /inside the repository|EEXIST/);
assert.throws(() => buildModule.prepareBuildDirectory('/etc/claude-build-forbidden'), /inside the repository/);
const existingLink = path.join(evidenceDir, 'existing-link');
fs.symlinkSync(outputDir, existingLink);
assert.throws(() => buildModule.prepareBuildDirectory(existingLink), /EEXIST/);
const danglingLink = path.join(evidenceDir, 'dangling-link');
fs.symlinkSync(path.join(evidenceDir, 'absent'), danglingLink);
assert.throws(() => buildModule.prepareBuildDirectory(danglingLink), /EEXIST/);
const homeLink = path.join(evidenceDir, 'home-link');
fs.symlinkSync(os.homedir(), homeLink);
assert.throws(() => buildModule.prepareBuildDirectory(path.join(homeLink, 'no-write')), /inside the repository/);
const canonicalOutput = path.join(fs.realpathSync(evidenceDir), 'canonical-output');
assert.equal(buildModule.prepareBuildDirectory(canonicalOutput), canonicalOutput);
// Check legacy repository acceptance without creating repository fixtures.
const buildSource = fs.readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');
const prepareSource = buildSource.slice(buildSource.indexOf('export function prepareBuildDirectory'), buildSource.indexOf('export async function buildCli')).replace('export ', '');
const repositoryOutput = path.join(projectDir, 'new-build-fixture');
let created;
runInNewContext(`${prepareSource}; prepareBuildDirectory(value)`, {
  projectDir, path, process, os, value: repositoryOutput,
  fs: { ...fs, mkdirSync(target, options) { created = { target, mode: options.mode }; } },
});
assert.deepEqual(created, { target: repositoryOutput, mode: 0o700 });
assert.throws(() => buildModule.prepareBuildDirectory(projectDir), /inside the repository/);
assert.throws(() => buildModule.prepareBuildDirectory(path.dirname(projectDir)), /inside the repository/);
const link = path.join(evidenceDir, 'outside-link');
fs.symlinkSync(path.dirname(projectDir), link);
assert.throws(() => buildModule.prepareBuildDirectory(path.join(link, 'no-write')), /inside the repository/);

const fixtureDir = path.join(evidenceDir, 'fixture');
fs.mkdirSync(path.join(fixtureDir, 'assets'), { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'assets', 'builtin-mods-2.1.277.zip'), 'archive fixture');
fs.mkdirSync(path.join(fixtureDir, 'dist', 'prebuilds'), { recursive: true });
fs.writeFileSync(path.join(fixtureDir, 'dist', 'prebuilds', 'keep'), 'old asset');
const originalRm = fs.promises.rm;
fs.promises.rm = async () => { throw new Error('Deletion forbidden'); };
try {
  await buildModule.copyRuntimeAssets({
    projectDir: fixtureDir,
    nodeModulesDir: path.join(fixtureDir, 'node_modules'),
    distDir: path.join(outputDir, 'dist'),
    isolated: true,
  });
} finally {
  fs.promises.rm = originalRm;
}
assert.equal(fs.readFileSync(path.join(outputDir, 'dist', 'assets', 'builtin-mods-2.1.277.zip'), 'utf8'), 'archive fixture');
assert.equal(fs.readFileSync(path.join(fixtureDir, 'dist', 'prebuilds', 'keep'), 'utf8'), 'old asset');

// Execute the packaging control flow with filesystem/subprocess doubles: no binary build.
const packageSource = fs.readFileSync(new URL('./package-binary.mjs', import.meta.url), 'utf8');
const writes = [];
const subprocesses = [];
const directories = [];
const entryTemplate = fs.readFileSync(new URL('./shims/embedded-ripgrep.js', import.meta.url), 'utf8');
const sharpTemplate = fs.readFileSync(new URL('./shims/embedded-sharp.js', import.meta.url), 'utf8');
const packageBody = packageSource.replace(/^import .*;\n/gm, '');
await runInNewContext(`(async () => { ${packageBody.replaceAll('import.meta.url', 'scriptUrl')} })()`, {
  scriptUrl: new URL('./package-binary.mjs', import.meta.url).href,
  fileURLToPath,
  path,
  process: { env: { CLAUDE_CODE_BUILD_DIR: outputDir }, platform: 'darwin', arch: 'arm64' },
  console: { log() {} },
  prepareBuildDirectory(value) { assert.equal(value, outputDir); return value; },
  async buildCli(options) { assert.equal(options.outputDir, outputDir); assert.equal(options.embedSharpNative, true); },
  fs: {
    existsSync: () => true,
    readdirSync: () => ['libvips-cpp.test.dylib'],
    promises: {
      async readFile(file) {
        if (file.endsWith('package.json')) return JSON.stringify({ version: '0.0.0-dev' });
        if (file.endsWith('embedded-ripgrep.js')) return entryTemplate;
        if (file.endsWith('embedded-sharp.js')) return sharpTemplate;
        throw new Error(`Unexpected read ${file}`);
      },
      async writeFile(file, contents) { writes.push({ file, contents }); },
      async mkdir(file) { directories.push(file); },
      async chmod(file) { assert.ok(file.startsWith(outputDir + path.sep)); },
    },
  },
  spawnSync(command, args, options) { subprocesses.push({ command, args, options }); return { status: 0 }; },
});
assert.equal(writes.length, 2);
for (const { file } of writes) assert.ok(file.startsWith(outputDir + path.sep), file);
for (const directory of directories) assert.ok(directory.startsWith(outputDir + path.sep), directory);
const entry = writes.find(({ file }) => file.endsWith('embedded-cli.js'));
assert.ok(entry.contents.includes(JSON.stringify(path.join(outputDir, 'dist', 'cli.js'))));
const compile = subprocesses.find(({ args }) => args.includes('--compile'));
assert.ok(compile);
assert.equal(compile.options.cwd, outputDir);
assert.equal(subprocesses.length, 2);
assert.equal(compile.args[compile.args.indexOf('--outfile') + 1], path.join(outputDir, 'built-claude'));
assert.ok(compile.args.includes(path.join(outputDir, 'dist', 'worker.js')));
const makePreview = execFileSync('make', ['-n', 'build', `CLAUDE_CODE_BUILD_DIR=${outputDir}`], { cwd: projectDir, encoding: 'utf8' });
assert.doesNotMatch(makePreview, /\b(?:mv|rm|cp)\b/);
assert.match(makePreview, /bun package:binary/);
fs.writeFileSync(path.join(evidenceDir, 'make-preview.txt'), makePreview);
console.log('build-isolated.test.mjs passed');

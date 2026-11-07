// Fast pre-push check: eslint and tsc as CI runs them, plus the unit tests of
// the files changed since the base branch. Usage:
//   bun run check:changed [base]   (base defaults to origin/dev)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'origin/dev';

function git(args) {
  const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

const [mergeBase] = git(['merge-base', 'HEAD', base]);
const changed = [
  ...new Set([
    ...git(['diff', '--name-only', '--diff-filter=ACMR', mergeBase]),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ]),
].filter(file => fs.existsSync(path.join(projectDir, file)));

// The CI lint and unit-test globs (see unit-tests.yml for the sandbox pair).
const lintable = changed.filter(file =>
  /^(src\/.*\.tsx?|types\/.*\.d\.ts|scripts\/.*\.mjs|bench\/.*\.ts)$/.test(file),
);
const sandboxOnly = new Set([
  'src/utils/permissions/permissions.networkLists.test.ts',
  'src/utils/sandbox/sandbox-adapter.test.ts',
]);
const isUnitTest = file =>
  /^(src\/.*\.test\.tsx?|web\/src\/.*\.test\.ts|bench\/.*\.test\.ts)$/.test(file) && !sandboxOnly.has(file);
const allTests = git(['ls-files', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'web/src/**/*.test.ts', 'bench/**/*.test.ts']);

// A changed foo.ts runs foo.test.ts and foo.*.test.ts beside it.
const tests = new Set(changed.filter(isUnitTest));
for (const file of changed) {
  const match = file.match(/^((?:src|web\/src|bench)\/.*)\.tsx?$/);
  if (!match || file.includes('.test.')) continue;
  for (const test of allTests) {
    if (test.startsWith(`${match[1]}.`) && isUnitTest(test)) {
      tests.add(test);
    }
  }
}

function run(label, command, args, env = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: projectDir,
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', code => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${label} (${seconds}s)`);
      resolve({ label, ok: code === 0, output });
    });
  });
}

async function runTests(files) {
  const queue = [...files];
  const results = [];
  const workers = Array.from({ length: Math.min(4, os.availableParallelism()) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      // Each file in its own process: module mocks leak across files.
      results.push(
        await run(`bun test ${file}`, 'bun', ['test', '--timeout', '60000', file], {
          ANTHROPIC_API_KEY: 'sk-ant-test-placeholder',
        }),
      );
    }
  });
  await Promise.all(workers);
  return results;
}

console.log(`${changed.length} changed files since ${base} (${mergeBase.slice(0, 7)}); ${tests.size} test files`);

const typecheck = async () => {
  // src/web/assets.ts imports the generated web/dist/assets.json.
  if (!fs.existsSync(path.join(projectDir, 'web/dist/assets.json'))) {
    const web = await run('build:web', 'bun', ['run', 'build:web']);
    if (!web.ok) return [web];
  }
  return [
    // Incremental: a second run only rechecks what changed.
    await run('tsc --noEmit', 'bunx', [
      'tsc', '--noEmit', '--pretty', 'false',
      '--incremental', '--tsBuildInfoFile', 'node_modules/.cache/tsc/check.tsbuildinfo',
    ], {
      NODE_OPTIONS: '--max-old-space-size=8192',
    }),
  ];
};

const results = (
  await Promise.all([
    lintable.length
      ? run(`eslint (${lintable.length} files)`, 'bunx', ['eslint', '--quiet', ...lintable]).then(r => [r])
      : [],
    lintable.length ? typecheck() : [],
    runTests([...tests]),
  ])
).flat();

const failed = results.filter(result => !result.ok);
for (const result of failed) {
  console.log(`\n===== ${result.label} =====\n${result.output.trimEnd()}`);
}
console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
process.exit(failed.length ? 1 : 0);

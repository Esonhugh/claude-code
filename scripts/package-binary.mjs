import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

run('bun', ['./scripts/build.mjs']);

if (!fs.existsSync(entrypoint)) {
  throw new Error('dist/cli.js does not exist after build. Check bun run build output before packaging.');
}

const bunCheck = spawnSync('bun', ['--version'], {
  cwd: projectDir,
  encoding: 'utf8',
});

if (bunCheck.error || bunCheck.status !== 0) {
  throw new Error('Bun is required for binary packaging. Install bun and rerun bun run package:binary.');
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

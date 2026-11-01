// Builds the bfs and ugrep that Linux and macOS binaries embed in place of the
// Glob/Grep tools (see src/utils/embeddedTools.ts). Sources are pinned in
// search-tools.mjs; output goes to dist/search-tools/<version>-<platform>-<arch>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_TOOL_SOURCES,
  searchToolsDir,
} from './search-tools.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { platform, arch } = process;
if (platform !== 'linux' && platform !== 'darwin') {
  console.log(`[search-tools] skipped: no bfs build for ${platform}`);
  process.exit(0);
}

const outputDir = searchToolsDir(projectDir, platform, arch);
if (['bfs', 'ugrep'].every(name => fs.existsSync(path.join(outputDir, name)))) {
  console.log(`[search-tools] cached: ${outputDir}`);
  process.exit(0);
}

const workDir = `${outputDir}.work`;
const prefix = path.join(workDir, 'prefix');
const jobs = String(os.availableParallelism());
// Static on Linux so one build serves both the glibc and musl binaries. bfs
// (C) links musl: static glibc can't look up users and groups (-user, -ls).
const staticLink = platform === 'linux';
const cEnv = { ...process.env, ...(staticLink ? { CC: 'musl-gcc' } : {}) };
if (staticLink && spawnSync('musl-gcc', ['--version']).status !== 0) {
  throw new Error('musl-gcc is required to build bfs (apt install musl-tools).');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function fetchSource({ name, repo, tag, commit, submodules }) {
  const dir = path.join(workDir, name);
  run('git', [
    'clone', '--quiet', '--depth', '1', '--branch', tag,
    ...(submodules ? ['--recurse-submodules', '--shallow-submodules'] : []),
    repo, dir,
  ]);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (head.stdout.trim() !== commit) {
    throw new Error(`${name} ${tag} is ${head.stdout.trim()}, expected ${commit}`);
  }
  return dir;
}

function cmakeInstall(sourceDir, installPrefix, flags, env = process.env) {
  const buildDir = path.join(sourceDir, 'build-cc');
  run('cmake', [
    '-S', sourceDir, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
    `-DCMAKE_INSTALL_PREFIX=${installPrefix}`,
    '-DCMAKE_INSTALL_LIBDIR=lib',
    ...flags,
  ], { env });
  run('cmake', ['--build', buildDir, '--parallel', jobs]);
  run('cmake', ['--install', buildDir]);
}

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
const sources = Object.fromEntries(
  SEARCH_TOOL_SOURCES.map(source => [source.name, fetchSource(source)]),
);

cmakeInstall(sources.pcre2, prefix, [
  '-DPCRE2_SUPPORT_JIT=ON',
  '-DPCRE2_BUILD_PCRE2GREP=OFF',
  '-DPCRE2_BUILD_TESTS=OFF',
]);
const bfsPrefix = path.join(workDir, 'bfs-prefix');
cmakeInstall(sources.oniguruma, bfsPrefix, ['-DBUILD_TEST=OFF'], cEnv);

// ugrep: PCRE2 for -P; no decompression or Boost (official routes -z to the
// system grep). A fresh clone gives every file the same mtime, so mark the
// generated autotools files newer than their inputs or make reruns automake.
run('sh', ['-c', 'touch aclocal.m4 && sleep 1 && touch configure && sleep 1 && find . -name Makefile.in -exec touch {} + && touch config.h.in'], {
  cwd: sources.ugrep,
});
run(
  './configure',
  [
    `--with-pcre2=${prefix}`,
    '--without-boost-regex', '--without-zlib', '--without-bzlib', '--without-lzma',
    '--without-lz4', '--without-zstd', '--without-brotli', '--without-bzip3',
    ...(staticLink ? ['--enable-static'] : []),
  ],
  { cwd: sources.ugrep },
);
run('make', ['-j', jobs], { cwd: sources.ugrep });

// bfs: Oniguruma for -regextype findutils-default, which the find wrapper sets.
const bfsEnv = {
  ...cEnv,
  PKG_CONFIG_PATH: path.join(bfsPrefix, 'lib', 'pkgconfig'),
  ...(staticLink ? { LDFLAGS: '-static' } : {}),
};
run(
  './configure',
  [
    '--enable-release',
    '--with-oniguruma',
    '--without-libacl', '--without-libcap', '--without-libselinux', '--without-liburing',
  ],
  { cwd: sources.bfs, env: bfsEnv },
);
run('make', ['-j', jobs], { cwd: sources.bfs, env: bfsEnv });

const stagingDir = `${outputDir}.staging`;
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
for (const [name, built] of [
  ['ugrep', path.join(sources.ugrep, 'bin', 'ugrep')],
  ['bfs', path.join(sources.bfs, 'bin', 'bfs')],
]) {
  const target = path.join(stagingDir, name);
  fs.copyFileSync(built, target);
  fs.chmodSync(target, 0o755);
  run('strip', [target]);
  run(target, ['--version'], { stdio: ['ignore', 'ignore', 'inherit'] });
}
fs.rmSync(outputDir, { recursive: true, force: true });
fs.renameSync(stagingDir, outputDir);
fs.rmSync(workDir, { recursive: true, force: true });
console.log(`[search-tools] built: ${outputDir}`);

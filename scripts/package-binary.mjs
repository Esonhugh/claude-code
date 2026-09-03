import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const distDir = path.join(projectDir, 'dist');
const nodeModulesDir = path.join(projectDir, 'node_modules');
const releaseDir = path.join(distDir, 'release');
const cliEntrypoint = path.join(distDir, 'cli.js');
const embeddedEntrypoint = path.join(
  projectDir,
  'scripts',
  'shims',
  'embedded-ripgrep.js',
);
const embeddedSharpPath = path.join(
  projectDir,
  'scripts',
  'shims',
  'embedded-sharp.js',
);
const packageJson = JSON.parse(
  await fs.promises.readFile(path.join(projectDir, 'package.json'), 'utf8'),
);

const defaultVersion = '0.0.0-dev';
const version =
  String(
    process.env.CLAUDE_CODE_VERSION ?? packageJson.version ?? defaultVersion,
  ).trim() || defaultVersion;
const binaryTarget = process.env.CLAUDE_CODE_BINARY_TARGET?.trim();
const supportedTargets = new Set([
  'bun-linux-x64-baseline',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
]);
const targetParts = binaryTarget?.match(
  /^bun-(darwin|linux|windows)-(arm64|x64)(-(?:baseline|musl))?$/,
);
if (binaryTarget && (!targetParts || !supportedTargets.has(binaryTarget))) {
  throw new Error(`Unsupported CLAUDE_CODE_BINARY_TARGET: ${binaryTarget}`);
}
const platform =
  targetParts?.[1] === 'windows'
    ? 'win32'
    : (targetParts?.[1] ?? process.platform);
const arch = targetParts?.[2] ?? process.arch;
const targetSuffix = targetParts?.[3] ?? '';
const artifactPlatform = `${platform}-${arch}${targetSuffix}`;
const extension = platform === 'win32' ? '.exe' : '';
const artifactName = `claude-code-v${version}-${artifactPlatform}${extension}`;
const outfile = path.join(releaseDir, artifactName);

function sharpPlatformArch() {
  if (platform === 'linux' && targetSuffix === '-musl') {
    return `linuxmusl-${arch}`;
  }
  return `${platform}-${arch}`;
}

function sharpAssetPaths() {
  const platformArch = sharpPlatformArch();
  const packageRoot = path.join(
    nodeModulesDir,
    '@img',
    `sharp-${platformArch}`,
  );
  const addonPath = path.join(
    packageRoot,
    'lib',
    `sharp-${platformArch}.node`,
  );
  const libraryRoot = platformArch.startsWith('win32-')
    ? packageRoot
    : path.join(nodeModulesDir, '@img', `sharp-libvips-${platformArch}`);
  const libraryDirectory = path.join(libraryRoot, 'lib');
  const libraryNames = fs.existsSync(libraryDirectory)
    ? fs.readdirSync(libraryDirectory).filter(name =>
        platformArch.startsWith('win32-')
          ? name.toLowerCase().endsWith('.dll')
          : name.startsWith('libvips-cpp.'),
      )
    : [];
  const expectedLibraryCount = platformArch.startsWith('win32-') ? 2 : 1;
  if (libraryNames.length !== expectedLibraryCount) {
    throw new Error(
      `Expected ${expectedLibraryCount} sharp runtime libraries in ${libraryDirectory}, found ${libraryNames.length}.`,
    );
  }
  return {
    platformArch,
    addonPath,
    libraryPaths: libraryNames.sort().map(name =>
      path.join(libraryDirectory, name),
    ),
  };
}

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
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}`,
    );
  }
}

run('bun', ['./scripts/build.mjs'], {
  env: { ...process.env, CLAUDE_CODE_EMBEDDED_SHARP: '1' },
});

if (!fs.existsSync(cliEntrypoint)) {
  throw new Error(
    'dist/cli.js does not exist after build. Check bun run build output before packaging.',
  );
}

const ripgrepPackageJson = JSON.parse(
  await fs.promises.readFile(
    path.join(nodeModulesDir, '@vscode', 'ripgrep', 'package.json'),
    'utf8',
  ),
);
const ripgrepBinaryName = platform === 'win32' ? 'rg.exe' : 'rg';
const ripgrepBinaryPath = path.join(
  nodeModulesDir,
  '@vscode',
  `ripgrep-${platform}-${arch}`,
  'bin',
  ripgrepBinaryName,
);
if (!fs.existsSync(ripgrepBinaryPath)) {
  throw new Error(
    `Could not find @vscode/ripgrep-${platform}-${arch}. ` +
      'Ensure optionalDependencies are installed for this platform.',
  );
}

const {
  platformArch: sharpPlatform,
  addonPath: sharpAddonPath,
  libraryPaths: sharpLibraryPaths,
} = sharpAssetPaths();
for (const assetPath of [sharpAddonPath, ...sharpLibraryPaths]) {
  if (!fs.existsSync(assetPath)) {
    throw new Error(
      `Could not find ${assetPath}. Ensure sharp optionalDependencies are installed for ${sharpPlatformArch()}.`,
    );
  }
}

const generatedSharpPath = path.join(projectDir, 'embedded-sharp.js');
const embeddedEntrypointContents = await fs.promises.readFile(
  embeddedEntrypoint,
  'utf8',
);
const generatedEntrypoint = path.join(projectDir, 'embedded-cli.js');
const generatedEntrypointContents = embeddedEntrypointContents
  .replace('__CLAUDE_CODE_RIPGREP_BINARY__', JSON.stringify(ripgrepBinaryPath))
  .replace('__CLAUDE_CODE_RIPGREP_VERSION__', ripgrepPackageJson.version)
  .replace(
    '__CLAUDE_CODE_EMBEDDED_SHARP__',
    JSON.stringify(generatedSharpPath),
  )
  .replace("'./cli.js'", "'./dist/cli.js'");
if (generatedEntrypointContents.includes('__CLAUDE_CODE_')) {
  throw new Error('Failed to generate embedded ripgrep entrypoint.');
}
await fs.promises.writeFile(generatedEntrypoint, generatedEntrypointContents);

const embeddedSharpContents = await fs.promises.readFile(
  embeddedSharpPath,
  'utf8',
);
const generatedSharpContents = embeddedSharpContents
  .replaceAll('__CLAUDE_CODE_SHARP_ADDON__', JSON.stringify(sharpAddonPath))
  .replaceAll(
    '__CLAUDE_CODE_SHARP_LIBRARY__',
    JSON.stringify(sharpLibraryPaths[0]),
  )
  .replaceAll(
    '__CLAUDE_CODE_SHARP_SECONDARY_LIBRARY__',
    JSON.stringify(sharpLibraryPaths[1] ?? sharpLibraryPaths[0]),
  )
  .replaceAll(
    '__CLAUDE_CODE_SHARP_PLATFORM_ARCH__',
    JSON.stringify(sharpPlatform),
  )
  .replaceAll(
    '__CLAUDE_CODE_SHARP_ADDON_NAME__',
    JSON.stringify(path.basename(sharpAddonPath)),
  )
  .replaceAll(
    '__CLAUDE_CODE_SHARP_LIBRARY_NAME__',
    JSON.stringify(path.basename(sharpLibraryPaths[0])),
  )
  .replaceAll(
    '__CLAUDE_CODE_SHARP_SECONDARY_LIBRARY_NAME__',
    JSON.stringify(path.basename(sharpLibraryPaths[1] ?? sharpLibraryPaths[0])),
  );
if (/__CLAUDE_CODE_SHARP_(?!NATIVE__)/.test(generatedSharpContents)) {
  throw new Error('Failed to generate embedded sharp module.');
}
await fs.promises.writeFile(generatedSharpPath, generatedSharpContents);

const bunCheck = spawnSync('bun', ['--version'], {
  cwd: projectDir,
  encoding: 'utf8',
});

if (bunCheck.error || bunCheck.status !== 0) {
  throw new Error(
    'Bun is required for binary packaging. Install bun and rerun bun run package:binary.',
  );
}

await fs.promises.mkdir(releaseDir, { recursive: true });

run('bun', [
  'build',
  '--compile',
  '--production',
  ...(binaryTarget ? ['--target', binaryTarget] : []),
  generatedEntrypoint,
  '--outfile',
  outfile,
]);

if (platform !== 'win32') {
  await fs.promises.chmod(outfile, 0o755);
}

console.log(outfile);

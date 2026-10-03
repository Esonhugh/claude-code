import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(rootDir, '..');
const nodeModulesDir = path.join(projectDir, 'node_modules');
const emptyModulePath = path.join(projectDir, 'scripts/shims/empty-module.js');
const missingModuleStubPath = path.join(
  projectDir,
  'scripts/shims/missing-module.cjs',
);
const missingTextStubPath = path.join(
  projectDir,
  'scripts/shims/missing-text.cjs',
);
const colorDiffFallbackPath = path.join(
  projectDir,
  'src/native-ts/color-diff/index.ts',
);
const imageProcessorFallbackPath = path.join(
  projectDir,
  'scripts/shims/image-processor-napi.js',
);
const sharpNativePath = path.join(
  projectDir,
  'scripts/shims/sharp-native.cjs',
);
const builtinModsArchiveName = 'builtin-mods-2.1.277.zip';
const defaultVersion = '0.0.0-dev';
const buildVersion = String(
  process.env.CLAUDE_CODE_VERSION ?? packageJson.version ?? defaultVersion,
).trim() || defaultVersion;

const builtinSet = new Set([
  ...builtinModules,
  ...builtinModules.map(value => `node:${value}`),
]);
const sourceExts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const unavailablePackagePrefixes = [
  '@ant/',
  'audio-capture-napi',
  'audio-capture.node',
  'modifiers-napi',
  'url-handler-napi',
];
const macros = {
  BUILD_TIME: '2026-03-30T21:59:52Z',
  FEEDBACK_CHANNEL: 'https://github.com/anthropics/claude-code/issues',
  ISSUES_EXPLAINER:
    'report the issue at https://github.com/anthropics/claude-code/issues',
  NATIVE_PACKAGE_URL: null,
  PACKAGE_URL: packageJson.name,
  VERSION: buildVersion,
  VERSION_CHANGELOG: null,
};
// Define the object for typeof guards while keeping property accesses inlined.
export const macroValues = Object.fromEntries([
  ['MACRO', JSON.stringify(macros)],
  ...Object.entries(macros).map(([key, value]) => [
    `MACRO.${key}`,
    JSON.stringify(value),
  ]),
]);

export function getEnabledFeatures(value = process.env.CLAUDE_CODE_RECOVER_FEATURES) {
  return new Set([
    'AGENT_TRIGGERS',
    'MCP_SKILLS',
    'SSH_REMOTE',
    'UDS_INBOX',
    ...(value ?? '')
      .split(',')
      .map(feature => feature.trim())
      .filter(Boolean),
  ]);
}

const enabledFeatures = getEnabledFeatures();
const embedSharpNative = process.env.CLAUDE_CODE_EMBEDDED_SHARP === '1';

function firstExisting(baseDir, candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(baseDir, candidate);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
  }
  return null;
}

function resolveSourceFile(basePath) {
  const candidates = [basePath];
  for (const ext of sourceExts) {
    candidates.push(basePath + ext);
  }

  if (basePath.endsWith('.js') || basePath.endsWith('.jsx')) {
    const stem = basePath.replace(/\.(js|jsx)$/, '');
    for (const ext of sourceExts) {
      candidates.push(stem + ext);
    }
  }

  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    candidates.push(path.join(basePath, `index${ext}`));
  }

  return firstExisting(projectDir, candidates.map(candidate =>
    path.isAbsolute(candidate) ? path.relative(projectDir, candidate) : candidate,
  ));
}

const recoveryResolver = embedSharpNative => ({
  name: 'recovery-resolver',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(md|txt)$/ }, async args => {
      const contents = await fs.promises.readFile(args.path, 'utf8');
      return { contents, loader: 'text' };
    });

    pluginBuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      if (
        !args.path.startsWith(path.join(projectDir, 'src')) &&
        !args.path.startsWith(path.join(projectDir, 'vendor'))
      ) {
        return null;
      }

      const original = await fs.promises.readFile(args.path, 'utf8');
      const contents = original.replace(
        /feature\((['"])([A-Z0-9_]+)\1\)/g,
        (_match, _quote, name) => (enabledFeatures.has(name) ? 'true' : 'false'),
      );

      const ext = path.extname(args.path);
      const loader =
        ext === '.tsx'
          ? 'tsx'
          : ext === '.ts'
            ? 'ts'
            : ext === '.jsx'
              ? 'jsx'
              : 'js';

      return { contents, loader };
    });

    pluginBuild.onResolve({ filter: /^src\// }, args => {
      const resolved = resolveSourceFile(path.join(projectDir, args.path));
      if (resolved) return { path: resolved };
      return {
        path: /\.(md|txt)$/.test(args.path)
          ? missingTextStubPath
          : missingModuleStubPath,
      };
    });

    pluginBuild.onResolve({ filter: /\.d\.ts$/ }, () => ({
      path: emptyModulePath,
    }));

    pluginBuild.onResolve({ filter: /^\.\.?\// }, args => {
      if (
        embedSharpNative &&
        args.path === './sharp' &&
        args.resolveDir.endsWith(path.join('sharp', 'lib'))
      ) {
        return { path: sharpNativePath };
      }
      const resolved = resolveSourceFile(path.resolve(args.resolveDir, args.path));
      if (resolved) return { path: resolved };
      return {
        path: /\.(md|txt)$/.test(args.path)
          ? missingTextStubPath
          : missingModuleStubPath,
      };
    });

    pluginBuild.onResolve({ filter: /^bun:bundle$/ }, () => ({
      path: path.join(projectDir, 'scripts/shims/bun-bundle.js'),
    }));

    pluginBuild.onResolve({ filter: /^bun:ffi$/ }, () => ({
      path: path.join(projectDir, 'scripts/shims/bun-ffi.js'),
    }));

    pluginBuild.onResolve({ filter: /^color-diff-napi$/ }, () => ({
      path: colorDiffFallbackPath,
    }));

    pluginBuild.onResolve({ filter: /^image-processor-napi$/ }, () => ({
      path: imageProcessorFallbackPath,
    }));

    pluginBuild.onResolve({ filter: /^[^./@#]|^\@/ }, args => {
      if (builtinSet.has(args.path)) {
        return { path: args.path, external: true };
      }

      if (
        unavailablePackagePrefixes.some(prefix => args.path === prefix || args.path.startsWith(prefix))
      ) {
        return { path: missingModuleStubPath };
      }


      return null;
    });
  },
});

export function prepareBuildDirectory(value) {
  const outputDir = path.resolve(projectDir, value);
  const repository = fs.realpathSync(projectDir);
  const parent = fs.realpathSync(path.dirname(outputDir));
  const target = path.join(parent, path.basename(outputDir));
  const roots = [repository, fs.realpathSync('/tmp')];
  const home = fs.realpathSync(os.homedir());
  const insideHome = target === home || target.startsWith(home + path.sep);
  const insideRepository = target.startsWith(repository + path.sep);
  if ((insideHome && !insideRepository) || !roots.some(root => {
    const relative = path.relative(root, target);
    return relative && relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })) {
    throw new Error('CLAUDE_CODE_BUILD_DIR must be a new directory inside the repository or /tmp');
  }
  // Resolve the parent before creating; exclusive creation rejects existing symlinks.
  fs.mkdirSync(target, { mode: 0o700 });
  return outputDir;
}

export async function buildCli({ outputDir, embedSharpNative: embeddedSharp = embedSharpNative } = {}) {
  const distDir = path.join(outputDir ?? projectDir, 'dist');
  await fs.promises.mkdir(distDir, { recursive: true });

  await build({
  absWorkingDir: projectDir,
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';

const require = __createRequire(import.meta.url);`,
  },
  bundle: true,
  define: macroValues,
  entryPoints: ['src/entrypoints/cli.tsx'],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  outfile: path.join(distDir, 'cli.js'),
  platform: 'node',
  plugins: [recoveryResolver(embeddedSharp)],
  sourcemap: true,
    target: 'node20',
  });

  await build({
    absWorkingDir: projectDir,
    entryPoints: ['src/services/mods/worker.ts'],
    outfile: path.join(distDir, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    legalComments: 'none',
  });

  await copyRuntimeAssets({ projectDir, nodeModulesDir, distDir, isolated: Boolean(outputDir) });
}

async function copyDirectoryFiles(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return false;

  await fs.promises.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.promises.readdir(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    const stat = await fs.promises.stat(sourcePath);
    if (stat.isDirectory()) {
      await copyDirectoryFiles(sourcePath, targetPath);
    } else if (stat.isFile()) {
      await fs.promises.copyFile(sourcePath, targetPath);
    }
  }
  return true;
}

function ripgrepSourceCandidates(nodeModulesDir) {
  return [
    path.join(
      nodeModulesDir,
      '@anthropic-ai',
      'ripgrep',
      `${process.arch}-${process.platform}`,
    ),
    path.join(
      nodeModulesDir,
      '@vscode',
      'ripgrep',
      'bin',
      `${process.arch}-${process.platform}`,
    ),
  ];
}

export async function copyRuntimeAssets({ projectDir, nodeModulesDir, distDir = path.join(projectDir, 'dist'), isolated = false }) {
  if (!isolated) {
    await fs.promises.rm(path.join(distDir, 'prebuilds'), {
      recursive: true,
      force: true,
    });
  }

  const builtinModsArchive = path.join(
    projectDir,
    'assets',
    builtinModsArchiveName,
  );
  if (!fs.existsSync(builtinModsArchive)) {
    throw new Error(`Missing builtin Mods archive: ${builtinModsArchive}`);
  }
  const builtinModsTarget = path.join(
    distDir,
    'assets',
    builtinModsArchiveName,
  );
  await fs.promises.mkdir(path.dirname(builtinModsTarget), { recursive: true });
  await fs.promises.copyFile(builtinModsArchive, builtinModsTarget);

  const ripgrepTargetDir = path.join(
    distDir,
    'vendor',
    'ripgrep',
    `${process.arch}-${process.platform}`,
  );
  for (const sourceDir of ripgrepSourceCandidates(nodeModulesDir)) {
    if (await copyDirectoryFiles(sourceDir, ripgrepTargetDir)) break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDir = process.env.CLAUDE_CODE_BUILD_DIR
    ? prepareBuildDirectory(process.env.CLAUDE_CODE_BUILD_DIR)
    : undefined;
  await buildCli({ outputDir });
}

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const packageJson = JSON.parse(
  await fs.promises.readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ),
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
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
];
const macroValues = {
  'MACRO.BUILD_TIME': JSON.stringify('2026-03-30T21:59:52Z'),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
    'https://github.com/anthropics/claude-code/issues',
  ),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'report the issue at https://github.com/anthropics/claude-code/issues',
  ),
  'MACRO.NATIVE_PACKAGE_URL': 'null',
  'MACRO.PACKAGE_URL': JSON.stringify('@anthropic-ai/claude-code'),
  'MACRO.VERSION': JSON.stringify(buildVersion),
  'MACRO.VERSION_CHANGELOG': 'null',
};

const enabledFeatures = new Set(
  (process.env.CLAUDE_CODE_RECOVER_FEATURES ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);

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

const recoveryResolver = {
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

    pluginBuild.onResolve({ filter: /^[^./@#]|^\@/ }, args => {
      if (builtinSet.has(args.path)) {
        return { path: args.path, external: true };
      }

      if (
        unavailablePackagePrefixes.some(prefix => args.path === prefix || args.path.startsWith(prefix))
      ) {
        return { path: missingModuleStubPath };
      }

      if (args.path === 'node-pty' || args.path.startsWith('node-pty/')) {
        return { path: args.path, external: true };
      }

      return null;
    });
  },
};

async function buildCli() {
  await fs.promises.mkdir(path.join(projectDir, 'dist'), { recursive: true });

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
  outfile: 'dist/cli.js',
  platform: 'node',
  plugins: [recoveryResolver],
  sourcemap: true,
    target: 'node20',
  });

  await copyRuntimeAssets({ projectDir, nodeModulesDir });
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

export async function copyRuntimeAssets({ projectDir, nodeModulesDir }) {
  const nodePtyPrebuildDir = path.join(
    nodeModulesDir,
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
  );
  const distPrebuildDir = path.join(
    projectDir,
    'dist',
    'prebuilds',
    `${process.platform}-${process.arch}`,
  );
  await copyDirectoryFiles(nodePtyPrebuildDir, distPrebuildDir);

  const ripgrepTargetDir = path.join(
    projectDir,
    'dist',
    'vendor',
    'ripgrep',
    `${process.arch}-${process.platform}`,
  );
  for (const sourceDir of ripgrepSourceCandidates(nodeModulesDir)) {
    if (await copyDirectoryFiles(sourceDir, ripgrepTargetDir)) break;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildCli();
}

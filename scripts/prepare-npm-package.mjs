import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const rootPackageJson = JSON.parse(
  await fs.promises.readFile(path.join(projectDir, 'package.json'), 'utf8'),
)

const version = String(
  process.env.CLAUDE_CODE_VERSION ?? rootPackageJson.version ?? '0.0.0-dev',
).trim()
const sourceDir = process.argv[2]
  ? path.resolve(projectDir, process.argv[2])
  : path.join(projectDir, 'dist', 'release')
const outDir = process.argv[3]
  ? path.resolve(projectDir, process.argv[3])
  : path.join(projectDir, 'dist', 'npm')

const binaryPattern = /^claude-code-v(.+)-([^-]+)-([^-]+)(\.exe)?$/
const binaryEntries = []

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Binary source directory does not exist: ${sourceDir}`)
}

for (const entry of await fs.promises.readdir(sourceDir)) {
  const match = entry.match(binaryPattern)
  if (!match) continue
  const [, binaryVersion, platform, arch, extension = ''] = match
  if (binaryVersion !== version) continue
  binaryEntries.push({
    arch,
    extension,
    filename: entry,
    packageName: `@esonhugh/claude-code-${platform}-${arch}`,
    platform,
    sourcePath: path.join(sourceDir, entry),
  })
}

if (binaryEntries.length === 0) {
  throw new Error(`No claude-code binaries for version ${version} found in ${sourceDir}`)
}

await fs.promises.rm(outDir, { recursive: true, force: true })
await fs.promises.mkdir(outDir, { recursive: true })

const publishConfig = { access: 'public' }

for (const entry of binaryEntries) {
  const packageDir = path.join(outDir, `${entry.platform}-${entry.arch}`)
  await fs.promises.mkdir(path.join(packageDir, 'bin'), { recursive: true })
  const targetPath = path.join(packageDir, 'bin', `claude${entry.extension}`)
  await fs.promises.copyFile(entry.sourcePath, targetPath)
  if (entry.extension !== '.exe') {
    await fs.promises.chmod(targetPath, 0o755)
  }

  await fs.promises.writeFile(
    path.join(packageDir, 'package.json'),
    `${JSON.stringify({
      name: entry.packageName,
      version,
      description: `Binary for @esonhugh/claude-code on ${entry.platform}-${entry.arch}`,
      private: false,
      license: rootPackageJson.license,
      os: [entry.platform],
      cpu: [entry.arch],
      files: ['bin/'],
      publishConfig,
    }, null, 2)}\n`,
  )

  await fs.promises.writeFile(
    path.join(packageDir, 'README.md'),
    `# ${entry.packageName}\n\nPlatform binary package for \`@esonhugh/claude-code\` on \`${entry.platform}-${entry.arch}\`.\n\nInstall \`@esonhugh/claude-code\` instead of this package directly.\n`,
  )
}

const mainDir = path.join(outDir, 'main')
await fs.promises.mkdir(path.join(mainDir, 'bin'), { recursive: true })
const optionalDependencies = Object.fromEntries(
  binaryEntries
    .map(entry => [entry.packageName, version])
    .sort(([left], [right]) => left.localeCompare(right)),
)

await fs.promises.writeFile(
  path.join(mainDir, 'package.json'),
  `${JSON.stringify({
    name: '@esonhugh/claude-code',
    version,
    description: 'unofficial claude code launch wrappers',
    private: false,
    type: 'module',
    license: rootPackageJson.license,
    bin: {
      claude: './bin/claude.js',
    },
    files: [
      'bin/',
      'README.md',
    ],
    optionalDependencies,
    publishConfig,
  }, null, 2)}\n`,
)

await fs.promises.writeFile(
  path.join(mainDir, 'README.md'),
  `# @esonhugh/claude-code\n\nUnofficial Claude Code launch wrappers.\n\nThis package is not an official Anthropic Claude Code distribution. It installs a small launcher and resolves a platform-specific binary from optional dependency packages such as \`@esonhugh/claude-code-darwin-arm64\`. It does not publish this repository's source code.\n\n## Usage\n\n\`\`\`bash\nnpm install -g @esonhugh/claude-code\nclaude --version\n\`\`\`\n`,
)

const launcher = [
  '#!/usr/bin/env node',
  "import { createRequire } from 'node:module'",
  "import { spawnSync } from 'node:child_process'",
  "import { existsSync } from 'node:fs'",
  "import { dirname, join } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  '',
  'const require = createRequire(import.meta.url)',
  "const packageName = `@esonhugh/claude-code-${process.platform}-${process.arch}`",
  "const extension = process.platform === 'win32' ? '.exe' : ''",
  'let packageJsonPath',
  '',
  'try {',
  '  packageJsonPath = require.resolve(`${packageName}/package.json`)',
  '} catch {',
  '  console.error(`No @esonhugh/claude-code binary package installed for ${process.platform}-${process.arch}.`)',
  '  console.error(`Expected optional dependency: ${packageName}`)',
  '  process.exit(1)',
  '}',
  '',
  'const binary = join(dirname(packageJsonPath), \'bin\', `claude${extension}`)',
  '',
  'if (!existsSync(binary)) {',
  '  console.error(`Binary not found in ${packageName}: ${binary}`)',
  '  process.exit(1)',
  '}',
  '',
  "const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' })",
  'if (result.error) {',
  '  console.error(result.error.message)',
  '  process.exit(1)',
  '}',
  'process.exit(result.status ?? 1)',
  '',
].join('\n')

await fs.promises.writeFile(path.join(mainDir, 'bin', 'claude.js'), launcher)
await fs.promises.chmod(path.join(mainDir, 'bin', 'claude.js'), 0o755)

console.log(mainDir)

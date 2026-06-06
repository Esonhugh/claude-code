#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const bundlePath = resolve(projectRoot, 'dist', 'workflowBinaryCompatibilityRunner.mjs')
const outputRoot = resolve(projectRoot, '.claude', 'workflow-binary-compatibility')
const officialBinary = process.env.OFFICIAL_CLAUDE_BINARY ?? '/opt/homebrew/bin/claude'
const cliArgs = process.argv.slice(2)
const runnerArgs = cliArgs.includes('--resume')
  ? cliArgs.filter(arg => arg !== '--resume')
  : [...cliArgs.filter(arg => arg !== '--force'), '--force']

const buildResult = spawnSync(process.execPath, ['./scripts/build.mjs'], {
  cwd: projectRoot,
  stdio: 'inherit',
})
if (buildResult.status !== 0) {
  throw new Error('Failed to build local Claude Code before compatibility run')
}

await mkdir(dirname(bundlePath), { recursive: true })
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/tools/WorkflowTool/compatibility/runnerCli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
})

if (!existsSync(officialBinary)) {
  throw new Error(`Official Claude binary not found: ${officialBinary}`)
}

const { main } = await import(pathToFileURL(bundlePath).href)
await main({
  projectRoot,
  outputRoot,
  officialBinary,
  args: runnerArgs,
})

const reportPath = join(outputRoot, 'workflow-compatibility-report.json')
const report = JSON.parse(await readFile(reportPath, 'utf8'))
console.log(`workflow compatibility cases: ${report.completedCases}/${report.totalCases}`)
console.log(`workflow compatibility score: ${report.score}`)
console.log(`workflow compatibility output: ${outputRoot}`)

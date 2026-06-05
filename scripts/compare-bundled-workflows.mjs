#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const bundlePath = resolve(projectRoot, 'dist', 'bundledWorkflowCompare.mjs')
await build({
  absWorkingDir: projectRoot,
  entryPoints: ['src/tools/WorkflowTool/bundled/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
})

const { getBundledWorkflowSpecs } = await import(pathToFileURL(bundlePath).href)
const metadataPath = resolve(projectRoot, '.claude', 'official-workflow-metadata.json')
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
const localNames = new Set(getBundledWorkflowSpecs().map(workflow => workflow.name))
const officialNames = metadata.workflows.map(workflow => workflow.name)
const restored = officialNames.filter(name => localNames.has(name))
const missing = officialNames.filter(name => !localNames.has(name))
const coverage = officialNames.length === 0 ? 100 : Math.round((restored.length / officialNames.length) * 100)

console.log(`bundled workflow coverage: ${coverage}%`)
console.log(`restored: ${restored.join(', ') || 'none'}`)
console.log(`missing: ${missing.join(', ') || 'none'}`)
if (coverage < 50) {
  process.exitCode = 1
}

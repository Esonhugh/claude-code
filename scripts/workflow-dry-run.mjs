#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const workflowPath = process.argv[2]

if (!workflowPath) {
  console.error('Usage: node scripts/workflow-dry-run.mjs <workflow.json>')
  process.exit(1)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const absoluteWorkflowPath = resolve(process.cwd(), workflowPath)
const tempDir = await mkdtemp(resolve(tmpdir(), 'workflow-dry-run-'))
const runnerPath = resolve(tempDir, 'runner.mjs')
const bundledRunnerPath = resolve(tempDir, 'runner.bundle.mjs')

try {
  await writeFile(
    runnerPath,
    `import { readFile } from 'node:fs/promises'\n` +
      `import { validateWorkflowSpec } from ${JSON.stringify(resolve(projectRoot, 'src/tools/WorkflowTool/validateWorkflowSpec.ts'))}\n` +
      `import { formatWorkflowDryRun } from ${JSON.stringify(resolve(projectRoot, 'src/tools/WorkflowTool/formatWorkflowDryRun.ts'))}\n` +
      'const workflowPath = process.argv[2]\n' +
      'if (!workflowPath) throw new Error(\'Workflow file path argument is required\')\n' +
      'const spec = JSON.parse(await readFile(workflowPath, \'utf8\'))\n' +
      'const plan = validateWorkflowSpec(spec)\n' +
      'process.stdout.write(formatWorkflowDryRun(plan))\n',
  )

  await build({
    entryPoints: [runnerPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundledRunnerPath,
    logLevel: 'silent',
  })

  process.argv[2] = absoluteWorkflowPath
  await import(pathToFileURL(bundledRunnerPath).href)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Workflow dry-run failed: ${message}`)
  process.exitCode = 1
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

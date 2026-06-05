#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const tests = [
  'src/tools/WorkflowTool/workflowSpec.test.ts',
  'src/tools/WorkflowTool/workflowDiscovery.test.ts',
  'src/tools/WorkflowTool/workflowDsl.test.ts',
  'src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts',
  'src/tools/WorkflowTool/workflowScriptPersistence.test.ts',
  'src/tools/WorkflowTool/workflowOrchestrator.test.ts',
  'src/tools/WorkflowTool/workflowCommand.test.ts',
  'src/tools/WorkflowTool/WorkflowTool.test.ts',
  'src/tools/WorkflowTool/WorkflowFacadeTool.test.ts',
  'src/commands/workflows/workflows.test.ts',
  'src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts',
]

for (const test of tests) {
  const outfile = resolve(projectRoot, 'dist', `${test.replace(/[^A-Za-z0-9_-]+/g, '-')}.mjs`)
  await mkdir(dirname(outfile), { recursive: true })

  await build({
    absWorkingDir: projectRoot,
    entryPoints: [test],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
  })

  await import(pathToFileURL(outfile).href)
}

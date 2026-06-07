#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const tests = [
  'src/tools/WorkflowTool/compatibility/types.test.ts',
  'src/tools/WorkflowTool/compatibility/caseMatrix.test.ts',
  'src/tools/WorkflowTool/compatibility/runCommand.test.ts',
  'src/tools/WorkflowTool/compatibility/artifacts.test.ts',
  'src/tools/WorkflowTool/compatibility/executors.test.ts',
  'src/tools/WorkflowTool/compatibility/normalize.test.ts',
  'src/tools/WorkflowTool/compatibility/compare.test.ts',
  'src/tools/WorkflowTool/compatibility/reconstruct.test.ts',
  'src/tools/WorkflowTool/compatibility/report.test.ts',
  'src/tools/WorkflowTool/compatibility/runner.test.ts',
  'scripts/workflow-deobfuscator.test.mjs',
  'src/tools/WorkflowTool/bundled/index.test.ts',
  'src/tools/WorkflowTool/workflowFeatureFlags.test.ts',
  'src/tools/WorkflowTool/workflowSpec.test.ts',
  'src/tools/WorkflowTool/workflowEvents.test.ts',
  'src/tools/WorkflowTool/workflowResumeCache.test.ts',
  'src/tools/WorkflowTool/workflowRuntimeGlobals.test.ts',
  'src/tools/WorkflowTool/workflowDiscovery.test.ts',
  'src/tools/WorkflowTool/workflowScriptParser.test.ts',
  'src/tools/WorkflowTool/workflowDsl.test.ts',
  'src/tools/WorkflowTool/workflowCompatibilityBenchmark.test.ts',
  'src/tools/WorkflowTool/workflowScriptPersistence.test.ts',
  'src/tools/WorkflowTool/workflowOrchestrator.test.ts',
  'src/tools/WorkflowTool/workflowCommand.test.ts',
  'src/tools/WorkflowTool/workflowPermissionPreview.test.ts',
  'src/tools/WorkflowTool/workflowPermissionPreviewInput.test.ts',
  'src/tools/WorkflowTool/WorkflowPermissionRequest.test.ts',
  'src/tools/WorkflowTool/WorkflowTool.test.ts',
  'src/tools/WorkflowTool/WorkflowFacadeTool.test.ts',
  'src/utils/ultracodeOrchestration.test.ts',
  'src/utils/processUserInput/processUserInput.test.ts',
  'src/commands/workflows/workflows.test.ts',
  'src/commands/workflows/workflowsPage.behavior.test.ts',
  'src/commands/workflows/workflowsPageModel.test.ts',
  'src/tasks/LocalWorkflowTask/LocalWorkflowTask.test.ts',
  'src/components/tasks/workflowDetailSnapshot.test.ts',
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

  const result = spawnSync(process.execPath, [outfile], {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${test} failed`)
  }
}

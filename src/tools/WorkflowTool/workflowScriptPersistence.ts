import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { workflowSessionDir } from './workflowRunSessions.js'

// Official 2.1.303's script file name: <sanitized name>-<runId>.js
export function sanitizeWorkflowFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
}

export function createWorkflowRunId(): string {
  return `wf_${randomUUID().slice(0, 12)}`
}

export async function persistWorkflowScript({
  cwd,
  workflowRunId,
  name,
  script,
}: {
  cwd: string
  workflowRunId: string
  name: string
  script: string
}): Promise<string> {
  const scriptsDir = join(workflowSessionDir(cwd), 'workflows', 'scripts')
  await mkdir(scriptsDir, { recursive: true })
  const scriptPath = join(scriptsDir, `${sanitizeWorkflowFileName(name)}-${workflowRunId}.js`)
  await writeFile(scriptPath, script)
  return realpath(scriptPath)
}

export async function resolveWorkflowScriptPath({
  cwd,
  scriptPath,
}: {
  cwd: string
  scriptPath: string
}): Promise<string> {
  const normalized = normalize(isAbsolute(scriptPath) ? scriptPath : join(cwd, scriptPath))
  return realpath(normalized)
}

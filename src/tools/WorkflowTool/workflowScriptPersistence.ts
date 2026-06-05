import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

function sanitizeWorkflowFileName(name: string): string {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${sanitized || 'workflow'}.js`
}

export function createWorkflowRunId(): string {
  const [first = Date.now().toString(36), second = 'run'] =
    randomUUID().replace(/-/g, '').match(/.{1,12}/g) ?? []
  return `wf_${first}_${second}`
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
  const runDir = join(cwd, '.claude', 'workflow-runs', workflowRunId)
  await mkdir(runDir, { recursive: true })
  const scriptPath = join(runDir, sanitizeWorkflowFileName(name))
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

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clearCommandsCache } from '../../commands.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { workflowSaveDir, type WorkflowSaveScope } from './workflowDiscovery.js'
import { hasWorkflowScriptMeta, parseWorkflowScript } from './workflowScriptParser.js'
import { sanitizeWorkflowFileName } from './workflowScriptPersistence.js'

// Like official 2.1.303: a dynamic workflow's script is saved as a named workflow under
// .claude/workflows (project) or ~/.claude/workflows (user), where discovery already looks.
export const WORKFLOW_SAVE_OVERWRITE_HINT = 'Use a different name or overwrite.'

export function workflowSavePathPreview(name: string, scope: WorkflowSaveScope): string {
  const file = `${sanitizeWorkflowFileName(name)}.js`
  return scope === 'project' ? `.claude/workflows/${file}` : `~/.claude/workflows/${file}`
}

// The dialog's prefilled name: the script's meta.name, else the run's summary.
export function defaultDynamicWorkflowName(
  task: Pick<LocalWorkflowTaskState, 'runScriptSnapshot' | 'summary' | 'description'>,
): string {
  const script = task.runScriptSnapshot ?? ''
  if (hasWorkflowScriptMeta(script)) {
    try {
      return parseWorkflowScript(script).meta.name
    } catch {
      // fall back to the summary like official does for an unparsable script
    }
  }
  return sanitizeWorkflowFileName(task.summary ?? task.description)
}

export async function saveDynamicWorkflow({
  name,
  scope,
  script,
  overwrite,
  cwd,
  home,
}: {
  name: string
  scope: WorkflowSaveScope
  script: string
  overwrite: boolean
  cwd: string
  home?: string
}): Promise<{ name: string; path: string; scope: WorkflowSaveScope }> {
  const fileName = sanitizeWorkflowFileName(name)
  const dir = await workflowSaveDir(scope, cwd, { home })
  const path = join(dir, `${fileName}.js`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, script, { encoding: 'utf8', mode: 0o600, flag: overwrite ? 'w' : 'wx' })
  } catch (error) {
    if (!overwrite && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Dynamic workflow "${fileName}" already exists at ${path}. ${WORKFLOW_SAVE_OVERWRITE_HINT}`)
    }
    throw error
  }
  // The file is a /<name> command and a Workflow({name}) target from now on.
  clearCommandsCache()
  resetSentSkillNames()
  return { name: fileName, path, scope }
}

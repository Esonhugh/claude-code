// Background task entry for a Code Mode script the async lane dispatched
// (official 2.1.325 ScriptTask, chunk-x5qyz3j2.js). It makes the script
// visible in the footer pill and the Shift+Down dialog while it runs, after
// the turn that dispatched it too. The script itself runs in the REPL
// session; this is UI surfacing via the task registry.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { replScriptLabel } from '../../tools/REPLTool/scriptLabel.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type ScriptTaskState = TaskStateBase & {
  type: 'local_script'
  /** Stops the script; dropped once the task ends. */
  abortController?: AbortController
}

/** Official `UNNAMED_SCRIPT`: the label of a script without a description. */
export const UNNAMED_SCRIPT = 'started by Claude'

const DESCRIPTION_CHARS = 200

export function isScriptTask(task: unknown): task is ScriptTaskState {
  return typeof task === 'object' && task !== null && 'type' in task && task.type === 'local_script'
}

/** Official `registerScriptTask`: a running task labelled with the script's description. */
export function registerScriptTask(
  setAppState: SetAppState,
  opts: { description: string | undefined; toolUseId: string | undefined; abortController: AbortController },
): string {
  const label = replScriptLabel(opts.description) || UNNAMED_SCRIPT
  const chars = [...label]
  const description = chars.length > DESCRIPTION_CHARS ? `${chars.slice(0, DESCRIPTION_CHARS).join('')}\u2026` : label
  const id = generateTaskId('local_script')
  registerTask(
    {
      ...createTaskStateBase(id, 'local_script', description, opts.toolUseId),
      type: 'local_script',
      status: 'running',
      outputFile: '',
      abortController: opts.abortController,
    },
    setAppState,
  )
  return id
}

/**
 * Official `endScriptTask`: the script ended or was stopped. Notified at
 * once, since its outcome reaches Claude as a poll event, not a task
 * notification. False when the task had already ended.
 */
export function endScriptTask(taskId: string, setAppState: SetAppState, status: 'completed' | 'killed'): boolean {
  let ended = false
  updateTaskState<ScriptTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    ended = true
    return { ...task, status, endTime: Date.now(), notified: true, abortController: undefined }
  })
  return ended
}

/**
 * Stops the script as the user would stop it from the tasks dialog. Its
 * abort listener ends the task.
 */
export function stopScriptTask(taskId: string, setAppState: SetAppState): void {
  // Read the controller first: aborting inside the updater would end the
  // task from within this same state update, which then overwrites it.
  let controller: AbortController | undefined
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (isScriptTask(task) && task.status === 'running') controller = task.abortController
    return prev
  })
  controller?.abort('user-cancel')
}

export const ScriptTask: Task = {
  name: 'ScriptTask',
  type: 'local_script',
  async kill(taskId, setAppState) {
    stopScriptTask(taskId, setAppState)
  },
}

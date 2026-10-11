import type { ProgramStatus } from '../ink/termio/osc.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'

export type ProgramStatusInput = {
  sandboxPending: boolean
  pendingTool?: string
  questionPending: boolean
  busy: boolean
}

/** Select the foreground REPL status independently of rendering and startup. */
export function selectProgramStatus(input: ProgramStatusInput): ProgramStatus {
  if (input.sandboxPending) return { state: 'blocked', kind: 'permission' }
  if (input.pendingTool !== undefined) {
    return {
      state: 'blocked',
      kind: input.pendingTool === ASK_USER_QUESTION_TOOL_NAME ? 'question' : 'permission',
    }
  }
  if (input.questionPending) return { state: 'blocked', kind: 'question' }
  return { state: input.busy ? 'working' : 'idle' }
}

import type { ProgramStatus } from '../ink/termio/osc.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'

export type ProgramTurnEnd = null | 'completed' | 'stopped' | { errorKind?: string; failure: string }
export type ProgramBlockedOn = 'permission prompt' | 'sandbox request' | 'worker request' | 'goal proposal' | 'input needed' | 'dialog open'
export type ProgramStatusInput = {
  busy: boolean
  queued: boolean
  blockedOn?: ProgramBlockedOn
  lastTurnEnd: ProgramTurnEnd
  signedInSinceLastTurn: boolean
  blockedText?: string
  workingDetail?: string
  doneDetail?: string
  progress?: number
}

const BLOCKED_KIND = {
  'permission prompt': 'permission',
  'sandbox request': 'permission',
  'worker request': 'permission',
  'goal proposal': 'permission',
  'input needed': 'question',
  'dialog open': undefined,
} as const
const AUTH_ERROR_KINDS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error'])

/** Official 2.1.296: busy, waiting, then the previous turn's retained outcome. */
export function selectProgramStatus(input: ProgramStatusInput): ProgramStatus {
  if (input.busy || (input.queued && input.blockedOn === undefined)) return { state: 'working', progress: input.progress, msg: input.workingDetail }
  if (input.blockedOn !== undefined) {
    const kind = BLOCKED_KIND[input.blockedOn]
    return { state: 'blocked', ...(kind ? { kind } : {}), progress: input.progress, msg: input.blockedText ?? input.blockedOn }
  }
  const end = input.lastTurnEnd
  if (end === 'completed') return { state: 'done', msg: input.doneDetail }
  if (end === null || end === 'stopped') return { state: 'idle' }
  if (end.errorKind === undefined || !AUTH_ERROR_KINDS.has(end.errorKind)) return { state: 'error', msg: end.failure }
  return input.signedInSinceLastTurn ? { state: 'idle' } : { state: 'blocked', kind: 'auth', msg: end.failure }
}

export function programTurnEnd(
  aborted: boolean,
  last?: { type: string; isApiErrorMessage?: boolean; error?: unknown },
  failure = '',
): ProgramTurnEnd {
  if (aborted) return 'stopped'
  if (last?.type === 'assistant' && last.isApiErrorMessage) return { errorKind: typeof last.error === 'string' ? last.error : undefined, failure: programStatusFailure(failure) }
  return 'completed'
}

/** Bridge this build's SDK JSON envelope to the official terminal failure text. */
function programStatusFailure(failure: string): string {
  const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean)
  const line = firstLine(failure) ?? 'Turn failed'
  const envelope = /^(API Error: \d+ )(\{.*\})$/.exec(line)
  if (!envelope) return line
  try {
    const body: unknown = JSON.parse(envelope[2]!)
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return firstLine(envelope[1] + error.message) ?? line
      }
    }
  } catch {
    // Non-JSON provider errors retain their original first line.
  }
  return line
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/** Official c2/Ud: whitespace cleanup and 800 UTF-16 units, including ellipsis. */
function squashProgramStatusText(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= 800) return clean
  let end = 799
  const last = clean.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return clean.slice(0, end) + '…'
}

export function programStatusAskText<Input>(
  tool: { name: string; userFacingName(input: Input): string },
  input: Input,
): string {
  const data = record(input)
  if (tool.name === ASK_USER_QUESTION_TOOL_NAME) {
    let question = ''
    let labels: string[] | undefined
    const questions = data?.questions
    for (const raw of Array.isArray(questions) ? questions : []) {
      const item = record(raw)
      if (typeof item?.question !== 'string') continue
      question ||= item.question
      const options = Array.isArray(item.options) ? item.options.flatMap(option => {
        const label = record(option)?.label
        return typeof label === 'string' ? [label] : []
      }) : []
      if (options.length > 0 && labels === undefined) labels = options
    }
    return question ? squashProgramStatusText(`answer: ${question}${labels ? ` (${labels.join(' · ')})` : ''}`) : 'answer question'
  }
  if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) return 'approve plan'
  const name = tool.userFacingName(input).trim() || tool.name
  const arg = [data?.command, data?.file_path, data?.url].find(value => typeof value === 'string')
  return typeof arg === 'string' && arg && !name.includes(arg)
    ? squashProgramStatusText(`approve ${name}: ${arg}`)
    : `approve ${name}`
}

export function programStatusBlockedText(input: {
  blockedOn?: ProgramBlockedOn
  askText?: string
  sandboxHost?: string
  worker?: { toolName: string; description: string }
  elicitationServer?: string
}): string | undefined {
  switch (input.blockedOn) {
    case 'permission prompt':
    case 'goal proposal': return input.askText
    case 'input needed': return input.elicitationServer === undefined ? input.askText : `MCP input: ${input.elicitationServer}`
    case 'sandbox request': return input.sandboxHost === undefined ? undefined : `allow network: ${input.sandboxHost}`
    case 'worker request': return input.worker ? squashProgramStatusText(`approve ${input.worker.toolName}: ${input.worker.description}`) : undefined
    default: return undefined
  }
}

export function programStatusProgress(tasks: readonly { status: string }[] | undefined): number | undefined {
  if (!tasks?.length) return undefined
  return 100 * tasks.filter(task => task.status === 'completed').length / tasks.length
}

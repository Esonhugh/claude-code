import { randomUUID } from 'crypto'
import { CODE_MODE_ONLY_TOOLS, POLL_TOOL_NAME, REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import {
  CANCEL_MESSAGE,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  wrapInSystemReminder,
} from './messages.js'

const NO_SUCH_TOOL = '<tool_use_error>Error: No such tool available: '
const REPL_RESULT = /^\s*(?:<repl-output[\s>]|\(dispatched #\d+\))/
// Built on first use: messages.js is still initializing when the resume path imports this module.
let cancelled: Set<string> | undefined
const isCancelled = (text: string) =>
  (cancelled ??= new Set([INTERRUPT_MESSAGE_FOR_TOOL_USE, CANCEL_MESSAGE, REJECT_MESSAGE])).has(text)

/** Official `BS` names the mode with its label; the rest of the notice says Code Mode. */
export const CODE_MODE_TAKEN_OUT_NOTICE =
  "This session was started in Code Mode (experimental), which isn't available where it runs now. It continues with the ordinary tools and stays out of Code Mode from now on."

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: unknown }

function blocks(message: Message): Block[] {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

function firstText(content: unknown): string {
  const first = typeof content === 'string' ? content : Array.isArray(content) ? content[0] : undefined
  if (typeof first === 'string') return first
  const block = first as Block | undefined
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/**
 * Whether a transcript without a repl-mode entry was a Code Mode session
 * (official 2.1.325 `_()`): the last real REPL call with a `<repl-output>`
 * result says yes, the last answered call to a Code-Mode-only tool says no.
 * Undefined when neither appears.
 */
export function inferCodeModeFromMessages(messages: readonly Message[]): boolean | undefined {
  const replResult = new Set<string>()
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    for (const block of blocks(message)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const text = firstText(block.content)
      if (block.is_error !== true) {
        if (REPL_RESULT.test(text)) replResult.add(block.tool_use_id)
        answered.add(block.tool_use_id)
      } else if (!text.startsWith(NO_SUCH_TOOL) && !isCancelled(text)) answered.add(block.tool_use_id)
    }
  }
  let codeMode: boolean | undefined
  for (const message of messages) {
    if (message.type !== 'assistant' || (message as { isVirtual?: boolean }).isVirtual) continue
    for (const block of blocks(message)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
      if (block.name === REPL_TOOL_NAME && replResult.has(block.id)) codeMode = true
      else if (CODE_MODE_ONLY_TOOLS.has(block.name) && answered.has(block.id)) codeMode = false
    }
  }
  return codeMode
}

const DISPATCHED = /^\(dispatched #(\d+)\)/
const DELIVERED = /<event (?:nonce="[^"]+" )?kind="repl-eval"[^>]* eval="(\d+)"/g

/**
 * Official `npr`: evals dispatched to the background whose outcome never
 * reached the conversation, in dispatch order, each with the time its
 * receipt was recorded. An outcome arrives as a repl-eval event, in a Poll
 * result or queued before a turn.
 */
function unsettledEvals(messages: readonly Message[]): { evalId: number; recordedAt: string }[] {
  const repl = new Set<string>()
  const open: { evalId: number; recordedAt: string }[] = []
  for (const message of messages) {
    if (message.type === 'assistant' && !(message as { isVirtual?: boolean }).isVirtual) {
      for (const block of blocks(message))
        if (block.type === 'tool_use' && block.name === REPL_TOOL_NAME && typeof block.id === 'string') repl.add(block.id)
      continue
    }
    if (message.type !== 'user' && message.type !== 'attachment') continue
    for (const block of blocks(message)) {
      const id = block.type === 'tool_result' && typeof block.tool_use_id === 'string' && repl.has(block.tool_use_id)
        ? DISPATCHED.exec(firstText(block.content))?.[1]
        : undefined
      if (id !== undefined) open.push({ evalId: Number(id), recordedAt: (message as { timestamp?: string }).timestamp ?? '' })
    }
    for (const [, id] of JSON.stringify(message).replaceAll('\\"', '"').matchAll(DELIVERED)) {
      const at = open.findLastIndex(entry => entry.evalId === Number(id))
      if (at !== -1) open.splice(at, 1)
    }
  }
  return open
}

/** Official `_so`: what the model is told about an eval its exited process left unsettled. */
export function lostEvalText(id: number): string {
  return `eval #${id} never settled: the process that was running it exited. Its result is lost and the script is no longer running; a command it had started may have run on.`
}

/** Official `uJt`: the row a lost eval shows, an errored Code call of its own (virtual, not sent to the API). */
function lostEvalRow(text: string): Message[] {
  const id = `repl_lost_${randomUUID()}`
  const assistant = createAssistantMessage({
    content: [{ type: 'tool_use', id, name: REPL_TOOL_NAME, input: {} }] as never,
    isVirtual: true,
  })
  const user = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }],
    toolUseResult: { error: text, shownOnCall: true },
    isVirtual: true,
    sourceToolAssistantUUID: assistant.uuid,
  })
  return [assistant, user]
}

/**
 * Official `qKa` (`reportLostReplEvals`): on a Code Mode resume, answers each
 * eval an earlier process dispatched and never settled with a lost poll
 * event, so the model stops waiting for it. Runs after launch, once the
 * session id and event delivery are settled. The interactive caller passes
 * `startsTurn: false`: the event waits for the next delivery. Returns the
 * rows the transcript shows for the lost evals (official `displayRows`).
 */
export async function reportLostReplEvals(
  messages: readonly Message[],
  { startsTurn = true }: { startsTurn?: boolean } = {},
): Promise<Message[]> {
  const { isCodeModeEnabled, isReplEventDeliveryEnabled } = await import('../tools/REPLTool/codeModeGate.js')
  if (!isCodeModeEnabled()) return []
  const lost = unsettledEvals(messages).filter(entry => Date.parse(entry.recordedAt) < performance.timeOrigin)
  if (lost.length === 0) return []
  if (!isReplEventDeliveryEnabled()) {
    logForDebugging(
      `resume: ${lost.length} async REPL eval(s) never settled, and poll-event delivery is off, so no lost event is queued`,
      { level: 'warn' },
    )
    return []
  }
  logForDebugging(
    `resume: ${lost.length} async REPL eval(s) never settled (${lost.map(entry => `#${entry.evalId}`).join(', ')}); answering each with a lost event`,
  )
  const { formatReplLostEvent } = await import('../tools/REPLTool/sessions.js')
  const { enqueuePollEvent, REPL_EVAL_EVENT_KIND } = await import('./messageQueueManager.js')
  const rows: Message[] = []
  for (const { evalId } of lost) {
    const refused = (error: unknown) =>
      logForDebugging(
        `async REPL lost event for eval #${evalId} not queued: ${error instanceof Error ? error.message : 'non-Error rejection'}`,
        { level: 'warn' },
      )
    try {
      enqueuePollEvent({
        kind: REPL_EVAL_EVENT_KIND,
        element: formatReplLostEvent(evalId, lostEvalText(evalId)),
        ...(!startsTurn && { startsTurn: false }),
      }).catch(refused)
      rows.push(...lostEvalRow('Lost: Claude Code exited before this finished'))
    } catch (error) {
      refused(error)
    }
  }
  return rows
}

/** Official `M()`, with a line for each eval left unsettled (official `_so`). */
export function codeModeOffReminder(messages: readonly Message[] = []): string {
  return [
    'Code Mode is off in this session.',
    `Do not call ${REPL_TOOL_NAME} or ${POLL_TOOL_NAME}. They may still be in your tool list, but every call to them is refused. Disregard their descriptions, including the statement that you have no other tools.`,
    'Use your other tools instead.',
    'The variables and functions that your earlier scripts defined are gone.',
    ...unsettledEvals(messages).map(entry => lostEvalText(entry.evalId)),
    `If this conversation later continues in a session that gives you no tools other than ${REPL_TOOL_NAME} and ${POLL_TOOL_NAME}, Code Mode is on there: disregard this reminder.`,
  ].join('\n- ')
}

function safeInfer(messages: readonly Message[]): boolean | undefined {
  try {
    return inferCodeModeFromMessages(messages)
  } catch {
    return undefined
  }
}

/**
 * What a resume does about Code Mode. A Code Mode session resumed with the
 * gate off continues with the ordinary tools: the model gets the official
 * reminder, the user a warning, and the session records replMode false so
 * it stays out from then on. `replMode` is what restoreSessionMetadata keeps.
 */
export function planCodeModeResume(
  recorded: boolean | undefined,
  messages: readonly Message[],
  codeModeOn: boolean,
): { replMode: boolean | undefined; messages: Message[] } {
  const wasCodeMode = recorded ?? safeInfer(messages) ?? false
  if (!wasCodeMode) return { replMode: recorded, messages: [] }
  if (codeModeOn) return { replMode: true, messages: [] }
  logForDebugging('[CodeMode] resumed a Code Mode session with Code Mode off; continuing with the ordinary tools')
  return {
    replMode: false,
    messages: [
      createUserMessage({ content: wrapInSystemReminder(codeModeOffReminder(messages)), isMeta: true }),
      createSystemMessage(CODE_MODE_TAKEN_OUT_NOTICE, 'warning'),
    ],
  }
}

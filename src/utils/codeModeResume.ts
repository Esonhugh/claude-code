import { CODE_MODE_ONLY_TOOLS, POLL_TOOL_NAME, REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from './debug.js'
import {
  CANCEL_MESSAGE,
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

export const CODE_MODE_TAKEN_OUT_NOTICE =
  "This session was started in Code Mode, which isn't available where it runs now. It continues with the ordinary tools and stays out of Code Mode from now on."

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

/** Official `M()` without the per-eval lines (this build has no async lane). */
export function codeModeOffReminder(): string {
  return [
    'Code Mode is off in this session.',
    `Do not call ${REPL_TOOL_NAME} or ${POLL_TOOL_NAME}. They may still be in your tool list, but every call to them is refused. Disregard their descriptions, including the statement that you have no other tools.`,
    'Use your other tools instead.',
    'The variables and functions that your earlier scripts defined are gone.',
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
      createUserMessage({ content: wrapInSystemReminder(codeModeOffReminder()), isMeta: true }),
      createSystemMessage(CODE_MODE_TAKEN_OUT_NOTICE, 'warning'),
    ],
  }
}

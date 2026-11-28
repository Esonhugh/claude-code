import { SPECIAL_KEYS } from '../../src/utils/pty/types'
import type { Block, Item } from './protocol'
import { stripAnsi } from './tools'

type Tool = Extract<Block, { kind: 'tool' }>
export type TmuxSelection = { sessionId: string; toolUseId: string }

export function isTmuxTool(name: string): boolean {
  return name === 'Tmux' || name === 'Terminal'
}

/** Read the selected call from the current transcript, including any result that arrives later. */
export function selectedTmuxTool(sessionId: string, items: readonly Item[], selection?: TmuxSelection): Tool | undefined {
  if (selection?.sessionId !== sessionId) return undefined
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block?.kind === 'tool' && block.id === selection.toolUseId && isTmuxTool(block.name)) return block
    }
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const string = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // Partial streamed inputs, legacy results and hook errors need not be JSON.
    return undefined
  }
}

/** Only new-session and capture-pane return snapshots. Never use input or live terminal state as output. */
export function tmuxCall(block: Tool) {
  const input = object(parse(block.input))
  const decoded = parse(block.result)
  const result = object(decoded)
  const json = decoded === undefined ? undefined : block.result
  const error = object(result?.error)
  const failed = block.isError === true || error !== undefined
  const action = string(input?.action)
  const target = string(input?.target) ?? string(result?.target) ?? (action === 'new-session'
    ? string(result?.sessionId) ?? string(input?.command)
    : undefined)
  const snapshot = failed ? undefined : action === 'new-session' ? string(result?.preview)
    : action === 'capture-pane' ? string(result?.text) ?? string(result?.preview) : undefined
  const text = string(error?.message) ?? (json === undefined ? block.result : undefined)
  const status = failed ? 'failed' : block.result === undefined ? 'pending'
    : action === 'send-keys' && result?.accepted === true ? 'sent' : 'returned'

  // The write handler sends literal text, then at most one special key, then the optional Enter.
  const inputText = action === 'send-keys' ? string(input?.text) : undefined
  const safeText = inputText && string(stripAnsi(inputText).replace(/(?![\n\t])[\p{Cc}\p{Bidi_Control}]/gu, ''))
  const keys: string[] = []
  if (action === 'send-keys') {
    const key = SPECIAL_KEYS.find(key => key === input?.key)
    if (key) keys.push(key.startsWith('CTRL_') ? `Ctrl+${key.slice(5)}` : key[0] + key.slice(1).toLowerCase())
    if (input?.enter === true) keys.push('Enter')
  }
  const sentInput = safeText || keys.length ? { text: safeText, keys } : undefined
  const firstLine = safeText?.split('\n', 1)[0]?.trim()
  const inputSummary = [firstLine, ...keys].filter(Boolean).join(' · ') || undefined
  return { action, target, status, snapshot: snapshot && string(stripAnsi(snapshot)), text: text && stripAnsi(text), json, sentInput, inputSummary }
}

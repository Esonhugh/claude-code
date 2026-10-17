import type { ModInput } from './types.js'
import type { ToolCallResult } from './toolAdapter.js'

const wellFormed = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
function truncate(text: string, length: number): string {
  if (text.length <= length) return text
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}
function problem(plugin: string, message: string): Error {
  return Object.assign(new Error(`${plugin}: $.ui.ask ${message}`), { name: 'HooksError' })
}

/** Official 2.1.292 projects ui.ask into tool.call, retaining labels for its reply. */
export function createModUiAskRequest(args: unknown[], plugin: string) {
  if (typeof args[0] !== 'string' || args[0].trim() === '') throw problem(plugin, 'takes the question first')
  const options = (Array.isArray(args[1]) ? { options: args[1] } : args[1] ?? {}) as {
    options?: unknown; header?: string; multiSelect?: unknown
  }
  const values = options.options ?? []
  if (!Array.isArray(values) || !Number.isSafeInteger(values.length)) throw problem(plugin, 'takes its options as a list')
  if (values.length > 4) throw problem(plugin, `takes at most 4 options (got ${values.length})`)
  const original = values.map(value => String(value))
  const question = wellFormed(args[0])
  const labels = original.map(wellFormed)
  if (labels.length < 2) labels.push(...['Yes', 'No'].filter(value => !labels.includes(value)).slice(0, 2 - labels.length))
  const input: ModInput = { tool: 'AskUserQuestion', questions: [{
    question, header: truncate(options.header ?? 'Plugin', 12),
    options: labels.map(label => ({ label, description: '' })), multiSelect: options.multiSelect === true,
  }] }
  return {
    input,
    answer(receipt: ToolCallResult): string {
      const value = (receipt.result as { answers?: Record<string, unknown> } | undefined)?.answers?.[question]
      const restore = (label: string) => original.find(value => wellFormed(value) === label) ?? label
      if (typeof value === 'string') return restore(value)
      if (Array.isArray(value)) return value.map(label => restore(String(label))).join(', ')
      throw Object.assign(new Error(`${plugin}: $.ui.ask: no answer (${truncate(receipt.deny ?? receipt.text ?? '', 120) || 'the dialog was dismissed'})`), { name: 'HooksError' })
    },
  }
}

import type { Message } from '../../types/message.js'

type ToolResultSummary = { tool_use_id: string; text: string; isError: boolean; result?: unknown }
type ToolUseSummary = { tool_use_id: string; tool: string; input: unknown; text?: string; isError?: true; result?: unknown }
export type ModSessionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUseSummary[]
  toolResults?: ToolResultSummary[]
}

/** The Mods transcript is data-only and excludes UI rows and hidden user context. */
export function projectModSessionMessages(messages: readonly Message[]): ModSessionMessage[] {
  const projected: ModSessionMessage[] = []
  const results = new Map<string, ToolResultSummary>()
  for (let index = messages.length - 1; index >= 0 && projected.length < 4096; index--) {
    const message = messages[index]!
    if (message.type !== 'user' && message.type !== 'assistant') continue
    if (message.type === 'user' && (message.isMeta || message.isVirtual)) continue
    const content = message.message.content
    const summary: ModSessionMessage = {role:message.type, text:'', toolUses:[]}
    if (typeof content === 'string') summary.text = content
    else for (const block of content) {
      if (block.type === 'text') summary.text += block.text
      else if (block.type === 'tool_use' && message.type === 'assistant') {
        const result = results.get(block.id)
        summary.toolUses.push({
          tool_use_id:block.id, tool:block.name, input:structuredClone(block.input),
          ...(result ? {
            text:result.text,
            ...(result.isError ? {isError:true as const} : {}),
            ...('result' in result ? {result:result.result} : {}),
          } : {}),
        })
      } else if (block.type === 'tool_result' && message.type === 'user') {
        const result: ToolResultSummary = {
          tool_use_id:block.tool_use_id,
          text:typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('') : '',
          isError:block.is_error === true,
          ...(message.toolUseResult === undefined ? {} : {result:structuredClone(message.toolUseResult)}),
        }
        ;(summary.toolResults ??= []).push(result)
        results.set(result.tool_use_id, result)
      }
    }
    projected.push(summary)
  }
  return projected.reverse()
}

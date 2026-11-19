import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { ADVISOR_TOOL_NAME } from '../../utils/advisor.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type Block = { type: string; [key: string]: unknown }

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

function renderResult(content: unknown): string {
  return blocksOf(content)
    .map(block => (block.type === 'text' ? String(block.text) : `[${block.type}]`))
    .join('\n')
}

/**
 * The conversation as text for the advisor model: requests, replies, tool
 * calls and tool results in order. Text survives any endpoint, where replayed
 * tool_use and thinking blocks of another model may not. Thinking is left
 * out, and so is the advisor call that is being answered.
 */
export function renderAdvisorTranscript(
  messages: readonly (UserMessage | AssistantMessage)[],
): string {
  const toolNames = new Map<string, string>()
  const answered = new Set<string>()
  for (const message of messages) {
    for (const block of blocksOf(message.message.content)) {
      if (block.type === 'tool_use') toolNames.set(String(block.id), String(block.name))
      else if (block.type === 'tool_result') answered.add(String(block.tool_use_id))
    }
  }

  const parts: { tag: string; lines: string[] }[] = []
  // Consecutive lines of one role share an element: a streamed reply arrives
  // as one message per content block.
  const say = (role: string, line: string) => {
    const last = parts.at(-1)
    if (last?.tag === role) last.lines.push(line)
    else parts.push({ tag: role, lines: [line] })
  }
  for (const message of messages) {
    for (const block of blocksOf(message.message.content)) {
      switch (block.type) {
        case 'text':
          if (String(block.text).trim()) say(message.type, String(block.text))
          break
        case 'thinking':
        case 'redacted_thinking':
          break
        case 'tool_use':
          if (block.name === ADVISOR_TOOL_NAME && !answered.has(String(block.id))) break
          say(
            message.type,
            `<tool_call name="${String(block.name)}">${jsonStringify(block.input)}</tool_call>`,
          )
          break
        case 'tool_result': {
          const name = toolNames.get(String(block.tool_use_id)) ?? 'unknown'
          parts.push({
            tag: `tool_result name="${name}"${block.is_error ? ' error="true"' : ''}`,
            lines: [renderResult(block.content)],
          })
          break
        }
        default:
          say(message.type, `[${block.type}]`)
      }
    }
  }
  return parts
    .map(({ tag, lines }) => `<${tag}>\n${lines.join('\n')}\n</${tag.split(' ')[0]}>`)
    .join('\n')
}

/** Cuts the middle out of a transcript over `maxChars`, keeping the start (the task) and the latest part. */
export function fitAdvisorTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript
  const head = Math.floor(maxChars / 5)
  const tail = maxChars - head
  return `${transcript.slice(0, head)}\n[${transcript.length - maxChars} characters of the transcript left out to fit the advisor model]\n${transcript.slice(transcript.length - tail)}`
}

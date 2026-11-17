import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { POLL_TOOL_NAME } from '../REPLTool/constants.js'

/** Official `pA`, `Lnr` and `uh`: the tools-used tag, the names it shows as is, and the stand-in for others. */
export const TOOLS_USED_TAG = 'tools-used-before-summary'
const READABLE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,256}$/
export const UNREADABLE_TOOL_NAME = 'unreadable-tools-used-before-summary'

/** Official `de` and `pe`: a tools-used line, and the nonce manifest a Poll result may open with. */
const TOOLS_USED_LINE = new RegExp(`^[ \\t]*<${TOOLS_USED_TAG}>([^<\\n]*)</${TOOLS_USED_TAG}>[ \\t]*$`, 'gm')
const NONCE_MANIFEST = /^<system>authentic event nonces[^\n]*<\/system>\n/

/** Official `hx`. */
export function readableToolName(name: string): string {
  return READABLE_TOOL_NAME.test(name) ? name : UNREADABLE_TOOL_NAME
}

/**
 * Official `Er()` names (the conversation's tools-used latch, chunk-m8nhymg4.js
 * class `_`): every tool the conversation ran, a script's inner calls included,
 * in the order first used. Process-wide like official's conversation latches.
 */
const used = new Set<string>()

/** Official `record`, as `oca` calls it for each tool call that found its tool. */
export function recordToolsUsed(names: readonly string[]): void {
  for (const name of names) if (typeof name === 'string' && name !== '') used.add(readableToolName(name))
}

export function toolsUsedNames(): string[] {
  return [...used]
}

export function resetToolsUsedForTesting(): void {
  used.clear()
}

/** Official `_`: the names of one tools-used line. */
function addLineNames(shown: Set<string>, line: string): void {
  for (const part of line.split(',')) {
    const name = part.replace(/^ +| +$/g, '')
    if (name !== '') shown.add(readableToolName(name))
  }
}

/** Official `N(text, undefined, "manifest")`: the tools-used line right after a Poll result's nonce manifest. */
function manifestNames(shown: Set<string>, text: string): void {
  const at = NONCE_MANIFEST.exec(text)?.[0].length ?? 0
  for (const match of text.matchAll(TOOLS_USED_LINE)) if (match.index === at) addLineNames(shown, match[1]!)
}

/**
 * Official `xO` as `yNt` calls it: the tool names the messages already show
 * the model, from their tool calls and the tools-used lines of earlier
 * deliveries (a `poll_events` attachment's, a Poll result's).
 */
function namesShown(messages: readonly Message[]): Set<string> {
  const shown = new Set<string>()
  const polls = new Set<string>()
  for (const message of messages) {
    if (message.type === 'attachment') {
      if (message.attachment.type === 'poll_events') addLineNames(shown, (message.attachment.toolsUsed ?? []).join(','))
      continue
    }
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = message.message.content
    if (typeof content === 'string') continue
    for (const block of content) {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const name = typeof block.name === 'string' ? block.name.trim() : ''
        if (name === '') continue
        shown.add(readableToolName(name))
        if (block.type === 'tool_use' && name === POLL_TOOL_NAME) polls.add(block.id)
      } else if (message.type === 'user' && block.type === 'tool_result' && polls.has(block.tool_use_id)) {
        const texts =
          typeof block.content === 'string'
            ? [block.content]
            : Array.isArray(block.content)
              ? block.content.flatMap(part => (part.type === 'text' ? [part.text] : []))
              : []
        for (const text of texts) manifestNames(shown, text)
      }
    }
  }
  return shown
}

/**
 * Official `Itn`/`yNt` (2.1.325 chunk-wqb2b4v0.js): the tools the conversation
 * used that the messages do not show the model yet, sorted, for a delivery's
 * tools-used line. The events' own names (taken when they were queued) join
 * the latch first.
 */
export function toolsUsedForDelivery(commands: readonly QueuedCommand[], messages: readonly Message[]): string[] {
  recordToolsUsed(commands.flatMap(cmd => cmd.pollEvent?.toolsUsed ?? []))
  if (used.size === 0) return []
  const shown = namesShown(messages.filter(message => !((message.type === 'user' || message.type === 'assistant') && message.isVirtual === true)))
  return [...used].filter(name => name === UNREADABLE_TOOL_NAME || !shown.has(name)).sort()
}

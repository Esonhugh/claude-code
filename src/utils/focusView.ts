import type { UUID } from 'crypto'
import type {
  CollapsedReadSearchGroup,
  RenderableMessage,
  SystemFocusSummaryMessage,
} from '../types/message.js'
import { getGlobalConfig } from './config.js'
import { isHumanTurn } from './messagePredicates.js'
import { getInitialSettings } from './settings/settings.js'
import { plural } from './stringUtils.js'

export const FOCUS_NEEDS_FULLSCREEN_MESSAGE =
  'Focus view needs the fullscreen renderer. Run /tui fullscreen to switch (this restarts and resumes your session), or set CLAUDE_CODE_NO_FLICKER=1 and restart.'

/** `viewMode` in settings wins over the /focus toggle saved in global config. */
export function isFocusViewConfigured(): boolean {
  const viewMode = getInitialSettings().viewMode
  return viewMode ? viewMode === 'focus' : (getGlobalConfig().briefTranscript ?? false)
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Counts = {
  edits: number
  searches: number
  reads: number
  lists: number
  commands: number
  repls: number
  mcpCalls: number
  agents: number
  tools: number
}

function addToolUse(counts: Counts, toolName: string, n = 1): void {
  if (EDIT_TOOLS.has(toolName)) counts.edits += n
  else if (toolName === 'Bash' || toolName === 'PowerShell') counts.commands += n
  else if (toolName === 'Agent' || toolName === 'Task') counts.agents += n
  else counts.tools += n
}

function addRow(counts: Counts, msg: RenderableMessage): void {
  if (msg.type === 'collapsed_read_search') {
    const group = msg as CollapsedReadSearchGroup
    counts.searches += (group.searchCount ?? 0) + (group.memorySearchCount ?? 0)
    counts.reads += (group.readCount ?? 0) + (group.memoryReadCount ?? 0)
    counts.lists += group.listCount ?? 0
    counts.commands += group.bashCount ?? 0
    counts.repls += group.replCount ?? 0
    counts.mcpCalls += group.mcpCallCount ?? 0
    counts.edits += group.memoryWriteCount ?? 0
    return
  }
  if (msg.type === 'grouped_tool_use') {
    addToolUse(counts, msg.toolName, msg.messages.length)
    return
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') addToolUse(counts, block.name)
    }
  }
}

function phrase(
  count: number,
  active: boolean,
  [doing, did]: [string, string],
  noun: string,
  nouns?: string,
): string | null {
  if (count === 0) return null
  return `${active ? doing : did} ${count} ${plural(count, noun, nouns)}`
}

export function getFocusSummaryText(counts: Counts, active: boolean): string {
  const parts = [
    phrase(counts.edits, active, ['editing', 'edited'], 'file'),
    phrase(counts.searches, active, ['searching for', 'searched for'], 'pattern'),
    phrase(counts.reads, active, ['reading', 'read'], 'file'),
    phrase(counts.lists, active, ['listing', 'listed'], 'directory', 'directories'),
    phrase(counts.commands, active, ['running', 'ran'], 'shell command'),
    phrase(counts.repls, active, ['running', 'ran'], 'REPL cell'),
    phrase(counts.mcpCalls, active, ['calling', 'called'], 'MCP tool'),
    phrase(counts.agents, active, ['running', 'ran'], 'agent'),
    phrase(counts.tools, active, ['using', 'used'], 'tool'),
  ].filter((p): p is string => p !== null)
  if (parts.length === 0) return active ? 'Working…' : ''
  const text = parts.join(', ')
  return `${text[0]!.toUpperCase()}${text.slice(1)}${active ? '…' : ''}`
}

function isAssistantText(msg: RenderableMessage): boolean {
  return (
    msg.type === 'assistant' &&
    msg.message.content.some(block => block.type === 'text')
  )
}

/** Rows that belong to the agent's work inside a turn (hidden in focus view). */
function isWorkRow(msg: RenderableMessage): boolean {
  switch (msg.type) {
    case 'assistant':
    case 'grouped_tool_use':
    case 'collapsed_read_search':
    case 'attachment':
      return true
    case 'user':
      return !isHumanTurn(msg)
    default:
      return false
  }
}

function createSummaryRow(
  content: string,
  uuid: UUID,
  timestamp: string,
): SystemFocusSummaryMessage {
  return {
    type: 'system',
    subtype: 'focus_summary',
    content,
    uuid,
    timestamp,
  }
}

/**
 * Focus view: each turn shows the prompt, one summary line for the tool
 * work, and the final response. The turn-duration line reports how many rows
 * were hidden.
 */
export function applyFocusView(
  messages: RenderableMessage[],
  isLoading: boolean,
): RenderableMessage[] {
  const out: RenderableMessage[] = []
  let i = 0
  while (i < messages.length) {
    if (!isWorkRow(messages[i]!)) {
      out.push(messages[i]!)
      i++
      continue
    }
    const start = i
    while (i < messages.length && isWorkRow(messages[i]!)) i++
    const run = messages.slice(start, i)
    const atEnd = i === messages.length
    const active = isLoading && atEnd

    // The response is the last assistant text, unless the agent kept working.
    let responseIndex = -1
    for (let j = run.length - 1; j >= 0; j--) {
      if (isAssistantText(run[j]!)) {
        responseIndex = j
        break
      }
    }
    const trailingWork = run
      .slice(responseIndex + 1)
      .some(m => m.type !== 'user' && m.type !== 'attachment')
    if (active && trailingWork) responseIndex = -1

    const counts: Counts = {
      edits: 0,
      searches: 0,
      reads: 0,
      lists: 0,
      commands: 0,
      repls: 0,
      mcpCalls: 0,
      agents: 0,
      tools: 0,
    }
    const work = run.filter(
      (msg, j) => j !== responseIndex && msg.type !== 'user' && msg.type !== 'attachment',
    )
    // A lone read/search group already is a one-line summary.
    const lone = work.length === 1 && work[0]!.type === 'collapsed_read_search'
    const hidden = lone ? 0 : work.length
    work.forEach(msg => addRow(counts, msg))

    const summary = getFocusSummaryText(counts, active)
    if (lone) {
      out.push(work[0]!)
    } else if (summary) {
      // Message rows memo on uuid, so the uuid must change with the text.
      out.push(createSummaryRow(summary, `${run[0]!.uuid}-focus-${summary}` as UUID, run[0]!.timestamp))
    }
    if (responseIndex >= 0) out.push(run[responseIndex]!)

    const next = messages[i]
    if (
      hidden > 0 &&
      next?.type === 'system' &&
      next.subtype === 'turn_duration'
    ) {
      out.push({ ...next, uuid: `${next.uuid}-focus` as UUID, focusHiddenCount: hidden })
      i++
    }
  }
  return out
}

export function focusHiddenSuffix(count: number | undefined): string {
  if (!count) return ''
  return ` · ${count} ${plural(count, 'message')} hidden (/focus to show)`
}


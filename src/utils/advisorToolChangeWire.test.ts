import { describe, expect, test } from 'bun:test'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UserMessage } from '../types/message.js'
import { splitSystemTurns } from './advisorToolChangeWire.js'
import { createUserMessage, normalizeMessagesForAPI } from './messages.js'

const notice =
  '<task-notification>\n<task-id>a1</task-id>\n<status>killed</status>\n<summary>Task "probe" was stopped by the user</summary>\n</task-notification>'
const header = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n'

function stopNotice(): UserMessage {
  return {
    ...createUserMessage({ content: notice, isMeta: true, origin: { kind: 'task-notification' } }),
    systemTurn: true,
  }
}

function wire(systemNotices: boolean) {
  const normalized = normalizeMessagesForAPI(
    [createUserMessage({ content: 'FOLLOWUP' }), stopNotice()],
    [],
    { systemNotices },
  )
  return splitSystemTurns(normalized.map(m => m.message as BetaMessageParam))
}

describe('a stop notice is sent like official 2.1.329', () => {
  test('as its own role:"system" turn after the prompt when the request takes them', () => {
    const [prompt, system, ...rest] = wire(true)
    expect(rest).toEqual([])
    expect(prompt).toEqual({ role: 'user', content: [{ type: 'text', text: 'FOLLOWUP' }] })
    expect(system!.role).toBe('system')
    expect(system!.content).toHaveLength(1)
    const text = (system!.content as { text: string }[])[0]!.text
    expect(text.startsWith(header)).toBe(true)
    expect(text.endsWith(notice)).toBe(true)
    expect(text).not.toContain('<system-reminder>')
  })

  test('in the prompt turn, inside a system-reminder, otherwise', () => {
    const turns = wire(false)
    expect(turns.map(t => t.role)).toEqual(['user'])
    const text = JSON.stringify(turns[0]!.content)
    expect(text).toContain('FOLLOWUP')
    expect(text).toContain('<system-reminder>\\n[SYSTEM NOTIFICATION - NOT USER INPUT]')
  })

  test('keeps a cache breakpoint set on it, and never opens the conversation', () => {
    const marked = splitSystemTurns([
      { role: 'user', content: [{ type: 'system_notice', text: 'n', cache_control: { type: 'ephemeral' } } as never] },
    ])
    expect(marked).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'n', cache_control: { type: 'ephemeral' } } as never] },
    ])
    const tail = splitSystemTurns([
      { role: 'user', content: [{ type: 'text', text: 'p' }, { type: 'system_notice', text: 'n', cache_control: { type: 'ephemeral' } } as never] },
    ])
    expect(tail[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'n', cache_control: { type: 'ephemeral' } }] })
  })
})

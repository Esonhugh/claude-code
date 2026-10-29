import { afterEach, expect, test } from 'bun:test'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { collapseReadSearchGroups } from './collapseReadSearch.js'
import { createAssistantMessage, createUserMessage } from './messages.js'

const tools = [BashTool] as never
const originalNoFlicker = process.env.CLAUDE_CODE_NO_FLICKER
process.env.CLAUDE_CODE_NO_FLICKER = '0'
afterEach(() => {
  process.env.CLAUDE_CODE_NO_FLICKER = '0'
})
process.on('exit', () => {
  if (originalNoFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = originalNoFlicker
})

function bash(id: string, command: string) {
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] as never }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] as never }),
  ]
}

const text = (t: string) => createAssistantMessage({ content: t })

function rows(messages: ReturnType<typeof bash>) {
  return collapseReadSearchGroups(messages as never, tools).map(m =>
    m.type === 'collapsed_read_search' ? `group:${m.bashCount ?? 0}` : m.type,
  )
}

test('a single plain Bash command stays expanded outside fullscreen', () => {
  expect(rows([...bash('b1', 'sleep 5'), text('done') as never])).toEqual(['assistant', 'user', 'assistant'])
})

test('consecutive plain Bash commands collapse outside fullscreen', () => {
  expect(rows([...bash('b1', 'sleep 5'), ...bash('b2', 'make build'), text('done') as never])).toEqual([
    'group:2',
    'assistant',
  ])
})

test('a lone Bash next to reads splits the group instead of joining it', () => {
  expect(rows([...bash('r1', 'cat a.txt'), ...bash('b1', 'sleep 5'), ...bash('r2', 'cat b.txt')])).toEqual([
    'group:0',
    'assistant',
    'user',
    'group:0',
  ])
})

test('fullscreen still collapses a single Bash command', () => {
  process.env.CLAUDE_CODE_NO_FLICKER = '1'
  expect(rows(bash('b1', 'sleep 5'))).toEqual(['group:1'])
})

import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { toolDenialsIn } = await import('./QueryEngine.js')
const { createAssistantMessage, createUserMessage } = await import('./utils/messages.js')

const block = { type: 'tool_use' as const, id: 't1', name: 'Bash', input: { command: 'echo DENYME' } }
const assistant = createAssistantMessage({ content: [block] })
const denied = (toolDenialKind?: 'permission-rule' | 'cancelled') =>
  createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'PreToolUse:Bash hook error: no deny', is_error: true }],
    toolDenialKind,
  })

// Like 2.1.311, permission_denials also lists calls a hook refused, which
// never reach canUseTool.
test('a refused tool result is a permission denial', () => {
  expect(toolDenialsIn(denied('permission-rule'), [assistant], new Set())).toEqual([
    { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo DENYME' } },
  ])
})

test('aborts and already recorded denials are not repeated', () => {
  expect(toolDenialsIn(denied('cancelled'), [assistant], new Set())).toEqual([])
  expect(toolDenialsIn(denied(), [assistant], new Set())).toEqual([])
  expect(toolDenialsIn(denied('permission-rule'), [assistant], new Set(['t1']))).toEqual([])
})

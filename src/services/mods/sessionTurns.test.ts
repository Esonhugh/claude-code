import { expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { countModSessionTurns } from './sessionTurns.js'

test('session turns count only real human prompts', () => {
  const toolResult = [{ type: 'tool_result' as const, tool_use_id: 'call', content: 'done' }]
  expect(countModSessionTurns([
    createUserMessage({ content: 'first prompt' }),
    createUserMessage({ content: [{ type: 'text', text: 'second prompt' }] }),
    createUserMessage({ content: 'attachment context', isMeta: true }),
    createUserMessage({ content: 'virtual prompt', isVirtual: true }),
    createAssistantMessage({ content: 'answer' }),
    createUserMessage({ content: toolResult, toolUseResult: { stdout: 'done' } }),
    // Interrupted or resumed tool results can lack toolUseResult.
    createUserMessage({ content: toolResult }),
  ])).toBe(2)
})

test('every host counts session turns with the shared definition', async () => {
  for (const host of ['../../QueryEngine.ts', '../../cli/print.ts', '../../screens/REPL.tsx']) {
    const source = await Bun.file(new URL(host, import.meta.url)).text()
    expect(source).toMatch(/turns: \(\) => countModSessionTurns\(/)
  }
})

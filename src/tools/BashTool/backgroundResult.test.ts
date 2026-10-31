import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { BashTool } = await import('./BashTool.js')
const { PowerShellTool } = await import('../PowerShellTool/PowerShellTool.js')

// Like 2.1.311 the result says a notification follows, so the model does not poll.
test.each([['Bash', BashTool], ['PowerShell', PowerShellTool]] as const)('%s background result says it will notify', (_name, tool) => {
  const block = tool.mapToolResultToToolResultBlockParam(
    { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } as never,
    'toolu_1',
  )
  expect(String(block.content)).toEndWith(
    '. You will be notified when it completes. To check interim output, use Read on that file path.',
  )
})

test('a command moved to the background by its timeout says so', () => {
  const block = BashTool.mapToolResultToToolResultBlockParam(
    { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2', timedOutAfterMs: 1000 } as never,
    'toolu_2',
  )
  expect(String(block.content)).toStartWith('Command did not complete within its 1s timeout and was moved to the background (ID: b2). Output is being written to: ')
})

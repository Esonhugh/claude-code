import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'

process.env.FORCE_COLOR = '1'
const { render } = await import('../../ink.js')
const { PromptInputFooterSuggestions } = await import('./PromptInputFooterSuggestions.js')

// Official 2.1.311 bolds the typed query in the name (fuzzy) and the
// description (contiguous only).
test('the typed query is highlighted in the name and description', async () => {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <PromptInputFooterSuggestions
      suggestions={[{ id: 'cmd-a', displayText: '/cmdren', description: 'Set the renderer', query: 'ren' }]}
      selectedSuggestion={0}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(output.split('\u001b[1mren')).toHaveLength(3)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})

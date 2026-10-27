import { expect, test } from 'bun:test'
import figures from 'figures'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { render } from '../../ink.js'
import { PromptInputFooterSuggestions, type SuggestionItem } from './PromptInputFooterSuggestions.js'

const commands: SuggestionItem[] = Array.from({ length: 30 }, (_, i) => ({
  id: `cmd-${i}`,
  displayText: `/cmd${String(i).padStart(2, '0')}`,
  description: `command number ${i}`,
}))

async function renderMenu(rows: number, items: SuggestionItem[], selected = 0) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(
    <PromptInputFooterSuggestions suggestions={items} selectedSuggestion={selected} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    return stripAnsi(output).split('\n').filter(line => line.includes('/cmd'))
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

test('inline menu shows half the terminal height, at least 6 rows', async () => {
  expect(await renderMenu(30, commands)).toHaveLength(15)
  expect(await renderMenu(40, commands)).toHaveLength(20)
  expect(await renderMenu(10, commands)).toHaveLength(6)
  expect(await renderMenu(8, commands)).toHaveLength(5)
})

test('selected row carries the pointer and the others keep the gutter', async () => {
  const lines = await renderMenu(30, commands, 1)
  expect(lines[0]).toMatch(/^ {2}\/cmd00/)
  expect(lines[1]).toStartWith(`${figures.pointer} /cmd01`)
  expect(lines[2]).toMatch(/^ {2}\/cmd02/)
})

test('file rows get the same pointer gutter', async () => {
  const files: SuggestionItem[] = [
    { id: 'file-a', displayText: 'src/alpha.ts' },
    { id: 'file-b', displayText: 'src/beta.ts' },
  ]
  const stdout = await renderMenu(30, files.map(f => ({ ...f, displayText: `/cmd ${f.displayText}` })), 0)
  expect(stdout[0]).toStartWith(`${figures.pointer} + /cmd src/alpha.ts`)
  expect(stdout[1]).toMatch(/^ {2}\+ \/cmd src\/beta\.ts/)
})

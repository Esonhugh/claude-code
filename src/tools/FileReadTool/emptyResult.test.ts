import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { FileReadTool } = await import('./FileReadTool.js')

const EMPTY = '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
const result = (file: { content: string; numLines: number; startLine: number; totalLines: number }) =>
  FileReadTool.mapToolResultToToolResultBlockParam({ type: 'text', file: { filePath: '/a', ...file } }, 't').content

// Like 2.1.311: an empty file reads as one empty line, and a blank line is
// still a line, not an offset past the end.
test('an empty file is reported as empty', () => {
  expect(result({ content: '', numLines: 1, startLine: 1, totalLines: 1 })).toBe(EMPTY)
  expect(result({ content: '', numLines: 0, startLine: 1, totalLines: 0 })).toBe(EMPTY)
})

test('a blank line inside a longer file is shown with its number', () => {
  expect(result({ content: '', numLines: 1, startLine: 2, totalLines: 4 })).toBe('2\t')
})

test('an offset past the end still says so', () => {
  expect(result({ content: '', numLines: 0, startLine: 3, totalLines: 2 })).toBe(
    '<system-reminder>Warning: the file exists but is shorter than the provided offset (3). The file has 2 lines.</system-reminder>',
  )
})

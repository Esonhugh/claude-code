import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../../tools/FileEditTool/FileEditTool.js')
const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
const { BashTool } = await import('../../tools/BashTool/BashTool.js')

// Like 2.1.311, common wrong shapes are repaired before schema validation.
type Coerced = { input: Record<string, unknown>; resultNote?: string } | null
const repaired = (tool: { coerceInput?: (input: unknown) => Coerced; inputSchema: { safeParse: (input: unknown) => { success: boolean } } }, input: Record<string, unknown>) => {
  const next = tool.coerceInput!(input)
  expect(tool.inputSchema.safeParse(input).success).toBe(false)
  expect(next).not.toBeNull()
  expect(tool.inputSchema.safeParse(next!.input).success).toBe(true)
  return next!.input
}

test('Read drops values that mean a plain read', () => {
  expect(repaired(FileReadTool, { file_path: '/a', limit: 0 })).toEqual({ file_path: '/a' })
  expect(repaired(FileReadTool, { file_path: '/a', offset: -1, limit: [5] })).toEqual({ file_path: '/a', limit: 5 })
  expect(FileReadTool.coerceInput!({ file_path: '/a', length: 10, description: 'x' })).toEqual({ input: { file_path: '/a', limit: 10 } })
  expect(FileReadTool.coerceInput!({ file_path: '/a', offset: 3 })).toBeNull()
})

test('Edit and Write accept str_replace_editor names', () => {
  expect(repaired(FileEditTool, { path: '/a', old_str: 'x', new_str: 'y', replace_name: 'true' }))
    .toEqual({ file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true })
  expect(repaired(FileWriteTool, { path: '/a', file_text: 'x', command: 'create' })).toEqual({ file_path: '/a', content: 'x' })
  expect(FileWriteTool.coerceInput!({ file_path: '/a', content: 'x' })).toBeNull()
})

test('Write and Grep explain the repair in the tool result like 2.1.311', async () => {
  expect(FileWriteTool.coerceInput!({ path: '/a', file_text: 'x', description: 'd', command: 'create' })?.resultNote).toBe(
    "Note: Write's parameters are named `file_path` and `content`. `path` was read as `file_path`. `file_text` was read as `content`. `description` was ignored. `command` was ignored.",
  )
  expect(FileWriteTool.coerceInput!({ file_path: '/a', content: 'x', file: '/a', text: 'x' })).toEqual({
    input: { file_path: '/a', content: 'x' },
    resultNote: "Note: Write's parameters are named `file_path` and `content`. `file` repeated `file_path` and was ignored. `text` repeated `content` and was ignored.",
  })
  const { GrepTool } = await import('../../tools/GrepTool/GrepTool.js')
  expect(GrepTool.coerceInput!({ pattern: 'x', file_path: '/a', '-l': true, '-r': true })?.resultNote).toBe(
    "Note: Grep's parameter for where to search is named `path`. `file_path` was read as `path`. `-l` is not a Grep parameter and was read as `output_mode: \"files_with_matches\"`. `-r` was ignored: Grep always searches a directory recursively.",
  )
  expect(GrepTool.coerceInput!({ pattern: 'x', path: '/a', file_path: '/a', output_mode: 'count', '-c': true })?.resultNote).toBe(
    "Note: Grep's parameter for where to search is named `path`. `file_path` repeated `path` and was ignored. `-c` repeated `output_mode` and was ignored.",
  )
})

test('Bash accepts timeout_ms and command_description', () => {
  expect(BashTool.coerceInput!({ command: 'ls', timeout_ms: 5000, command_description: 'list' }))
    .toEqual({ input: { command: 'ls', timeout: 5000, description: 'list' } })
  expect(BashTool.coerceInput!({ command: 'ls' })).toBeNull()
})

test('Grep reads file_path and rg flags as its own parameters', async () => {
  const { GrepTool } = await import('../../tools/GrepTool/GrepTool.js')
  expect(repaired(GrepTool, { pattern: 'x', file_path: '/a', '-l': true, '-r': true }))
    .toEqual({ pattern: 'x', path: '/a', output_mode: 'files_with_matches' })
  expect(GrepTool.coerceInput!({ pattern: 'x', '-c': 'true' })?.input).toEqual({ pattern: 'x', output_mode: 'count' })
  expect(GrepTool.coerceInput!({ pattern: 'x', path: '/a' })).toBeNull()
})

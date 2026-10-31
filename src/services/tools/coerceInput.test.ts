import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../../tools/FileEditTool/FileEditTool.js')
const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
const { BashTool } = await import('../../tools/BashTool/BashTool.js')

// Like 2.1.311, common wrong shapes are repaired before schema validation.
const repaired = (tool: { coerceInput?: (input: unknown) => Record<string, unknown> | null; inputSchema: { safeParse: (input: unknown) => { success: boolean } } }, input: Record<string, unknown>) => {
  const next = tool.coerceInput!(input)
  expect(tool.inputSchema.safeParse(input).success).toBe(false)
  expect(next).not.toBeNull()
  expect(tool.inputSchema.safeParse(next).success).toBe(true)
  return next
}

test('Read drops values that mean a plain read', () => {
  expect(repaired(FileReadTool, { file_path: '/a', limit: 0 })).toEqual({ file_path: '/a' })
  expect(repaired(FileReadTool, { file_path: '/a', offset: -1, limit: [5] })).toEqual({ file_path: '/a', limit: 5 })
  expect(FileReadTool.coerceInput!({ file_path: '/a', length: 10, description: 'x' })).toEqual({ file_path: '/a', limit: 10 })
  expect(FileReadTool.coerceInput!({ file_path: '/a', offset: 3 })).toBeNull()
})

test('Edit and Write accept str_replace_editor names', () => {
  expect(repaired(FileEditTool, { path: '/a', old_str: 'x', new_str: 'y', replace_name: 'true' }))
    .toEqual({ file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true })
  expect(repaired(FileWriteTool, { path: '/a', file_text: 'x', command: 'create' })).toEqual({ file_path: '/a', content: 'x' })
  expect(FileWriteTool.coerceInput!({ file_path: '/a', content: 'x' })).toBeNull()
})

test('Bash accepts timeout_ms and command_description', () => {
  expect(BashTool.coerceInput!({ command: 'ls', timeout_ms: 5000, command_description: 'list' }))
    .toEqual({ command: 'ls', timeout: 5000, description: 'list' })
  expect(BashTool.coerceInput!({ command: 'ls' })).toBeNull()
})

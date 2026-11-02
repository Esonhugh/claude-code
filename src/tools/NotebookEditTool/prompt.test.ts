import { expect, test } from 'bun:test'
import { PROMPT } from './prompt.js'
import { NotebookEditTool } from './NotebookEditTool.js'

test('NotebookEdit prompt only names parameters the schema has', () => {
  const props = Object.keys(
    (NotebookEditTool.inputSchema.toJSONSchema() as { properties: object }).properties,
  )
  expect(props).not.toContain('cell_number')
  expect(PROMPT).not.toContain('cell_number')
  for (const rule of ['`cell_id`', '<cell id="...">', '"insert"', '`cell_type` is required', 'Read the notebook first'])
    expect(PROMPT).toContain(rule)
})

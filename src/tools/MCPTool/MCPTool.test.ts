import { expect, test } from 'bun:test'
import { MCPTool } from './MCPTool.js'

test('maps a hook-replaced MCP object to JSON text', () => {
  const replaced = { content: [{ type: 'text', text: 'OBJ' }], structuredContent: { a: 1 } }
  const block = MCPTool.mapToolResultToToolResultBlockParam(replaced as never, 'call-1')
  expect(block.content).toBe(JSON.stringify(replaced))
  expect(MCPTool.isResultTruncated(replaced as never)).toBe(false)
})

test('keeps string and content-block MCP output as is', () => {
  const blocks = [{ type: 'text' as const, text: 'ARR' }]
  expect(MCPTool.mapToolResultToToolResultBlockParam(blocks, 'call-1').content).toBe(blocks)
  expect(MCPTool.mapToolResultToToolResultBlockParam('STR', 'call-1').content).toBe('STR')
})

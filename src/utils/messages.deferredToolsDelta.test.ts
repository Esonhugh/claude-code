import { expect, test } from 'bun:test'

const { normalizeAttachmentForAPI } = await import('./messages.js')

test('a removed deferred tool is not blamed on an MCP disconnect', () => {
  // A resumed agent loses tools its new run does not allow (e.g. CronCreate),
  // with no MCP server involved.
  const [message] = normalizeAttachmentForAPI({
    type: 'deferred_tools_delta',
    addedNames: [],
    addedLines: [],
    removedNames: ['CronCreate'],
  })
  const content = JSON.stringify(message?.message.content)
  expect(content).toContain('no longer available')
  expect(content).toContain('CronCreate')
  expect(content).not.toContain('MCP')
})

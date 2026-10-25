import { expect, test } from 'bun:test'
import { parseMcpConfig } from './mcp/config.js'
import { settingsErrorsBlockMcpApproval } from './mcpServerApproval.js'

test('a skipped .mcp.json entry does not block approving the valid servers', () => {
  const { errors } = parseMcpConfig({
    configObject: { mcpServers: { good: { command: 'echo' }, bad: { type: 'weird', url: 'https://x' } } },
    expandVars: false,
    scope: 'project',
  })
  expect(errors).toHaveLength(1)
  expect(settingsErrorsBlockMcpApproval(errors)).toBe(false)
})

test('a file that fails the schema, or any settings error, still blocks approval', () => {
  const { errors } = parseMcpConfig({ configObject: { mcpServers: 3 }, expandVars: false, scope: 'project' })
  expect(settingsErrorsBlockMcpApproval(errors)).toBe(true)
  expect(settingsErrorsBlockMcpApproval([{ path: 'permissions', message: 'bad' }])).toBe(true)
  expect(settingsErrorsBlockMcpApproval([])).toBe(false)
})

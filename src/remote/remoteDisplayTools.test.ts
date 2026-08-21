import { describe, expect, test } from 'bun:test'
import {
  createRemoteDisplayTool,
  findRemoteDisplayTool,
} from './remoteDisplayTools.js'

describe('remote display tools', () => {
  test('uses the Bash renderer without registering an execution catalog', () => {
    const tool = findRemoteDisplayTool([], 'Bash')

    expect(tool.name).toBe('Bash')
    expect(tool.inputSchema.safeParse({ command: 'pwd' }).success).toBe(true)
  })

  test('creates a permissive non-executable fallback for unknown tools', async () => {
    const tool = createRemoteDisplayTool('mcp__remote__unknown')

    expect(tool.inputSchema.safeParse({ query: 'value' }).success).toBe(true)
    expect(tool.isEnabled()).toBe(false)
    await expect(
      tool.call(
        { query: 'value' },
        {} as never,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow('cannot be executed locally')
  })
})

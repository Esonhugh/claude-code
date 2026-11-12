import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Tool } from '../../Tool.js'

// GPT models get apply_patch instead of Edit/Write, so the background agents
// that only allow Edit/Write on certain paths must accept it on those paths.

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { getAutoMemPath } = await import('../../memdir/paths.js')
const { createAutoMemCanUseTool } = await import('../../services/extractMemories/extractMemories.js')
const { createMemoryFileCanUseTool } = await import('../../services/SessionMemory/sessionMemory.js')
const { isToolDisallowedForAgent } = await import('../AgentTool/agentToolUtils.js')
const { ApplyPatchTool } = await import('./ApplyPatchTool.js')

const tool = ApplyPatchTool as Tool
const patch = (...paths: string[]) => ({
  input: `*** Begin Patch\n${paths.map(p => `*** Add File: ${p}\n+x`).join('\n')}\n*** End Patch`,
})

test('memory extraction allows apply_patch only inside the memory directory', async () => {
  const memDir = getAutoMemPath()
  const canUseTool = createAutoMemCanUseTool(memDir)
  const decide = async (input: Record<string, unknown>) => (await canUseTool(tool, input, undefined as never, undefined as never, 't')).behavior
  expect(await decide(patch(join(memDir, 'a.md'), join(memDir, 'b.md')))).toBe('allow')
  expect(await decide(patch(join(memDir, 'a.md'), '/tmp/elsewhere.md'))).toBe('deny')
  expect(await decide(patch(join(memDir, '../escape.md')))).toBe('deny')
  expect(await decide({ input: 'not a patch' })).toBe('deny')
})

test('session memory allows apply_patch only on its one file', async () => {
  const canUseTool = createMemoryFileCanUseTool('/tmp/session/summary.md')
  const decide = async (input: Record<string, unknown>) => (await canUseTool(tool, input, undefined as never, undefined as never, 't')).behavior
  expect(await decide(patch('/tmp/session/summary.md'))).toBe('allow')
  expect(await decide(patch('/tmp/session/summary.md', '/tmp/session/other.md'))).toBe('deny')
})

test('an agent that may not use Edit or Write may not use apply_patch', () => {
  expect(isToolDisallowedForAgent(['Edit'])(tool)).toBe(true)
  expect(isToolDisallowedForAgent(['Write'])(tool)).toBe(true)
  expect(isToolDisallowedForAgent(['Bash'])(tool)).toBe(false)
  expect(isToolDisallowedForAgent(undefined)(tool)).toBe(false)
})

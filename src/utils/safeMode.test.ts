import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { isSafeMode } = await import('./envUtils.js')
const { shouldAllowManagedHooksOnly } = await import('./hooks/hooksConfigSnapshot.js')
const { isAutoMemoryEnabled } = await import('../memdir/paths.js')
const { isKeybindingCustomizationEnabled } = await import('../keybindings/loadUserBindings.js')
const { getOutputStyleDirStyles } = await import('../outputStyles/loadOutputStylesDir.js')
const { getAgentDefinitionsWithOverrides } = await import('../tools/AgentTool/loadAgentsDir.js')
const { getSkillDirCommands } = await import('../skills/loadSkillsDir.js')
const { discoverWorkflowSpecs } = await import('../tools/WorkflowTool/workflowDiscovery.js')
const { getClaudeCodeMcpConfigs } = await import('../services/mcp/config.js')

const originalArgv = process.argv
const originalSafeMode = process.env.CLAUDE_CODE_SAFE_MODE
let project: string

function writeCustomizations(root: string): void {
  for (const dir of ['agents', 'output-styles', 'skills/demo', 'workflows']) {
    mkdirSync(join(root, '.claude', dir), { recursive: true })
  }
  writeFileSync(join(root, '.claude', 'agents', 'custom.md'), '---\nname: custom-agent\ndescription: Custom agent\n---\nDo custom work.\n')
  writeFileSync(join(root, '.claude', 'output-styles', 'terse.md'), '---\nname: Terse\ndescription: Terse style\n---\nBe terse.\n')
  writeFileSync(join(root, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nDemo.\n')
  writeFileSync(join(root, '.claude', 'workflows', 'custom-flow.json'), JSON.stringify({
    name: 'custom-flow',
    description: 'Custom workflow',
    phases: [{ id: 'one', description: 'One', prompt: 'One' }],
  }))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'echo' } } }))
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cc-safe-mode-'))
  writeCustomizations(project)
})

afterEach(() => {
  process.argv = originalArgv
  if (originalSafeMode === undefined) delete process.env.CLAUDE_CODE_SAFE_MODE
  else process.env.CLAUDE_CODE_SAFE_MODE = originalSafeMode
  rmSync(project, { recursive: true, force: true })
})

test('safe mode turns on from the env var or a --safe-mode flag before --', () => {
  delete process.env.CLAUDE_CODE_SAFE_MODE
  process.argv = ['bun', 'cli', '-p', 'hi']
  expect(isSafeMode()).toBe(false)
  process.argv = ['bun', 'cli', '--safe-mode']
  expect(isSafeMode()).toBe(true)
  process.argv = ['bun', 'cli', '--', '--safe-mode']
  expect(isSafeMode()).toBe(false)
  process.argv = ['bun', 'cli']
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  expect(isSafeMode()).toBe(true)
})

test('safe mode keeps only managed hooks, and turns off auto-memory and keybindings', () => {
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  const disableAutoMemory = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  try {
    expect(shouldAllowManagedHooksOnly()).toBe(true)
    expect(isAutoMemoryEnabled()).toBe(false)
    expect(isKeybindingCustomizationEnabled()).toBe(false)
  } finally {
    if (disableAutoMemory === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = disableAutoMemory
  }
})

test('safe mode skips custom agents, skills, output styles, workflows and MCP servers', async () => {
  process.env.CLAUDE_CODE_SAFE_MODE = '1'
  expect(await getOutputStyleDirStyles(project)).toEqual([])
  expect(await getSkillDirCommands(project)).toEqual([])
  const agents = await getAgentDefinitionsWithOverrides(project)
  expect(agents.allAgents.some(agent => agent.agentType === 'custom-agent')).toBe(false)
  expect(agents.allAgents.length).toBeGreaterThan(0)
  const workflows = await discoverWorkflowSpecs(project, undefined, { home: project })
  expect(workflows.valid.map(workflow => workflow.commandName).sort()).toEqual(['deep-research'])
  expect((await getClaudeCodeMcpConfigs()).servers).toEqual({})
})

test('without safe mode the same project customizations are discovered', async () => {
  delete process.env.CLAUDE_CODE_SAFE_MODE
  process.argv = ['bun', 'cli']
  const workflows = await discoverWorkflowSpecs(project, undefined, { home: project })
  expect(workflows.valid.some(workflow => workflow.commandName === 'custom-flow')).toBe(true)
})

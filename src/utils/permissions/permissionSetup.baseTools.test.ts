import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { initializeToolPermissionContext } = await import('./permissionSetup.js')
const { getAllBaseTools } = await import('../../tools.js')

// The UDS socket (which enables ListAgents/SendMessage) starts after permission
// setup, so the --tools deny list must not depend on which tools are enabled yet.
test('--tools denies tools that only become enabled later in startup', async () => {
  const { toolPermissionContext } = await initializeToolPermissionContext({
    allowedToolsCli: [],
    disallowedToolsCli: [],
    baseToolsCli: ['Read', 'Glob'],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    addDirs: [],
  })
  const denied = toolPermissionContext.alwaysDenyRules.cliArg ?? []
  expect(denied).toContain('SendMessage')
  for (const { name } of getAllBaseTools()) {
    if (name !== 'Read' && name !== 'Glob') expect(denied).toContain(name)
  }
  expect(denied).not.toContain('Read')
  expect(denied).not.toContain('Glob')
})

test('base tools leave out TaskOutput and offer one Goal tool', () => {
  const names = getAllBaseTools().map(tool => tool.name)
  expect(names).not.toContain('TaskOutput')
  expect(names).not.toContain('SetGoal')
  expect(names).not.toContain('ClearGoal')
  expect(names).toContain('Goal')
})

test('base tools leave out TeamCreate and TeamDelete even with agent teams on', () => {
  const prev = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  try {
    const names = getAllBaseTools().map(tool => tool.name)
    expect(names).not.toContain('TeamCreate')
    expect(names).not.toContain('TeamDelete')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = prev
  }
})

test('base tools offer ReportFindings like 2.1.311', async () => {
  const tool = getAllBaseTools().find(t => t.name === 'ReportFindings')
  expect(tool).toBeDefined()
  expect(tool!.isReadOnly({} as never)).toBe(true)
  const block = tool!.mapToolResultToToolResultBlockParam(
    { count: 2, findings: [] } as never,
    'tu1',
  )
  expect(block.content).toBe('2 findings reported.')
})

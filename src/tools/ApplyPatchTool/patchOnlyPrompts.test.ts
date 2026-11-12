import { afterAll, expect, test } from 'bun:test'

// In apply_patch-only mode GPT models have no Edit or Write tool, so prompts
// must not send them there and ToolSearch must not hand those tools back.

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { normalizeAttachmentForAPI } = await import('../../utils/messages.js')
const { dirExistsGuidance } = await import('../../memdir/memdir.js')
const { ToolSearchTool } = await import('../ToolSearchTool/ToolSearchTool.js')

const saved = process.env.CLAUDE_CODE_USE_OPENAI
afterAll(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = saved
  setSessionSettingsCache({ settings: {}, errors: [] })
})

function useProvider(provider: 'openai' | 'anthropic', openaiEditTools?: 'all') {
  if (provider === 'openai') process.env.CLAUDE_CODE_USE_OPENAI = '1'
  else delete process.env.CLAUDE_CODE_USE_OPENAI
  setSessionSettingsCache({ settings: openaiEditTools ? { openaiEditTools } : {}, errors: [] })
}

function planText(planExists: boolean): string {
  const messages = normalizeAttachmentForAPI({
    type: 'plan_mode',
    reminderType: 'full',
    planFilePath: '/tmp/plan.md',
    planExists,
  } as never)
  return JSON.stringify(messages)
}

async function select(names: string): Promise<string[]> {
  const tool = (name: string) => ({ name, async prompt() { return name } }) as never
  const result = await ToolSearchTool.call(
    { query: `select:${names}`, max_results: 5 },
    {
      options: { tools: ['Edit', 'Write', 'apply_patch'].map(tool), agentDefinitions: { activeAgents: [] } },
      getAppState: () => ({ mcp: { clients: [] }, toolPermissionContext: getEmptyToolPermissionContext() }),
      abortController: new AbortController(),
    } as never,
    async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
  )
  return result.data.matches
}

test('plan mode tells GPT models to write the plan file with apply_patch', () => {
  useProvider('openai')
  expect(planText(false)).toContain('/tmp/plan.md using the apply_patch tool')
  expect(planText(true)).toContain('incremental edits using the apply_patch tool')
  useProvider('openai', 'all')
  expect(planText(false)).toContain('using the Write tool')
  useProvider('anthropic')
  expect(planText(false)).toContain('using the Write tool')
  expect(planText(true)).toContain('using the Edit tool')
})

test('memory guidance names apply_patch for GPT models', () => {
  useProvider('openai')
  expect(dirExistsGuidance()).toContain('with the apply_patch tool')
  useProvider('anthropic')
  expect(dirExistsGuidance()).toContain('with the Write tool')
})

test('ToolSearch select of Edit or Write returns apply_patch for GPT models', async () => {
  useProvider('openai')
  expect(await select('Write,Edit')).toEqual(['apply_patch'])
  useProvider('openai', 'all')
  expect(await select('Write')).toEqual(['Write'])
  useProvider('anthropic')
  expect(await select('Write')).toEqual(['Write'])
})

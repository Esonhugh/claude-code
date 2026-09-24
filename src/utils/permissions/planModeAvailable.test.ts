import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'
import type { SettingsJson } from '../settings/types.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
  ISSUES_EXPLAINER: 'report an issue',
}

const { getTools, getToolsForDefaultPreset } = await import('../../tools.js')
const { toolToAPISchema } = await import('../api.js')
const { getDeferredToolsDelta } = await import('../toolSearch.js')
const { mergeAndFilterTools } = await import('../toolPool.js')
const { ToolSearchTool } = await import('../../tools/ToolSearchTool/ToolSearchTool.js')
const { getNextPermissionMode } = await import('./getNextPermissionMode.js')
const {
  initialPermissionModeFromCLI,
  prepareContextForPlanMode,
  transitionPermissionMode,
} = await import('./permissionSetup.js')
const { applyPermissionUpdate } = await import('./PermissionUpdate.js')
const { applyRequestedAgentPermissionMode } = await import('../../tools/AgentTool/permissionMode.js')
const { EnterPlanModeTool } = await import('../../tools/EnterPlanModeTool/EnterPlanModeTool.js')
const { ExitPlanModeV2Tool } = await import('../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js')
const { syncPermissionRulesFromDisk } = await import('./permissions.js')
const { AskUserQuestionTool } = await import('../../tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { TaskCreateTool } = await import('../../tools/TaskCreateTool/TaskCreateTool.js')
const { AgentTool } = await import('../../tools/AgentTool/AgentTool.js')
const { getBuiltInAgents } = await import('../../tools/AgentTool/builtInAgents.js')
const { formatAgentLine } = await import('../../tools/AgentTool/prompt.js')
const { getSystemPrompt } = await import('../../constants/prompts.js')
const { clearSystemPromptSections } = await import('../../constants/systemPromptSections.js')
const { normalizeAttachmentForAPI } = await import('../messages.js')
const { zodToJsonSchema } = await import('../zodToJsonSchema.js')
const { getRelevantTips } = await import('../../services/tips/tipRegistry.js')
const { clearToolSchemaCache, getToolSchemaCache } = await import('../toolSchemaCache.js')
const originalSettings = getSessionSettingsCache()
const originalEnv = {
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
}

function configure(settings: SettingsJson = {}): void {
  setSessionSettingsCache({ settings, errors: [] })
}

beforeEach(() => {
  clearToolSchemaCache()
  configure()
  delete process.env.CLAUDE_CODE_SIMPLE
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

afterEach(() => {
  clearToolSchemaCache()
  clearSystemPromptSections()
  if (originalSettings) setSessionSettingsCache(originalSettings)
  else resetSettingsCache()
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('Plan mode opt-in', () => {
  test('updates Agent mode schema when opt-in changes without losing other modes', () => {
    for (const enabled of [true, false, true]) {
      configure({ planModeAvailable: enabled })
      const schema = zodToJsonSchema(AgentTool.inputSchema) as {
        properties: { mode: { enum: string[]; description: string } }
      }
      expect(schema.properties.mode.enum.includes('plan')).toBe(enabled)
      expect(schema.properties.mode.description.includes('plan approval')).toBe(enabled)
      expect(schema.properties.mode.enum).toContain('acceptEdits')
    }
  })

  test('does not reintroduce disabled Plan tools from the startup pool or ToolSearch', async () => {
    configure({ planModeAvailable: true })
    const context = getEmptyToolPermissionContext()
    const initialTools = getTools(context)
    configure({ planModeAvailable: false })
    const merged = mergeAndFilterTools(initialTools, getTools(context), 'default')
    expect(merged.map(tool => tool.name)).not.toContain('EnterPlanMode')
    expect(merged.map(tool => tool.name)).not.toContain('ExitPlanMode')
    const result = await ToolSearchTool.call(
      { query: 'select:EnterPlanMode,ExitPlanMode', max_results: 5 },
      {
        options: { tools: merged },
        getAppState: () => ({ mcp: { clients: [] }, toolPermissionContext: context }),
      } as never,
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    )
    expect(result.data.matches).toEqual([])
    const active = { ...context, mode: 'plan' as const }
    expect(mergeAndFilterTools(initialTools, getTools(active), 'plan').map(tool => tool.name))
      .toContain('ExitPlanMode')
  })

  test('updates serialized Plan-sensitive tool schemas after opt-out while keeping stable variants cached', async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    const context = getEmptyToolPermissionContext()
    const agents = getBuiltInAgents()
    configure({ planModeAvailable: true })
    const tools = getTools(context)
    const options = {
      tools,
      agents,
      getToolPermissionContext: async () => context,
    }

    const enabled = await Promise.all(
      [AgentTool, AskUserQuestionTool, TaskCreateTool].map(tool =>
        toolToAPISchema(tool, options),
      ),
    )
    const enabledAgain = await Promise.all(
      [AgentTool, AskUserQuestionTool, TaskCreateTool].map(tool =>
        toolToAPISchema(tool, options),
      ),
    )
    expect(enabledAgain).toEqual(enabled)
    expect(JSON.stringify(enabled)).toMatch(/plan mode|plan approval/i)
    expect(getToolSchemaCache().size).toBe(3)

    configure({ planModeAvailable: false })
    const disabled = await Promise.all(
      [AgentTool, AskUserQuestionTool, TaskCreateTool].map(tool =>
        toolToAPISchema(tool, options),
      ),
    )
    const serialized = JSON.stringify(disabled)
    const agentSchema = JSON.parse(serialized)[0].input_schema as {
      properties: { mode: { enum: string[]; description: string } }
    }
    expect(agentSchema.properties.mode.enum).not.toContain('plan')
    expect(agentSchema.properties.mode.enum).toContain('acceptEdits')
    expect(agentSchema.properties.mode.description).not.toContain('plan approval')
    expect(serialized).not.toMatch(/plan mode|plan approval/i)
    expect(getToolSchemaCache().size).toBe(6)

    const active = { ...context, mode: 'plan' as const }
    const activeAskUserQuestion = await toolToAPISchema(AskUserQuestionTool, {
      ...options,
      getToolPermissionContext: async () => active,
    })
    expect(JSON.stringify(activeAskUserQuestion)).toContain('Plan mode note:')

    configure({ planModeAvailable: true })
    await Promise.all(
      [AgentTool, AskUserQuestionTool, TaskCreateTool].map(tool =>
        toolToAPISchema(tool, options),
      ),
    )
    expect(getToolSchemaCache().size).toBe(6)
  })

  test('filters disabled Plan tools when ToolSearch reads a stale startup pool', async () => {
    configure({ planModeAvailable: true })
    const context = getEmptyToolPermissionContext()
    const startupTools = getTools(context)
    expect(startupTools.map(tool => tool.name)).toContain('EnterPlanMode')
    expect(startupTools.map(tool => tool.name)).toContain('ExitPlanMode')

    configure({ planModeAvailable: false })
    const callToolSearch = (query: string) =>
      ToolSearchTool.call(
        { query, max_results: 5 },
        {
          options: { tools: startupTools },
          getAppState: () => ({
            mcp: { clients: [] },
            toolPermissionContext: context,
          }),
        } as never,
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      )

    expect(
      (await callToolSearch('select:EnterPlanMode,ExitPlanMode')).data.matches,
    ).toEqual([])
    const keywordMatches = (await callToolSearch('plan mode')).data.matches
    expect(keywordMatches).not.toContain('EnterPlanMode')
    expect(keywordMatches).not.toContain('ExitPlanMode')

    const active = { ...context, mode: 'plan' as const }
    const activeResult = await ToolSearchTool.call(
      { query: 'select:EnterPlanMode,ExitPlanMode', max_results: 5 },
      {
        options: { tools: startupTools },
        getAppState: () => ({
          mcp: { clients: [] },
          toolPermissionContext: active,
        }),
      } as never,
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    )
    expect(activeResult.data.matches).toEqual(['ExitPlanMode'])
  })

  test('omits inactive Plan instructions from model, tool, and agent prompts', async () => {
    const context = getEmptyToolPermissionContext()
    const tools = getTools(context)
    const agents = getBuiltInAgents()
    const options = { tools, agents, getToolPermissionContext: async () => context }
    const prompts = [
      ...(await getSystemPrompt(tools, 'claude-opus-4-6')),
      await AskUserQuestionTool.prompt(options),
      await TaskCreateTool.prompt(),
      await AgentTool.prompt(options),
      ...agents.map(formatAgentLine),
      JSON.stringify(AgentTool.inputSchema),
      ...normalizeAttachmentForAPI({ type: 'auto_mode', reminderType: 'full' })
        .map(message => JSON.stringify(message.message.content)),
    ].join('\n')
    expect(prompts).not.toMatch(/EnterPlanMode|ExitPlanMode|plan mode|plan approval/i)
    expect(agents.map(agent => agent.agentType)).toContain('Explore')
    expect(formatAgentLine({
      ...agents[0]!,
      tools: ['EnterPlanMode', 'ExitPlanMode'],
    })).toContain('(Tools: None)')

    configure({ planModeAvailable: true })
    expect(await AskUserQuestionTool.prompt(options)).toContain('Plan mode note:')
    expect(await TaskCreateTool.prompt()).toContain('- Plan mode')
  })

  test('skips Plan in the mode cycle without removing an existing restriction or exit', () => {
    const context = getEmptyToolPermissionContext()
    expect(getNextPermissionMode({ ...context, mode: 'acceptEdits' })).toBe('default')
    expect(getNextPermissionMode({
      ...context, mode: 'acceptEdits', isBypassPermissionsModeAvailable: true,
    })).toBe('bypassPermissions')

    const active = { ...context, mode: 'plan' as const, prePlanMode: 'default' as const }
    expect(transitionPermissionMode('plan', 'plan', active)).toBe(active)
    expect(prepareContextForPlanMode(active)).toBe(active)
    expect(applyRequestedAgentPermissionMode(active, 'plan')).toBe(active)
    expect(applyPermissionUpdate(active, {
      type: 'setMode', mode: 'plan', destination: 'session',
    }).mode).toBe('plan')
    expect(getNextPermissionMode(active)).toBe('default')
    expect(transitionPermissionMode('plan', 'default', active).prePlanMode).toBeUndefined()
    for (const simple of [undefined, '1']) {
      if (simple) process.env.CLAUDE_CODE_SIMPLE = simple
      else delete process.env.CLAUDE_CODE_SIMPLE
      const tools = getTools(active).map(tool => tool.name)
      expect(tools).toContain('ExitPlanMode')
      expect(tools).not.toContain('EnterPlanMode')
    }
    expect(active.mode).toBe('plan')

    configure({ planModeAvailable: true })
    expect(getNextPermissionMode({ ...context, mode: 'acceptEdits' })).toBe('plan')
  })

  test('keeps Plan restrictions and approval guidance when settings are disabled mid-plan', async () => {
    const active = {
      ...getEmptyToolPermissionContext(),
      mode: 'plan' as const,
      prePlanMode: 'default' as const,
    }
    const refreshed = syncPermissionRulesFromDisk(active, [])
    expect(refreshed).not.toBe(active)
    expect(refreshed.mode).toBe('plan')
    expect(refreshed.prePlanMode).toBe('default')
    expect(await AskUserQuestionTool.prompt({
      tools: getTools(refreshed),
      agents: [],
      getToolPermissionContext: async () => refreshed,
    })).toContain('Plan mode note:')
    const context = {
      getAppState: () => ({ toolPermissionContext: refreshed }),
      options: { mainLoopModel: 'claude-opus-4-6' },
    }
    expect((await ExitPlanModeV2Tool.validateInput({}, context as never)).result).toBe(true)
    expect((await ExitPlanModeV2Tool.checkPermissions({}, context as never)).behavior).toBe('ask')
    const reminder = normalizeAttachmentForAPI({
      type: 'plan_mode',
      reminderType: 'full',
      isSubAgent: true,
      planFilePath: '/tmp/plan-mode-opt-in-test.md',
      planExists: false,
    }).map(message => message.message.content).join('\n')
    expect(reminder).toContain('MUST NOT make any edits except to the plan file')
  })

  test('does not suggest disabled Plan mode in built-in tips', async () => {
    const tips = await getRelevantTips()
    expect(tips.map(tip => tip.id)).not.toContain('plan-mode-for-complex-tasks')
    expect(tips.map(tip => tip.id)).not.toContain('default-permission-mode-config')
    expect(tips.map(tip => tip.id)).not.toContain('opusplan-mode-reminder')
    const shiftTab = tips.find(tip => tip.id === 'shift-tab')!
    const content = shiftTab.content as () => Promise<string>
    expect(await content()).not.toMatch(/plan mode/i)
    configure({ planModeAvailable: true })
    expect(await content()).toMatch(/plan mode/i)
  })

  test('requires opt-in for teammate Plan startup flags, even with bypass requested', () => {
    for (const dangerouslySkipPermissions of [false, true]) {
      expect(() => initialPermissionModeFromCLI({
        permissionModeCli: 'default',
        dangerouslySkipPermissions,
        planModeRequired: true,
      })).toThrow(/Plan mode is disabled.*"planModeAvailable": true/)
    }
    configure({ planModeAvailable: true })
    expect(() => initialPermissionModeFromCLI({
      permissionModeCli: 'default',
      dangerouslySkipPermissions: false,
      planModeRequired: true,
    })).not.toThrow()
  })

  test('rejects new Plan entries through CLI, defaults, and permission transitions', async () => {
    const context = getEmptyToolPermissionContext()
    const actionable = /Plan mode is disabled.*"planModeAvailable": true.*settings\.json/
    expect(() => initialPermissionModeFromCLI({
      permissionModeCli: 'plan',
      dangerouslySkipPermissions: false,
    })).toThrow(actionable)
    configure({ permissions: { defaultMode: 'plan' } })
    expect(() => initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
    })).toThrow(actionable)
    expect(initialPermissionModeFromCLI({
      permissionModeCli: 'default',
      dangerouslySkipPermissions: false,
    }).mode).toBe('default')
    expect(() => transitionPermissionMode('default', 'plan', context)).toThrow(actionable)
    expect(() => prepareContextForPlanMode(context)).toThrow(actionable)
    expect(() => applyPermissionUpdate(context, {
      type: 'setMode', mode: 'plan', destination: 'session',
    })).toThrow(actionable)
    expect(() => applyRequestedAgentPermissionMode(context, 'plan')).toThrow(actionable)
    await expect(EnterPlanModeTool.call({}, {
      getAppState: () => ({ toolPermissionContext: context }),
      setAppState: () => { throw new Error('must not change state') },
    } as never, undefined as never, undefined as never)).rejects.toThrow(actionable)

    configure({ planModeAvailable: true, permissions: { defaultMode: 'plan' } })
    expect(initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
    }).mode).toBe('plan')
    expect(initialPermissionModeFromCLI({
      permissionModeCli: 'plan',
      dangerouslySkipPermissions: false,
    }).mode).toBe('plan')
    expect(prepareContextForPlanMode(context).prePlanMode).toBe('default')
    expect(applyPermissionUpdate(context, {
      type: 'setMode', mode: 'plan', destination: 'session',
    }).mode).toBe('plan')
  })

  test('hides idle Plan tools and deferred discovery unless explicitly enabled', () => {
    for (const settings of [{}, { planModeAvailable: false }]) {
      configure(settings)
      const tools = getTools(getEmptyToolPermissionContext())
      const names = tools.map(tool => tool.name)
      expect(names).not.toContain('EnterPlanMode')
      expect(names).not.toContain('ExitPlanMode')
      expect(getToolsForDefaultPreset()).not.toContain('EnterPlanMode')
      expect(getToolsForDefaultPreset()).not.toContain('ExitPlanMode')
      const announced = getDeferredToolsDelta(tools, [])?.addedLines.join('\n') ?? ''
      expect(announced).not.toContain('EnterPlanMode')
      expect(announced).not.toContain('ExitPlanMode')
    }

    configure({ planModeAvailable: true })
    const names = getTools(getEmptyToolPermissionContext()).map(tool => tool.name)
    expect(names).toContain('EnterPlanMode')
    expect(names).toContain('ExitPlanMode')
    expect(getToolsForDefaultPreset()).toContain('EnterPlanMode')
    expect(getToolsForDefaultPreset()).toContain('ExitPlanMode')
  })
})

import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { query, type QueryParams } from './query.js'
import type { ToolUseContext } from './Tool.js'
import { createModsRuntime } from './services/mods/runtime.js'
import { createAssistantMessage, createUserMessage } from './utils/messages.js'
import { seatNativeModPlugins } from './services/mods/native.js'
import { withSystemPromptSections, concatSystemPrompts, joinSystemPrompt, getSystemPromptFacts, getSystemPromptSections } from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test', ISSUES_EXPLAINER: 'report an issue',
}

afterEach(resetStateForTests)

// The bare path avoids config discovery, disk writes and network requests.
test('real generation retains a rerender recipe through append and join', async () => {
  const original = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  try {
    const { getSystemPrompt } = await import('./constants/prompts.js')
    const { renderSystemPrompt } = await import('./utils/systemPromptType.js')
    const generated = await getSystemPrompt([], 'old-model')
    const prompt = joinSystemPrompt(concatSystemPrompts(['before'], generated, ['after']), '|')
    const rendered = await renderSystemPrompt(prompt, {
      promptModel: 'new-model', model: 'request-model', tools: [],
      outputStyle: null, traits: ['bare', 'print'], surfaces: [],
    })
    expect(rendered.join('')).toBe(`before|${generated.join('')}|after`)
    expect(getSystemPromptFacts(rendered)).toEqual({ promptModel: 'new-model', outputStyle: null, traits: ['bare', 'print'] })
    expect(getSystemPromptFacts(generated)?.promptModel).toBe('old-model')
    const plan = getSystemPromptSections(rendered)!
    expect(plan).toEqual([{ sections: [
      { text: 'before', scope: 'session' },
      ...getSystemPromptSections(generated)!,
      { text: 'after', scope: 'session' },
    ], separator: '|' }])
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = original
  }
})

test('generation facts and explicit scopes survive joins without a cache boundary', () => {
  const facts = { promptModel: 'render-model', outputStyle: { name: 'custom', isKeepingCodingInstructions: false }, traits: ['bare' as const] }
  const prompt = withSystemPromptSections([
    { name: 'identity', text: 'shared', scope: 'shared' },
    { name: 'memory', text: 'session', scope: 'session' },
  ], facts)
  const joined = concatSystemPrompts(joinSystemPrompt(prompt, '\n\n'), ['append'])
  expect([...joined]).toEqual(['shared\n\nsession', 'append'])
  expect(getSystemPromptFacts(joined)).toEqual(facts)
  expect(getSystemPromptSections(joined)).toEqual([
    { sections: getSystemPromptSections(prompt), separator: '\n\n' },
    { text: 'append', scope: 'session' },
  ])
  expect(getSystemPromptFacts(['unknown'])).toBeUndefined()
})

test('real generation rerenders model, output style and tool guidance without poisoning cached sections', async () => {
  const { getSystemPrompt } = await import('./constants/prompts.js')
  const { renderSystemPrompt } = await import('./utils/systemPromptType.js')
  const generated = await getSystemPrompt([], 'claude-opus-4-6')
  const rendered = await renderSystemPrompt(generated, {
    model: 'request-model', promptModel: 'claude-sonnet-4-6', tools: ['TaskCreate'],
    outputStyle: { name: 'Explanatory', isKeepingCodingInstructions: false },
    traits: ['print'], surfaces: [],
  })
  const text = rendered.join('\n')
  expect(text).toContain('# Explanatory Style Active')
  expect(text).toContain('TaskCreate')
  expect(generated.join('\n')).not.toContain('TaskCreate')
  expect(text).not.toContain('# Doing tasks')
  expect(text).toContain('The exact model ID is claude-sonnet-4-6')
  expect(text).toContain('August 2025')
  expect(text).not.toContain('The exact model ID is claude-opus-4-6')
  expect(text).not.toContain('suggest they type `! <command>`')
  expect(getSystemPromptFacts(rendered)).toEqual({ promptModel: 'claude-sonnet-4-6', outputStyle: { name: 'Explanatory', isKeepingCodingInstructions: false }, traits: ['print'] })
  expect(await getSystemPrompt([], 'claude-opus-4-6')).toEqual(generated)
})

test('generation rejects unsupported or contradictory facts rather than inventing provenance', async () => {
  const { getSystemPrompt } = await import('./constants/prompts.js')
  const { renderSystemPrompt } = await import('./utils/systemPromptType.js')
  const generated = await getSystemPrompt([], 'render-model')
  const input = { model: 'request-model', promptModel: 'render-model', tools: [], outputStyle: null, traits: [], surfaces: [] } as const
  await expect(renderSystemPrompt(['custom text'], input)).rejects.toThrow('recipe is unavailable')
  await expect(renderSystemPrompt(withSystemPromptSections([{ name: 'identity', text: 'custom', scope: 'shared' }], input), input)).rejects.toThrow('recipe is unavailable')
  await expect(renderSystemPrompt(generated, { ...input, traits: ['lean'] })).rejects.toThrow('Unsupported prompt generation trait')
  await expect(renderSystemPrompt(generated, { ...input, outputStyle: { name: 'missing-style', isKeepingCodingInstructions: false } })).rejects.toThrow('Unknown output style')
  await expect(renderSystemPrompt(generated, { ...input, traits: ['bare'], outputStyle: { name: 'Explanatory', isKeepingCodingInstructions: true } })).rejects.toThrow('Bare prompts do not render output styles or skills')
  await expect(renderSystemPrompt(generated, { ...input, traits: ['skills'] })).rejects.toThrow('Skills guidance requires the Skill tool')
  const skills = await renderSystemPrompt(generated, { ...input, tools: ['Skill'], traits: ['skills'] })
  expect(skills.join('\n')).toContain('/<skill-name>')
  const noSkills = await renderSystemPrompt(generated, { ...input, tools: ['Skill'], traits: [] })
  expect(noSkills.join('\n')).not.toContain('/<skill-name>')
})

// No filesystem fixtures, external requests or teardown deletion. Only the
// transport is replaced: prompt assembly and dispatch run through real query().
test.each([false, true])('real query sends the prompt.compose replacement on every model request (recipe=%s)', async recipe => {
  const runtime = createModsRuntime()
  const composed: unknown[] = []
  const renderedCompositions: string[] = []
  const source = `export function register(on) {
    on('turn.start', async ($, e, next) => {
      const result = await $.prompt.compose(${recipe ? "{promptModel:'new-model', outputStyle:{name:'Explanatory',isKeepingCodingInstructions:false},traits:['print'],tools:['Bash']}" : ''});
      if (${recipe ? "!result.sections.some(s => s.text.includes('# Explanatory Style Active'))" : "result.sections[0].text !== 'policy-1'"}) throw new Error('active compose did not reach adapter');
      return next(e);
    });
  }`
  await runtime.reconcile(seatNativeModPlugins([], {
    userSettings: null, flagSettings: null, policySettings: null,
    hookPolicy: { managedOnly: false, allDisabled: false }, subscriptionType: 'team',
  }, {
    name: 'sec-default', storageId: 'sec-default@builtin', isNative: true,
    pluginRoot: 'builtin:query-compose', entrypoints: ['builtin:query-compose/register.js'],
    modules: [{ path: 'builtin:query-compose/register.js', source }], links: [],
    events: ['turn.start'], calls: ['prompt.compose'], nextTiers: [], options: {}, tier: 'prepend', fingerprint: source,
  }))
  runtime.registerHostHook({
    plugin: 'organization', tier: 'append',
    registration: { id: 1, event: 'prompt.compose', hasCatch: false },
    invoke: async (input, next) => {
      composed.push(input)
      if (recipe) {
        const result = await next(input)
        renderedCompositions.push((result as { sections: { text: string }[] }).sections.map(s => s.text).join('\n'))
        return result
      }
      return { sections: [{ id: 'organization:policy', text: `policy-${composed.length}`, scope: 'session' }] }
    },
  })
  let appState = getDefaultAppState()
  const context = {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-test', tools: [], verbose: false,
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState, setAppState: (update: any) => { appState = update(appState) },
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    messages: [], mods: runtime,
  } as unknown as ToolUseContext
  const requests: string[][] = []
  const params: QueryParams = {
    messages: [createUserMessage({ content: 'answer' })],
    systemPrompt: recipe ? concatSystemPrompts(['before-generated'], joinSystemPrompt(concatSystemPrompts(['joined-prefix'], await (await import('./constants/prompts.js')).getSystemPrompt([], 'render-model')), '|'), ['after-generated']) : withSystemPromptSections([{ name: 'identity', text: 'original', scope: 'shared' }], {
      promptModel: 'render-model', outputStyle: null, traits: [],
    }),
    userContext: {}, systemContext: {}, toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    querySource: 'repl_main_thread',
    publicTurn: { text: 'answer' },
    onCacheSafeParams: cached => {
      expect(getSystemPromptFacts(cached.systemPrompt)).toBeUndefined()
      expect(getSystemPromptSections(cached.systemPrompt)).toBeUndefined()
    },
    deps: {
      uuid: randomUUID,
      microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }),
      callModel: async function* (request) {
        const prompt = await request.options.composeSystemPrompt?.(
          request.options.model, request.tools.map(tool => tool.name), request.signal,
        ) ?? request.systemPrompt
        expect(getSystemPromptFacts(prompt)).toBeUndefined()
        expect(getSystemPromptSections(prompt)).toBeUndefined()
        requests.push([...prompt])
        const message = createAssistantMessage({ content: requests.length === 1 ? 'partial' : 'done' })
        Object.assign(message.message, { id: `compose-${requests.length}`, model: 'claude-test', stop_reason: 'end_turn' })
        if (requests.length === 1) Object.assign(message, { apiError: 'max_output_tokens', isApiErrorMessage: true })
        yield message
      },
    },
  }
  try {
    for await (const _message of query(params)) { /* Drain the real loop. */ }
    expect(requests).toHaveLength(2)
    expect(composed).toHaveLength(3)
    if (recipe) {
      expect(renderedCompositions).toHaveLength(3)
      expect(renderedCompositions[0]).toContain('# Explanatory Style Active')
      expect(renderedCompositions[0]).toContain('powered by the model new-model')
      expect(composed[0]).toMatchObject({ promptModel: 'new-model', tools: ['Bash'], traits: ['print'] })
      expect(requests[0]![0]).toBe('before-generated')
      expect(requests[0]![1]).toStartWith('joined-prefix|')
      expect(requests[0]!.at(-1)).toBe('after-generated')
      expect(requests[0]!.join('\n')).toContain('render-model')
      expect(requests[0]!.join('\n')).not.toContain('# Explanatory Style Active')
    } else {
      expect(composed[0]).toMatchObject({ model: 'claude-test', promptModel: 'render-model', tools: [], outputStyle: null, traits: [] })
      expect(requests.map(prompt => prompt.join('\n\n'))).toEqual(['policy-2', 'policy-3'])
    }
  } finally {
    await runtime.dispose()
  }
})

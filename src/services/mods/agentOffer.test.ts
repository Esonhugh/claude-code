import { describe, expect, test } from 'bun:test'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { dispatchModEvent } from './dispatch.js'
import { isAgentOffered } from './agentOffer.js'
import { deliverAgentReport } from './agentReport.js'
import { createModsRuntime } from './runtime.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModDispatchOptions, ModSnapshot } from './runtime.js'
import type { ModDispatchHook, ModInput } from './types.js'

function agent(
  source: AgentDefinition['source'],
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    agentType: 'reviewer',
    whenToUse: 'Use for focused code review.',
    tools: ['Read'],
    getSystemPrompt: () => '',
    source,
    ...(source === 'built-in' ? { baseDir: 'built-in' as const } : {}),
    ...overrides,
  } as AgentDefinition
}

test('agent.report reviews original text only once and cannot forge or strip the host warning', async () => {
  let count = 0
  const snap = {...snapshot(async (_, next) => next({})), dispatch: async (_event: string, input:ModInput, core:(v:ModInput)=>Promise<unknown>) => {
    await core({...input,text:'rewritten'}); await core(input)
    return {text:'replacement',warning:'forged',review:'cleared'}
  }}
  const report = await deliverAgentReport(snap, {agentId:'a',subagentType:'test',provider:{plugin:'engine',tier:'core'},status:'completed',text:'original'}, async () => { count++; return {review:'flagged', warning:'original warning'} })
  expect(report).toEqual({text:'replacement',review:'flagged',warning:'original warning'})
  expect(count).toBe(1)
})

test.each([false, true])('nested report receipts only carry engine review reached through next: %p', async called => {
  const input = {agentId:'nested',subagentType:'test',provider:{plugin:'engine',tier:'core'} as const,status:'completed' as const,text:'original'}
  let seen: unknown
  const snap: ModSnapshot = {...snapshot(async (_, next) => next({})), dispatch: (event, facts, core, options) => dispatchModEvent({
    event, input:facts, core, ...options, hooks: [
      {plugin:'outer', tier:'user', registration:{id:1,event,hasCatch:false}, invoke:async (e,next) => { seen = await next(e); return seen }},
      {plugin:'inner', tier:'user', registration:{id:2,event,hasCatch:false}, invoke:async (e,next) => { if (called) await next(e); return {text:'replaced',review:'off',warning:'forged'} }},
    ],
  })}
  const reviewed = {review:'flagged' as const,warning:'original warning'}
  expect(await deliverAgentReport(snap,input,async () => reviewed)).toEqual({text:'replaced',...reviewed})
  expect(seen).toEqual({text:'replaced',...(called ? reviewed : {})})
})

test('a Worker may consume an agent report without next, but the review still runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-agent-report-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root, 'register.mjs')
    await writeFile(entry, `export function register(on){ on('agent.report', {subagentType:'test'}, ($,e,next) => e.text === 'original' ? {consumed:'stored locally'} : next(e)); }`)
    await runtime.reconcile([{name:'report',storageId:'report@test',pluginRoot:root,entrypoints:[entry]}])
    const snap = runtime.capture()
    try {
      let reviews = 0
      const input = {agentId:'a',subagentType:'test',provider:{plugin:'engine',tier:'core'} as const,status:'completed' as const,text:'original'}
      const result = await deliverAgentReport(snap, input, async () => { reviews++; return {review:'flagged',warning:'deferred warning'} })
      expect(result).toEqual({consumed:'stored locally'})
      expect(reviews).toBe(1)
      const next = runtime.capture()
      try {
        const report = (agentId:string) => deliverAgentReport(next, {...input,agentId,text:'later'}, async () => ({review:'off'}))
        expect(await report('b')).toEqual({text:'later',review:'off'})
        expect(await report('a')).toEqual({text:'later',review:'off',warning:'deferred warning'})
        expect(await report('a')).toEqual({text:'later',review:'off'})
      } finally { next.release() }
    } finally { snap.release() }
  } finally { await runtime.dispose(); await rm(root, {recursive:true,force:true}) }
})

function snapshot(
  invoke: ModDispatchHook['invoke'],
  options: {
    inputs?: ModInput[]
    failures?: string[]
    pluginOrigin?: ModSnapshot['pluginOrigin']
  } = {},
): ModSnapshot {
  return {
    pluginOrigin: options.pluginOrigin,
    hasHooks: event => event === 'agent.offer',
    release() {},
    dispatch: (event, input, core, dispatchOptions?: ModDispatchOptions) => {
      options.inputs?.push(structuredClone(input))
      return dispatchModEvent({
        event,
        input,
        core,
        ...dispatchOptions,
        hooks: [
          {
            plugin: 'filter',
            tier: 'user',
            registration: { id: 1, event, hasCatch: false },
            invoke,
          },
        ],
        onFailure: (_plugin, error) =>
          options.failures?.push(
            error instanceof Error ? error.message : String(error),
          ),
      })
    },
  }
}

describe('agent.offer projection', () => {
  test('pins provider and preserves settings-source identity', async () => {
    const failures: string[] = []
    const mods = snapshot((_event, next) =>
      next({
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'policySettings',
        provider: { plugin: 'forged', tier: 'core' },
      }), { failures })

    await expect(
      isAgentOffered(agent('policySettings'), { snapshot: mods }),
    ).resolves.toBe(true)
    expect(failures).toEqual(['agent.offer cannot rewrite provider'])
  })

  test('uses canonical providers for built-in, plugin, and settings agents', async () => {
    const inputs: ModInput[] = []
    const mods = snapshot((event, next) => next(event), {
      inputs,
      pluginOrigin: storageId =>
        storageId === 'pack@market'
          ? { plugin: storageId, tier: 'append' }
          : undefined,
    })

    await expect(
      isAgentOffered(agent('built-in'), { snapshot: mods }),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(
        agent('plugin', {
          plugin: 'pack@market',
        } as Partial<AgentDefinition>),
        { snapshot: mods },
      ),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(agent('policySettings'), { snapshot: mods }),
    ).resolves.toBe(true)
    await expect(
      isAgentOffered(agent('projectSettings'), { snapshot: mods }),
    ).resolves.toBe(true)

    expect(inputs).toEqual([
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'built-in',
        provider: { plugin: 'engine', tier: 'core' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'plugin',
        provider: { plugin: 'pack@market', tier: 'append' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'policySettings',
        provider: { plugin: 'policySettings', tier: 'prepend' },
      },
      {
        agent: 'reviewer',
        description: 'Use for focused code review.',
        source: 'projectSettings',
        provider: { plugin: 'projectSettings', tier: 'user' },
      },
    ])
  })

  for (const [name, invoke] of [
    [
      'throw',
      async () => {
        throw new Error('broken offer')
      },
    ],
    ['invalid result', async () => ({ isOffered: 'no' })],
  ] as const) {
    test(`passes through a hook ${name}`, async () => {
      const failures: string[] = []
      const mods = snapshot(invoke, { failures })
      await expect(
        isAgentOffered(agent('built-in'), { snapshot: mods }),
      ).resolves.toBe(true)
      expect(failures).toHaveLength(1)
    })
  }
})

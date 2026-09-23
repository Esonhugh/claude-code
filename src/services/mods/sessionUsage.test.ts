import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureModSessionUsage, validateModSessionUsageArgs, validateModSessionUsage } from './sessionUsage.js'
import { createAssistantMessage, createCompactBoundaryMessage } from '../../utils/messages.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { resetStateForTests } from '../../bootstrap/state.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import * as limits from '../claudeAiLimits.js'
import * as cost from '../../cost-tracker.js'
import * as collector from '../../commands/context/context-noninteractive.js'

let root: string
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR']
let saved: (string | undefined)[]
const restore: (() => void)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-usage-'))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  resetSettingsCache()
  resetStateForTests()
})
afterEach(async () => {
  for (const undo of restore.splice(0)) undo()
  resetSettingsCache()
  resetStateForTests()
  envKeys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  await rm(root, {recursive:true,force:true})
})

function context(messages: ReturnType<typeof createAssistantMessage>[] = []) {
  const state = getDefaultAppState()
  return {
    messages,
    getAppState: () => state,
    options: {
      mainLoopModel:'claude-sonnet-4-6', tools:[],
      agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined},
    },
  }
}

test('plain usage omits unknown readings, reports the CLI zero ledger and never computes a breakdown', async () => {
  const count = spyOn(collector, 'collectContextData').mockImplementation(async () => {throw new Error('plain usage must not count')})
  const rate = spyOn(limits, 'getRawUtilization').mockReturnValue({})
  const ledger = spyOn(cost, 'getTotalCost').mockReturnValue(0)
  restore.push(() => count.mockRestore(), () => rate.mockRestore(), () => ledger.mockRestore())
  const captured = captureModSessionUsage(context())
  expect(await captured({columns:12})).toEqual({context:{window:200000},rateLimits:[],cost:{usd:0}})
  expect(count).not.toHaveBeenCalled()
})

test('breakdown projects official agentType and strips internal collector sections', async () => {
  const count = spyOn(collector, 'collectContextData').mockResolvedValue({
    categories:[],totalTokens:10,maxTokens:200000,rawMaxTokens:200000,
    autocompactSource:'auto',percentage:0,gridRows:[],model:'claude-sonnet-4-6',
    memoryFiles:[],mcpTools:[],agents:[{agentType:'researcher',source:'projectSettings',tokens:10}],
    isAutoCompactEnabled:false,apiUsage:null,messageBreakdown:{internal:true},
  } as never)
  const rate = spyOn(limits, 'getRawUtilization').mockReturnValue({})
  const ledger = spyOn(cost, 'getTotalCost').mockReturnValue(0)
  restore.push(() => count.mockRestore(), () => rate.mockRestore(), () => ledger.mockRestore())

  const result = await captureModSessionUsage(context())({breakdown:'summary',columns:0})

  expect(count).toHaveBeenCalledWith(
    expect.anything(),
    {detail:'summary',columns:0},
    undefined,
  )
  expect(result.context.breakdown?.agents).toEqual([
    {agentType:'researcher',source:'projectSettings',tokens:10},
  ])
  expect(result.context.breakdown).not.toHaveProperty('messageBreakdown')
})

test('usage captures last-response input, model, rate windows and ledger before an asynchronous hook can change them', async () => {
  const message = createAssistantMessage({content:'answer'})
  Object.assign(message.message, {model:'claude-sonnet-4-6',usage:{input_tokens:2000,cache_creation_input_tokens:1000,cache_read_input_tokens:7000,output_tokens:9000}})
  const input = context([message])
  const rate = spyOn(limits, 'getRawUtilization').mockReturnValue({five_hour:{utilization:0.234567,resets_at:123}})
  const ledger = spyOn(cost, 'getTotalCost').mockReturnValue(1.25)
  restore.push(() => rate.mockRestore(), () => ledger.mockRestore())
  const captured = captureModSessionUsage(input)
  input.messages.length = 0
  input.options.mainLoopModel = 'claude-sonnet-4-6[1m]'
  rate.mockReturnValue({})
  ledger.mockReturnValue(9)
  expect(await captured({})).toEqual({
    context:{tokens:10000,window:200000,percent:5},
    rateLimits:[{kind:'five_hour',percentUsed:23.5,resetsAt:'1970-01-01T00:02:03.000Z'}],
    cost:{usd:1.25},
  })
})

test('breakdown forwards cancellation to the production collector', async () => {
  let received: AbortSignal | undefined
  const count = spyOn(collector, 'collectContextData').mockImplementation(async (_context, _options, signal) => {
    received = signal
    return {
      categories:[],totalTokens:0,maxTokens:200000,rawMaxTokens:200000,
      autocompactSource:'auto',percentage:0,gridRows:[],model:'claude-sonnet-4-6',
      memoryFiles:[],mcpTools:[],agents:[],isAutoCompactEnabled:false,apiUsage:null,
    } as never
  })
  const rate = spyOn(limits, 'getRawUtilization').mockReturnValue({})
  const ledger = spyOn(cost, 'getTotalCost').mockReturnValue(0)
  restore.push(() => count.mockRestore(), () => rate.mockRestore(), () => ledger.mockRestore())
  const controller = new AbortController()

  await captureModSessionUsage(context())({breakdown:'summary'},controller.signal)

  expect(received).toBe(controller.signal)
})

test('a compact boundary without a new response hides the old live-window token count', async () => {
  const message = createAssistantMessage({content:'old answer'})
  Object.assign(message.message, {model:'claude-sonnet-4-6',usage:{input_tokens:1000,output_tokens:100}})
  const input = {...context(),messages:[message,createCompactBoundaryMessage('manual',1100)]}
  const rate = spyOn(limits, 'getRawUtilization').mockReturnValue({})
  const ledger = spyOn(cost, 'getTotalCost').mockReturnValue(2)
  restore.push(() => rate.mockRestore(), () => ledger.mockRestore())
  expect(await captureModSessionUsage(input)({})).toEqual({context:{window:200000},rateLimits:[],cost:{usd:2}})
})

test('usage validates finite arguments and structured results without requiring unavailable figures', () => {
  for (const value of [{}, {breakdown:'summary',columns:0}, {breakdown:'full',columns:80}])
    expect(() => validateModSessionUsageArgs(value)).not.toThrow()
  for (const value of [null, [], {breakdown:'none'}, {columns:Infinity}, {columns:'80'}])
    expect(() => validateModSessionUsageArgs(value)).toThrow('session.usage')
  expect(() => validateModSessionUsage({context:{window:200000},rateLimits:[]})).not.toThrow()
  for (const value of [{context:{window:'200000'},rateLimits:[]}, {context:{window:200000}}, {context:{window:200000},rateLimits:[{kind:'five_hour',percentUsed:NaN}]}])
    expect(() => validateModSessionUsage(value)).toThrow('session.usage')
})

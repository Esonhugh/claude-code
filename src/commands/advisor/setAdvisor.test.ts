import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as settings from '../../utils/settings/settings.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { resetMainAdvisorCarrier, getMainAdvisorCarrier } from '../../utils/advisorQuery.js'
import * as modelAllowlist from '../../utils/model/modelAllowlist.js'
import * as modelOptions from '../../utils/model/modelOptions.js'
import advisorCommand, { advisorNonInteractive } from './index.js'
import { call as advisorCall } from './advisorNonInteractive.js'
import {
  getAdvisorModelOptions,
  getAdvisorUsageText,
  getInvalidAdvisorText,
  setAdvisor,
  toAdvisorChoice,
} from './setAdvisor.js'

let state: { advisorModel?: string }
let writes: unknown[]
const setAppState = (f: (prev: AppState) => AppState) => {
  state = f(state as AppState)
}
const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  SWITCH,
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const spies: { mockRestore(): void }[] = []

// What /model would list: its "Default" row, two aliases and a gateway model.
const MODEL_OPTIONS = [
  { value: null, label: 'Default', description: 'Current model' },
  { value: 'opus', label: 'Opus', description: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5.5' },
  { value: 'Opus 5.5', label: 'Opus 5.5', description: 'Gateway model' },
]

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env[SWITCH] = '1'
  state = {}
  writes = []
  spies.push(
    spyOn(settings, 'updateSettingsForSource').mockImplementation((source, patch) => {
      writes.push([source, patch])
      return { error: null }
    }),
    spyOn(modelOptions, 'getModelOptions').mockReturnValue(MODEL_OPTIONS),
  )
  resetMainAdvisorCarrier()
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const run = (choice: string, mainLoopModel = 'claude-sonnet-4-6', messages: Message[] = []) =>
  setAdvisor({ choice, mainLoopModel, setAppState, messages })

test('sets and persists the advisor', () => {
  expect(run('opus')).toBe('Advisor set to Opus 5.5')
  expect(state.advisorModel).toBe('opus')
  expect(writes).toEqual([['userSettings', { advisorModel: 'opus' }]])
})

test('turns the advisor off', () => {
  state = { advisorModel: 'opus' }
  expect(run('off')).toBe('Advisor disabled')
  expect(state.advisorModel).toBeUndefined()
  expect(writes).toEqual([['userSettings', { advisorModel: undefined }]])
})

test('any model advises any main model, without a note', () => {
  expect(run('opus', 'claude-opus-4-5')).toBe('Advisor set to Opus 5.5')
  expect(run('claude-sonnet-4-6', 'claude-opus-5')).not.toContain('\n')
  expect(state.advisorModel).toBe('claude-sonnet-4-6')
  expect(run('claude-haiku-4-5', 'claude-fable-5-1')).not.toContain('\n')
  expect(run('Opus 5.5', 'Grok-4.7')).toBe('Advisor set to Opus 5.5')
  expect(state.advisorModel).toBe('Opus 5.5')
})

test('rejects a model availableModels excludes without touching state', () => {
  spies.push(
    spyOn(modelAllowlist, 'isModelAllowed').mockImplementation(
      model => !model.includes('fable'),
    ),
  )
  expect(run('claude-fable-5-1')).toBe(getInvalidAdvisorText('claude-fable-5-1'))
  expect(getInvalidAdvisorText('claude-fable-5-1')).toBe(
    'claude-fable-5-1 cannot be used as an advisor. Valid options: opus, sonnet, Opus 5.5, off',
  )
  expect(state.advisorModel).toBeUndefined()
  expect(writes).toEqual([])
})

test('explains which advisor the current conversation keeps', () => {
  getMainAdvisorCarrier().held = { model: 'opus' }
  expect(run('sonnet')).toContain(
    'The current conversation keeps Opus 5.5 as its advisor until /clear or /compact',
  )
  expect(run('opus')).toBe('Advisor set to Opus 5.5')
  // After a refusal the local advisor answers, with the new setting.
  getMainAdvisorCarrier().held = { model: undefined, refused: true }
  expect(run('opus')).toBe('Advisor set to Opus 5.5')
  expect(run('off')).toBe('Advisor disabled')
})

test('the candidates are the models /model lists', () => {
  expect(getAdvisorModelOptions()).toEqual(MODEL_OPTIONS.slice(1))
  expect(getAdvisorUsageText()).toBe(
    'Usage: /advisor <model|off>. Available: opus, sonnet, Opus 5.5, off, or any other model name.',
  )
  expect(advisorCommand.argumentHint).toBe('[model|off]')
  expect(advisorNonInteractive.argumentHint).toBe('<model|off>')
})

const command = (args: string) =>
  advisorCall(args, { getAppState: () => state, setAppState, messages: [] } as never)

test('the command exists only with the switch', async () => {
  expect(advisorCommand.isEnabled()).toBe(true)
  expect(advisorCommand.isHidden).toBe(false)
  delete process.env[SWITCH]
  expect(advisorCommand.isEnabled()).toBe(false)
  expect(advisorCommand.isHidden).toBe(true)
  expect(advisorNonInteractive.isEnabled()).toBe(false)
  expect(await command('opus')).toEqual({ type: 'text', value: 'The advisor is not available' })
  expect(state.advisorModel).toBeUndefined()
})

test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL takes the command away', () => {
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
  expect(advisorCommand.isEnabled()).toBe(false)
  expect(advisorCommand.isHidden).toBe(true)
  expect(advisorNonInteractive.isEnabled()).toBe(false)
})

test('a typed name takes the spelling /model lists, or stays as typed', async () => {
  expect(toAdvisorChoice('OPUS')).toBe('opus')
  expect(toAdvisorChoice('opus 5.5')).toBe('Opus 5.5')
  // An alias /model does not list here.
  expect(toAdvisorChoice('HAIKU')).toBe('haiku')
  // Any other name: the names a gateway serves can be case-sensitive.
  expect(toAdvisorChoice('Grok-4.7')).toBe('Grok-4.7')

  expect(await command(' opus 5.5 ')).toEqual({ type: 'text', value: 'Advisor set to Opus 5.5' })
  expect(state.advisorModel).toBe('Opus 5.5')
  expect(writes.at(-1)).toEqual(['userSettings', { advisorModel: 'Opus 5.5' }])
  await command('Grok-4.7')
  expect(state.advisorModel).toBe('Grok-4.7')
  expect(await command('OFF')).toEqual({ type: 'text', value: 'Advisor disabled' })
  expect(state.advisorModel).toBeUndefined()
})

test('a conversation keeps the server-side advisor it declared', () => {
  getMainAdvisorCarrier().held = { model: 'opus' }
  expect(run('Opus 5.5', 'Grok-4.7')).toBe(
    'Advisor set to Opus 5.5\nThe current conversation keeps Opus 5.5 as its advisor until /clear or /compact, so the prompt it has already sent stays unchanged; the new setting applies from there and in new conversations.',
  )
  // Requests can no longer carry it, so the local advisor answers with the new setting.
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  expect(run('Opus 5.5', 'Grok-4.7')).toBe('Advisor set to Opus 5.5')
})

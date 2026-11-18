import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as settings from '../../utils/settings/settings.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { resetMainAdvisorCarrier, getMainAdvisorCarrier } from '../../utils/advisorQuery.js'
import advisorCommand, { advisorNonInteractive } from './index.js'
import { getAdvisorUsageText, getInvalidAdvisorText, setAdvisor } from './setAdvisor.js'

let state: { advisorModel?: string }
let writes: unknown[]
const setAppState = (f: (prev: AppState) => AppState) => {
  state = f(state as AppState)
}
const ENV_KEYS = [
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  state = {}
  writes = []
  spyOn(settings, 'updateSettingsForSource').mockImplementation((source, patch) => {
    writes.push([source, patch])
    return { error: null }
  })
  resetMainAdvisorCarrier()
})

afterEach(() => {
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

test('notes a main model without advisor support or a weaker advisor', () => {
  expect(run('opus', 'claude-opus-4-5')).toContain(
    'Note: the current main model (Claude-opus-4-5) does not support the advisor. It will activate when you switch to a supported main model.',
  )
  expect(run('claude-sonnet-4-6', 'claude-opus-5')).toContain(
    'is less capable than the current main model',
  )
})

test('rejects a model that cannot advise without touching state', () => {
  expect(run('claude-opus-4-5')).toBe(getInvalidAdvisorText('claude-opus-4-5'))
  expect(getInvalidAdvisorText('claude-opus-4-5')).toBe(
    'claude-opus-4-5 cannot be used as an advisor. Valid options: fable, opus, sonnet, off',
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
  getMainAdvisorCarrier().held = { model: undefined, refused: true }
  expect(run('opus')).toContain('The API refused the advisor for the current conversation')
  expect(run('off')).toBe('Advisor disabled')
})

test('usage lists the aliases', () => {
  expect(getAdvisorUsageText()).toBe('Usage: /advisor <fable|opus|sonnet|off>')
})

test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL takes the command away', () => {
  expect(advisorCommand.isEnabled()).toBe(true)
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
  expect(advisorCommand.isEnabled()).toBe(false)
  expect(advisorCommand.isHidden).toBe(true)
  expect(advisorNonInteractive.isEnabled()).toBe(false)
})

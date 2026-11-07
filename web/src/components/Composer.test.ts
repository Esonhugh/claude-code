import { describe, expect, it } from 'bun:test'
import { translate } from '../i18n'
import { contextWindowChoices, decoratedRuns, effortChoices, formatWindow, matchApps, matchTargets, modelButtonLabel, pinText, shownModels } from './Composer'
import { nextMode, offeredModes, type T } from './ui'

const t: T = (key, vars) => translate('en', key, vars)

describe('pinText', () => {
  it('names the running todo, else the next one, and says all done only when every todo is', () => {
    const read = { content: 'Read the code', activeForm: 'Reading the code' }
    const write = { content: 'Write tests', activeForm: 'Writing tests' }
    expect(pinText(t, [{ ...read, status: 'completed' }, { ...write, status: 'in_progress' }])).toBe('Writing tests')
    expect(pinText(t, [{ ...read, status: 'completed' }, { ...write, status: 'pending' }])).toBe('Next: Write tests')
    expect(pinText(t, [{ ...read, status: 'pending' }, { ...write, status: 'pending' }])).toBe('Next: Read the code')
    expect(pinText(t, [{ ...read, status: 'completed' }, { ...write, status: 'completed' }])).toBe('All done')
  })
})

describe('permission modes', () => {
  it('offers plan mode only when settings allow it or it is on, like the TUI', () => {
    expect(offeredModes(false).map(m => m.key)).toEqual(['default', 'acceptEdits', 'auto', 'bypassPermissions'])
    expect(offeredModes(false, 'plan').map(m => m.key)).toContain('plan')
    expect(offeredModes(true).map(m => m.key)).toContain('plan')
    expect(nextMode('acceptEdits', false)).toBe('auto')
    expect(nextMode('acceptEdits', true)).toBe('plan')
    expect(nextMode('bypassPermissions')).toBe('default')
  })
})

describe('modelButtonLabel', () => {
  it('names the model a default pick runs: the default row, or the first model of a list without one', () => {
    const claude = [{ value: 'default', displayName: 'Default', resolvedModel: 'opus' }, { value: 'opus', displayName: 'Opus 5.5' }]
    expect(modelButtonLabel('default', undefined, claude, t)).toBe('Opus 5.5')
    // A ChatGPT sign-in lists no default row; its first model is the account's default.
    const openai = [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }, { value: 'gpt-6-astra', displayName: 'GPT-6-Astra' }]
    expect(modelButtonLabel(undefined, undefined, openai, t)).toBe('GPT-6.1-Sol')
    expect(modelButtonLabel('default', 'high', openai, t)).toBe('GPT-6.1-Sol · high')
  })
  it('names the saved model a session started without a pick runs (#946)', () => {
    const openai = [{ value: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }, { value: 'gpt-6-luna', displayName: 'GPT-6-Luna', resolvedModel: 'gpt-6-luna' }]
    expect(modelButtonLabel('default', undefined, openai, t, 'gpt-6-luna')).toBe('GPT-6-Luna')
    const claude = [{ value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5' }, { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' }]
    expect(modelButtonLabel('default', undefined, claude, t, 'claude-sonnet-5-5')).toBe('Sonnet 5.5')
    // An explicit pick still wins.
    expect(modelButtonLabel('gpt-6.1-sol', undefined, openai, t, 'gpt-6-luna')).toBe('GPT-6.1-Sol')
  })
})

describe('effortChoices', () => {
  const models = [
    { value: 'default', displayName: 'Default', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'glm-5.3', displayName: 'GLM-5.3', effortLevels: ['minimal', 'low', 'medium', 'high'] },
    { value: 'gw-plain', displayName: 'Plain' },
  ]
  it("lists the model's levels and keeps a current level it lacks, so the menu matches the chip", () => {
    expect(effortChoices('glm-5.3', models, 'medium')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortChoices('glm-5.3', models, 'xhigh')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(effortChoices(undefined, models, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortChoices('gw-plain', models, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('shownModels', () => {
  const models = ['default', 'opus', 'fable', 'sonnet', 'haiku', 'glm', 'kimi'].map(value => ({ value, displayName: value }))
  it('shows the first four and the current model; the rest wait behind More models', () => {
    expect(shownModels(models, 'opus', false).map(m => m.value)).toEqual(['default', 'opus', 'fable', 'sonnet'])
    expect(shownModels(models, 'kimi', false).map(m => m.value)).toEqual(['default', 'opus', 'fable', 'sonnet', 'kimi'])
    expect(shownModels(models, 'opus', true)).toHaveLength(7)
    expect(shownModels(models.slice(0, 5), undefined, false)).toHaveLength(5)
  })
})

describe('matchTargets', () => {
  const tasks = [
    { id: 'a', name: 'Fix Safari export', detail: 'Running', tag: 'task' },
    { id: 'b', name: 'Write docs', detail: 'Safari notes', tag: 'task' },
    { id: 'c', name: 'Release', detail: 'Done', tag: 'task' },
  ]
  it('lists every target for a bare @, and name matches before detail matches', () => {
    expect(matchTargets(tasks, '').map(x => x.id)).toEqual(['a', 'b', 'c'])
    expect(matchTargets(tasks, 'safari').map(x => x.id)).toEqual(['a', 'b'])
    expect(matchTargets(tasks, 'zzz')).toEqual([])
  })
})

describe('matchApps', () => {
  const apps = [
    { mention: 'gmail', name: 'Gmail' },
    { mention: 'google_drive', name: 'Google Drive', description: 'Files' },
  ]
  it('matches the mention or the name, with or without the codex-app: prefix', () => {
    expect(matchApps(apps, '').map(x => x.mention)).toEqual(['gmail', 'google_drive'])
    expect(matchApps(apps, 'drive').map(x => x.mention)).toEqual(['google_drive'])
    expect(matchApps(apps, 'codex-app:gm').map(x => x.mention)).toEqual(['gmail'])
  })
})

describe('decoratedRuns', () => {
  it('cuts the draft where Mods mark it, the later mark winning an overlap', () => {
    const a = { start: 0, end: 4, color: 'red' }
    const b = { start: 2, end: 6, underline: true }
    expect(decoratedRuns('#123 fix', [a, b])).toEqual([
      { text: '#1', mark: a },
      { text: '23 f', mark: b },
      { text: 'ix' },
    ])
    expect(decoratedRuns('ab', [{ start: -3, end: 99 }])).toEqual([{ text: 'ab', mark: { start: -3, end: 99 } }])
  })
})

describe('context window choices', () => {
  const models = [
    { value: 'default', displayName: 'Default', contextWindowTiers: [128_000, 200_000, 272_000, 500_000, 1_000_000] },
    { value: 'gpt-5.5', displayName: 'GPT', contextWindowTiers: [128_000, 200_000, 272_000] },
    { value: 'small', displayName: 'Small' },
  ]
  it('offers auto, then the model tiers', () => {
    expect(contextWindowChoices('gpt-5.5', models, null)).toEqual([null, 128_000, 200_000, 272_000])
    expect(contextWindowChoices(undefined, models, undefined)).toEqual([null, 128_000, 200_000, 272_000, 500_000, 1_000_000])
    expect(contextWindowChoices('small', models, null)).toEqual([])
  })
  it('keeps a configured window that is not a tier, and shows one above the maximum as the maximum', () => {
    expect(contextWindowChoices('gpt-5.5', models, 150_000)).toEqual([null, 128_000, 150_000, 200_000, 272_000])
    expect(contextWindowChoices('gpt-5.5', models, 1_000_000)).toEqual([null, 128_000, 200_000, 272_000])
  })
  it('labels windows like the TUI', () => {
    expect([128_000, 272_000, 872_000, 1_000_000].map(formatWindow)).toEqual(['128k', '272k', '872k', '1M'])
  })
})

import { describe, expect, it } from 'bun:test'
import { translate } from '../i18n'
import { effortChoices, matchApps, matchTargets, pinText, shownModels } from './Composer'
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

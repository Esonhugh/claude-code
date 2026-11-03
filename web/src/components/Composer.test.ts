import { describe, expect, it } from 'bun:test'
import { translate } from '../i18n'
import { pinText } from './Composer'
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

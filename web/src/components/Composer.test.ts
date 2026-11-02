import { describe, expect, it } from 'bun:test'
import { translate } from '../i18n'
import { pinText } from './Composer'
import type { T } from './ui'

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

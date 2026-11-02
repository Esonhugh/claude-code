import { expect, test } from 'bun:test'
import { formatConfigUsage } from './configNonInteractive.js'

test('/config without arguments lists every key and its values like 2.1.311', () => {
  const row = { label: '', provider: { kind: 'builtin' }, isLocked: false } as const
  expect(
    formatConfigUsage([
      { ...row, key: 'verbose', kind: 'boolean', value: false },
      { ...row, key: 'editor', kind: 'choice', value: 'normal', options: ['normal', 'vim'] },
      { ...row, key: 'language', kind: 'text', value: '' },
    ] as never),
  ).toBe('Usage: /config key=value [key=value ...]\n  editor=normal|vim\n  language=<value>\n  verbose=true|false')
})

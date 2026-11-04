import { describe, expect, test } from 'bun:test'
import { rearrangePipeCommand } from './bashPipeCommand.js'
import { formatShellPrefixCommand } from './shellPrefix.js'
import { quote } from './shellQuote.js'

// shell-quote >= 1.9.0 escapes `~` in bare words, which stops tilde expansion
// in commands we rebuild from the model's own text (#774).
describe('quote keeps ~ expandable in bare words', () => {
  test('bare words', () => {
    expect(quote(['cat', '~/a.txt', 'HEAD~1'])).toBe('cat ~/a.txt HEAD~1')
  })

  test('quoted and backslash forms stay literal', () => {
    expect(quote(['~/my proj'])).toBe("'~/my proj'")
    expect(quote(['a\\~b'])).toBe("'a\\~b'")
    expect(quote(["it's \\~"])).toBe('"it\'s \\\\~"')
  })

  test('pipe commands keep ~ for the shell to expand', () => {
    expect(rearrangePipeCommand('cat ~/a.txt | wc -l')).toBe(
      "'cat ~/a.txt < /dev/null | wc -l'",
    )
  })

  test('shell prefix path starting with ~', () => {
    expect(formatShellPrefixCommand('~/bin/wrap.sh', 'echo hi')).toBe(
      "~/bin/wrap.sh 'echo hi'",
    )
  })
})

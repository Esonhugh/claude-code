import { describe, expect, test } from 'bun:test'
import { HooksSchema } from '../schemas/hooks.js'

describe('hook settings schema', () => {
  test('accepts onFailure on command and HTTP hooks', () => {
    const parsed = HooksSchema().safeParse({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'guard', onFailure: 'block' },
            {
              type: 'http',
              url: 'https://example.com/hook',
              onFailure: 'continue',
            },
          ],
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects an unknown onFailure value', () => {
    const parsed = HooksSchema().safeParse({
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'guard', onFailure: 'deny' }] },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})

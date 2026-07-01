import { describe, expect, test } from 'bun:test'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

describe('execFileNoThrowWithCwd', () => {
  test('honors abortSignal by returning when the signal aborts', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 50)

    const result = await execFileNoThrowWithCwd(
      'bun',
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { abortSignal: controller.signal },
    )

    expect(result.code).not.toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

import { expect, test } from 'bun:test'
import { registerCleanup, runCleanupFunctions } from './cleanupRegistry.js'

test('one failing cleanup does not skip the others (#806)', async () => {
  const ran: string[] = []
  const unregister = [
    registerCleanup(async () => {
      throw new Error('async failure')
    }),
    registerCleanup((() => {
      throw new Error('sync failure')
    }) as unknown as () => Promise<void>),
    registerCleanup(async () => {
      ran.push('flush')
    }),
  ]
  try {
    await runCleanupFunctions()
    expect(ran).toEqual(['flush'])
  } finally {
    for (const fn of unregister) fn()
  }
})

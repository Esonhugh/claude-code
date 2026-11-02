import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { connectToServer } = await import('./client.js')

test('a server with an unparsable url fails with a config hint like 2.1.311', async () => {
  const result = await connectToServer('bad', {
    type: 'http',
    url: 'notaurl',
    scope: 'local',
  })
  expect(result).toMatchObject({
    type: 'failed',
    error: "'url' is not a valid URL. Update the server's config and reconnect.",
  })
})

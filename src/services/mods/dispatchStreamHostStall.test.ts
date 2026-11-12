import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchModStream } from './dispatch.js'
import type { ModDispatchHook } from './types.js'

test('a host stall after a stream hook answered does not turn the answer into a timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-stream-stall-'))
  const file = join(root, 'echo.js')
  await writeFile(file, 'self.onmessage = event => self.postMessage(event.data)')
  // The hook's answer crosses a real Worker, like a plugin hook's does.
  const worker = new Worker(file)
  let asked = 0
  const hook: ModDispatchHook = {
    plugin: 'stall', tier: 'user', registration: { id: 1, event: 'turn.step', hasCatch: false },
    invoke: async () => { throw new Error('stream hook only') },
    // eslint-disable-next-line require-yield -- The hook answers without streaming chunks.
    invokeStream: async function* () {
      const ask = (data: string) => {
        const id = ++asked
        const reply = new Promise(resolve => {
          const answer = (event: MessageEvent) => {
            if (event.data.id !== id) return
            worker.removeEventListener('message', answer)
            resolve(event.data.data)
          }
          worker.addEventListener('message', answer)
        })
        worker.postMessage({ id, data })
        return reply
      }
      await ask('first')
      return { value: await ask('answered') }
    },
  }
  try {
    const results: unknown[] = []
    for (const wait of [0, 1, 2, 3, 5, 8]) {
      const stream = dispatchModStream({
        event: 'turn.step', input: {}, hooks: [hook], budgetMs: 50,
        // eslint-disable-next-line require-yield -- The hook answers without calling next.
        core: async function* () { throw new Error('core should not run') },
      })
      const pending = stream.next().then(item => item.value, (error: Error) => error.message)
      // Stall the host thread past the 50ms budget at different points of the
      // Worker round trip (the hook's own work takes ~1ms).
      if (wait) await new Promise(resolve => setTimeout(resolve, wait)); else await Promise.resolve()
      const until = performance.now() + 120
      while (performance.now() < until) { /* busy host thread */ }
      results.push(await pending)
    }
    expect(results).toEqual(Array(6).fill({ value: 'answered' }))
  } finally {
    worker.terminate()
    await rm(root, { recursive: true, force: true })
  }
})

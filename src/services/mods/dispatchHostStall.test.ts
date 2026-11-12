import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
import { runModPromptEdit } from './promptEdit.js'

test('a host stall after the hook answered does not turn the answer into a timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-stall-'))
  const folder = join(root, 'plugin'), entry = join(folder, 'register.ts')
  await mkdir(folder)
  await writeFile(entry, `export function register(on) {on('prompt.edit',async ($,e,next)=>{const r=await next(e);return {...r,text:r.text.toUpperCase()}})}`)
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    await runtime.reconcile([{ name: 'stall', storageId: 'stall@test', pluginRoot: folder, entrypoints: [entry] }])
    const results: string[] = []
    for (const wait of [0, 1, 2, 3, 5, 8]) {
      const snapshot = runtime.capture()
      const pending = runModPromptEdit(snapshot, { before: { text: 'ab', cursor: 2 }, after: { text: 'abx', cursor: 3 } })
      // Stall the host thread past the 50ms prompt.edit budget at different
      // points of the Worker round trip (the hook's own work takes ~1ms).
      if (wait) await new Promise(resolve => setTimeout(resolve, wait)); else await Promise.resolve()
      const until = performance.now() + 120
      while (performance.now() < until) {}
      results.push((await pending).text)
      snapshot.release()
    }
    expect(results).toEqual(['ABX', 'ABX', 'ABX', 'ABX', 'ABX', 'ABX'])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose(); await rm(root, { recursive: true, force: true })
  }
})

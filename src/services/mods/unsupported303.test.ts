import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePromptDecorations } from './promptEdit.js'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mods-unsupported-303-'))) })
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function load(source: string) {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, source)
  const diagnostics: string[] = []
  runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event.message) })
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'unsupported' })
  await runtime.reconcile([{ name: 'probe', storageId: 'probe@fixture', pluginRoot: root, entrypoints: [entry] }])
  return diagnostics
}

// Declared by the 2.1.303 baseline but not built here: each refuses by name.
test('declared calls this build lacks reject naming the call', async () => {
  expect(await load(`export function register(on){
    on('tool.call', async $ => {
      const errors = [];
      for (const run of [() => $.ui.view({agentId: 'a1'}), () => $.prompt.media({id: 'media_1'}), () => $.audio.play({path: 'x.wav'}), () => $.audio.speak('hi')])
        try { await run() } catch (error) { errors.push(error.message) }
      return {result: errors};
    });
  }`)).toEqual([])
  expect(((await runtime!.dispatch('tool.call', {}, async () => ({ result: 'core' }))) as { result: unknown }).result).toEqual([
    '$.ui.view is not available in this build',
    '$.prompt.media is not available in this build',
    '$.audio.play is not available in this build',
    '$.audio.speak is not available in this build',
  ])
})

test('a prompt.change hook fails the load naming the event, and virtualText names itself', async () => {
  const diagnostics = await load(`export function register(on){ on('prompt.change', ($, e, next) => next(e)); }`)
  expect(diagnostics).toEqual([expect.stringContaining('unsupported core event prompt.change')])
  expect(() => validatePromptDecorations([{ start: 0, end: 0, virtualText: ' hint' }]))
    .toThrow('Prompt decoration virtualText is not available in this build')
})

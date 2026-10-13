import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { createModsRuntime, type ModRequestServices } from './runtime.js'
import { runModPromptSubmit } from './promptAdapter.js'
import { copyModCallerChain } from './callerChain.js'
import * as queue from '../../utils/messageQueueManager.js'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  queue.resetCommandQueue()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Invoke the three exact production producer bodies. Fake only surrounding UI
// and query scheduling, while using the real Worker, queue and prompt adapter.
function producer(path: string): NonNullable<ModRequestServices['submitPrompt']> {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const nodes: ts.PropertyAssignment[] = []
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'submitPrompt' && node.initializer.getText(source).includes('enqueueTracked')) nodes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(nodes).toHaveLength(1)
  const js = ts.transpileModule(`const submit = ${nodes[0]!.initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function('scope', `with(scope) { ${js}; return submit }`).call(
    { promptSubmitOwner: Symbol('owned test consumer') },
    { enqueueTracked: queue.enqueueTracked, remove: queue.remove, randomUUID, copyModCallerChain, logForDebugging: () => {}, run: () => {} },
  )
}

test.each([
  ['engine', '../../QueryEngine.ts'],
  ['headless', '../../cli/print.ts'],
  ['terminal', '../../screens/REPL.tsx'],
])('%s producer carries real Worker history through deferred queue without leaking it publicly', async (_surface, path) => {
  const root = await mkdtemp(join(tmpdir(), 'mods-chain-queue-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const plugins = []
  for (const name of ['earlier', 'sender', 'observer']) {
    const pluginRoot = join(root, name)
    await mkdir(pluginRoot)
    const entry = join(pluginRoot, 'register.ts')
    await writeFile(entry, `export function register(on) {
      ${name === 'sender' ? "on('ui.press', async ($,e) => ({result:await $.prompt.submit(e.input)}));" : ''}
      on('prompt.submit', async ($,e,next) => {
        if ('callerChain' in e || 'promptSubmitCallerChain' in e || 'hookOrigin' in e) throw Error('private input leaked');
        if (next.origin.plugin !== 'sender' || next.origin.tier !== 'user') throw Error('wrong public caller');
        return next({...e,text:e.text+'|'+$.plugin.name});
      });
    }`)
    plugins.push({ name, storageId: `${name}@test`, pluginRoot, entrypoints: [entry] })
  }
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ services: { submitPrompt: producer(path) }, onDiagnostic: event => diagnostics.push(event) })
  cleanups.push(() => runtime.dispose())
  await runtime.reconcile(plugins)
  const ready = Promise.withResolvers<void>()
  const unsubscribe = queue.subscribeToCommandQueue(() => { if (queue.getCommandQueueLength()) ready.resolve() })
  cleanups.push(unsubscribe)
  const submission = runtime.dispatch('ui.press', { input: { text: 'raw', asUser: true, callerChain: ['observer'] } }, async () => ({ result: null }), { callerChain: ['earlier'] })
  void submission.catch(ready.reject)
  await ready.promise
  const [command] = queue.dequeueAll()
  expect(command!.promptSubmitCallerChain).toEqual(['earlier', { plugin: 'sender', registration: 1 }])
  expect(Object.isFrozen(command!.promptSubmitCallerChain)).toBe(true)
  expect(command!.promptSubmitMetadata).toEqual({ origin: { kind: 'plugin', name: 'sender', asUser: true }, wait: false })
  const snapshot = runtime.capture()
  cleanups.push(() => snapshot.release())
  const admitted = await runModPromptSubmit({
    snapshot,
    input: { text: command!.value as string, ...command!.promptSubmitMetadata! },
    callerChain: command!.promptSubmitCallerChain,
    signal: new AbortController().signal,
    core: async () => ({ shouldQuery: true, messages: [] }),
    admit: result => command!.promptSubmitReceipt!.admit(result.admission!),
  } as never)
  expect(admitted.outcome).toEqual({ text: 'raw|sender|observer', origin: { kind: 'plugin', name: 'sender', asUser: true } })
  expect(await submission).toEqual({ result: admitted.outcome })
  expect(admitted.outcome).not.toHaveProperty('callerChain')
  expect(diagnostics).toEqual([])
})

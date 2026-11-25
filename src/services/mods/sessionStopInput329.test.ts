import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueTracked, getCommandQueueSnapshot, resetCommandQueue } from '../../utils/messageQueueManager.js'
import { createModCommandQueue } from './commandRunQueue.js'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-stop-input-')))
})
afterEach(async () => {
  resetCommandQueue()
  await runtime?.dispose()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

const REFUSED = 'the session was stopped and nobody has sent input since'

async function start(source: string, submitted: string[], ran: string[], logs: string[]) {
  const entry = join(root, 'register.mjs')
  await writeFile(entry, source)
  runtime = createModsRuntime({
    services: {
      uiLog: (_plugin, text) => logs.push(text),
      submitPrompt: async input => (submitted.push(input.text), { text: input.text }),
      commands: () => [{ name: 'hello', type: 'prompt', userInvocable: true } as never],
      commandRun: async input => (ran.push(input.command), { text: 'ran' } as never),
    },
  })
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'stop-input' })
  await runtime.reconcile([{ name: 'stopper', storageId: 'stopper@fixture', pluginRoot: root, entrypoints: [entry] }])
  return runtime
}

const tryLog = (call: string) => `try{const r=await ${call};await $.ui.log(r?.drop===undefined?'accepted':'drop: '+r.drop)}catch(error){await $.ui.log(error.name+': '+error.message)}`

test('input a session.stop hook queues is answered with the Stop reason, whether or not a turn is running', async () => {
  const submitted: string[] = [], ran: string[] = [], logs: string[] = []
  const value = await start(
    `export function register(on){on('session.stop',async($,e,next)=>{
      ${tryLog("$.prompt.submit({text:'again'})")}
      ${tryLog("$.command.run({command:'hello',args:''})")}
      return next(e)})}`,
    submitted, ran, logs,
  )
  await value.notifySessionStop(false)
  await value.notifySessionStop(true)
  expect(submitted).toEqual([])
  expect(ran).toEqual([])
  // prompt.submit settles { drop } and command.run rejects, both without a `refused:` prefix (2.1.329).
  const refusals = [`drop: ${REFUSED}`, `HooksError: stopper: $.command.run: ${REFUSED}`]
  expect(logs).toEqual([...refusals, ...refusals])
})

test('plugin input stays refused after a Stop until the person sends input', async () => {
  const submitted: string[] = [], ran: string[] = [], logs: string[] = []
  const value = await start(
    `export function register(on){on('ui.message',async($,e)=>{
      ${tryLog("$.prompt.submit({text:'later'})")}
      ${tryLog("$.command.run({command:'hello',args:''})")}
      return {result:'done'}})}`,
    submitted, ran, logs,
  )
  const call = () => value.dispatch('ui.message', {}, async () => ({ result: 'core' }))
  await value.notifySessionStop(false)
  await call()
  expect(logs).toEqual([`drop: ${REFUSED}`, `HooksError: stopper: $.command.run: ${REFUSED}`])
  value.notePersonInput()
  logs.length = 0
  await call()
  expect(logs).toEqual(['accepted', 'accepted'])
  expect(submitted).toEqual(['later'])
  expect(ran).toEqual(['hello'])
})

test('a Stop takes queued plugin input out of the queue and settles it', async () => {
  const value = await start('export function register(){}', [], [], [])
  const origin = { kind: 'plugin' as const, name: 'stopper' }
  const command = createModCommandQueue()({ command: 'hello', args: '', origin, signal: new AbortController().signal })
  const settled = command.then(() => 'ran', (error: Error) => `${error.name}: ${error.message}`)
  let prompt: unknown
  enqueueTracked({
    value: 'queued', mode: 'prompt', priority: 'later', origin,
    promptSubmitMetadata: { origin, wait: false },
    promptSubmitReceipt: { admit: result => { prompt = result }, cancel: () => {} },
  })
  enqueueTracked({ value: 'typed', mode: 'prompt', priority: 'later' })
  enqueueTracked({ value: 'sub-agent', mode: 'prompt', priority: 'later', origin, agentId: 'a1' as never })
  await value.notifySessionStop(true)
  expect(prompt).toEqual({ drop: 'the prompt was removed from the queue before it ran' })
  expect(await settled).toBe('HooksError: the command was removed from the queue before it ran')
  expect(getCommandQueueSnapshot().map(queued => queued.value)).toEqual(['typed', 'sub-agent'])
})

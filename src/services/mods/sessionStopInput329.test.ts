import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-stop-input-')))
})
afterEach(async () => {
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

const tryLog = (call: string) => `try{await ${call};await $.ui.log('accepted')}catch(error){await $.ui.log(error.message)}`

test('input a session.stop hook queues is refused, whether or not a turn is running', async () => {
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
  const refusals = [`stopper: $.prompt.submit: refused: ${REFUSED}`, `stopper: $.command.run: refused: ${REFUSED}`]
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
  expect(logs).toEqual([`stopper: $.prompt.submit: refused: ${REFUSED}`, `stopper: $.command.run: refused: ${REFUSED}`])
  value.notePersonInput()
  logs.length = 0
  await call()
  expect(logs).toEqual(['accepted', 'accepted'])
  expect(submitted).toEqual(['later'])
  expect(ran).toEqual(['hello'])
})

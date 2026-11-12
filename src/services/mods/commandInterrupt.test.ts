import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import { processSlashCommand } from '../../utils/processUserInput/processSlashCommand.js'
import { INTERRUPT_MESSAGE } from '../../utils/messages.js'
import { createModsRuntime } from './runtime.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime>
let started: ReturnType<typeof Promise.withResolvers<void>>
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'command-interrupt-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-command-interrupt-fixture'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  started = Promise.withResolvers<void>()
  runtime = createModsRuntime({ services: { uiLog: (_plugin, text) => { if (text === 'started') started.resolve() } } })
})
afterEach(async () => {
  await runtime.dispose()
  for (const [index, key] of keys.entries()) {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  }
  await rm(root, { recursive: true, force: true })
})

test('interrupting a running Mod command keeps its input line and shows it was interrupted', async () => {
  const entry = join(root, 'slow.mjs')
  await writeFile(entry, `export function register(on){
    on('session.start',async($,e,next)=>{await $.command.register({name:'slow',description:'slow'});return next(e)})
    on('command.run',{command:'slow'},async($)=>{$.ui.log('started',{to:'debug'});await new Promise(()=>{})})
  }`)
  await runtime.bind({ cwd: root, surface: null, isInteractive: false, sessionId: 'interrupt' })
  await runtime.reconcile([{ name: 'slow', storageId: 'slow@fixture', pluginRoot: root, entrypoints: [entry] }])
  const abortController = new AbortController()
  const context = {
    options: { commands: runtime.commands.list(), tools: [], isNonInteractiveSession: true, mcpResources: {} }, abortController, messages: [],
    getAppState: () => ({ sessionState: { sessionHooks: {} }, fileHistory: { snapshots: [] } }), setAppState() {},
    modCommand: { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } },
  } as unknown as ProcessUserInputContext
  const pending = processSlashCommand('/slow', [], [], [], context, () => {})
  await started.promise
  abortController.abort('interrupt')
  const result = await pending
  const texts = result.messages.map(message => message.type === 'user' ? JSON.stringify(message.message.content) : message.type)
  expect(texts.some(text => text.includes('<command-name>/slow</command-name>'))).toBe(true)
  expect(texts.some(text => text.includes(INTERRUPT_MESSAGE))).toBe(true)
})

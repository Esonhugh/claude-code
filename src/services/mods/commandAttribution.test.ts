import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command, LocalJSXCommandOnDone } from '../../types/command.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import { processSlashCommand } from '../../utils/processUserInput/processSlashCommand.js'
import { dequeue, resetCommandQueue } from '../../utils/messageQueueManager.js'
import { createModsRuntime } from './runtime.js'
import type { ModDispatchHook } from './types.js'
import { runModCommand, runImmediateModCommand } from './commandAdapter.js'
import { commandRunReceipt, createModCommandQueue } from './commandRunQueue.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime>
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'command-attribution-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-command-attribution-fixture'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  runtime = createModsRuntime()
})
afterEach(async () => {
  resetCommandQueue()
  await runtime.dispose()
  for (const [index, key] of keys.entries()) {
    if (saved[index] === undefined) delete process.env[key]
    else process.env[key] = saved[index]
  }
  await rm(root, { recursive: true, force: true })
})
const command: Command = {
  type: 'local', name: 'fixture', description: 'fixture', supportsNonInteractive: true,
  load: async () => ({ call: async () => ({ type: 'text', value: 'host' }) }),
}
const input = { command: 'fixture', args: '', origin: { kind: 'composer' } as const, presentation: { isFullscreen: false, columns: 80 } }
function add(plugin: string, invoke: ModDispatchHook['invoke'], options: {tier?: ModDispatchHook['tier']; matcher?: {command: string}; id?: number} = {}) {
  runtime.registerHostHook({ plugin, tier: options.tier ?? 'user',
    registration: { id: options.id ?? 1, event: 'command.run', hasCatch: false, ...(options.matcher ? {matcher: options.matcher} : {}) }, invoke })
}
async function execute(origin = input.origin as {kind:'composer'} | {kind:'plugin';name:string}, coreText = 'host') {
  const snapshot = runtime.capture()
  try {
    return await runModCommand({ snapshot, input: {...input, origin}, command,
      core: async () => ({ command, messages: [], shouldQuery: false, resultText: coreText }) })
  } finally { snapshot.release() }
}

// Official 2.1.292 native matrix (single/chain/short/origin/long) and Ryn: prefix matched module names on display, settle fne with raw G.text.
test('a synthetic author answer is prefixed for display while its receipt retains raw text, context and status', async () => {
  add('provider', async () => ({ text: 'raw\nsecond line', context: ['hidden'], exitCode: 7 }))
  const result = await execute()
  expect(result.resultText).toBe('provider: raw\nsecond line')
  expect(result.messages.at(-2)).toMatchObject({content: '<local-command-stdout>provider: raw\nsecond line</local-command-stdout>'})
  expect(commandRunReceipt(result)).toEqual({ text: 'raw\nsecond line', context: ['hidden'], exitCode: 7 })
})
test('attribution lists matching modules once, including uncalled inner and sender hooks, and excludes nonmatching hooks', async () => {
  add('sender', async (event, next) => next(event))
  add('outer', async () => ({ text: 'short' }))
  let inner = 0
  add('inner', async (_event, next) => { inner++; return next(_event) }, {matcher:{command:'fixture'}})
  add('inner', async (_event, next) => { inner++; return next(_event) }, {id:2})
  add('mismatch', async () => { throw new Error('wrong command') }, {matcher:{command:'other'}})
  const result = await execute({kind:'plugin',name:'sender'})
  expect(result.resultText).toBe('sender+outer+inner: short')
  expect(commandRunReceipt(result)).toEqual({text:'short'})
  expect(inner).toBe(0)
})
test('builtin-only answers retain their display, but a user and builtin match both appear in attribution', async () => {
  add('builtin', async () => ({ text:'raw' }), {tier:'builtin'})
  expect((await execute()).resultText).toBe('raw')
  add('user', async (_event, next) => next(_event))
  const result = await execute()
  expect(result.resultText).toBe('builtin+user: raw')
  expect(commandRunReceipt(result)).toEqual({text:'raw'})
})
test('explicit unchanged execution refs keep host display; changed or omitted refs use author attribution', async () => {
  let mode: 'same' | 'changed' | 'unselected' = 'same'
  add('provider', async (event, next) => {
    const result = await next(event) as {text?:string;ref:number}
    if (mode === 'same') return result
    return mode === 'changed' ? {...result,text:'new'} : {text:result.text}
  })
  expect((await execute()).resultText).toBe('host')
  mode = 'changed'
  let result = await execute()
  expect(result.resultText).toBe('provider: new')
  expect(commandRunReceipt(result)).toEqual({text:'new'})
  mode = 'unselected'
  result = await execute()
  expect(result.resultText).toBe('provider: host')
  expect(commandRunReceipt(result)).toEqual({text:'host'})
})
test('empty answers receive attribution and absent text remains silent', async () => {
  let text: string | undefined = ''
  add('provider', async () => ({text}))
  let result = await execute()
  expect(result.resultText).toBe('provider: ')
  expect(commandRunReceipt(result)).toEqual({text:''})
  text = undefined
  result = await execute()
  expect(result.resultText).toBeUndefined()
  expect(result.messages).toEqual([])
  expect(commandRunReceipt(result)).toEqual({text:undefined})
})
test('long and multiline module names use the shared official display-name formatter, without sanitizing answer text', async () => {
  add('provider-with-a-very-long-name', async () => ({text:'raw\nnext'}))
  const result = await execute()
  expect(result.resultText).toBe('provider-with-a-very-lo…: raw\nnext')
})
test('a real registered Worker command preserves the raw author receipt through the normal slash executor', async () => {
  const entry=join(root,'provider.mjs')
  await writeFile(entry, `export function register(on){on('session.start',async($,e,next)=>{await $.command.register({name:'fixture',description:'fixture'});return next(e)});on('command.run',{command:'fixture'},async()=>({text:'RAW',context:['hidden'],exitCode:7}))}`)
  await runtime.bind({cwd:root,surface:null,isInteractive:false,sessionId:'attribution'})
  await runtime.reconcile([{name:'provider',storageId:'provider@fixture',pluginRoot:root,entrypoints:[entry]}])
  const pending=createModCommandQueue()({command:'fixture',args:'',origin:{kind:'plugin',name:'sender'},signal:new AbortController().signal})
  const queued=dequeue(()=>true)!
  const context={options:{commands:runtime.commands.list(),tools:[],isNonInteractiveSession:true,mcpResources:{}},abortController:new AbortController(),messages:[],
    getAppState:()=>({sessionState:{sessionHooks:{}},fileHistory:{snapshots:[]}}),setAppState(){},modCommand:{origin:{kind:'plugin',name:'sender'},presentation:input.presentation}} as unknown as ProcessUserInputContext
  const result=await processSlashCommand(queued.value as string,[],[],[],context,()=>{})
  queued.commandRunReceipt!.admit(result)
  expect(result.resultText).toBe('provider: RAW')
  expect(result.messages.some(message=>message.type==='user' && message.message.content==='<local-command-stdout>provider: RAW</local-command-stdout>')).toBe(true)
  expect(await pending).toEqual({text:'RAW',context:['hidden'],exitCode:7})
})
test('the immediate command path preserves raw receipt metadata alongside the displayed answer', async () => {
  add('provider', async (event,next)=>({...await next(event) as object,text:'new'}))
  const local:Command={type:'local-jsx',name:'fixture',description:'fixture',immediate:true,load:async()=>({call:async done=>{done('host');return null}})}
  const completions:Parameters<LocalJSXCommandOnDone>[]=[]
  const context={abortController:new AbortController(),mods:{capture:runtime.capture},modCommand:{origin:input.origin,presentation:input.presentation}} as unknown as Parameters<typeof runImmediateModCommand>[2]
  await runImmediateModCommand(local,(...args)=>completions.push(args),context,'')
  expect(completions).toEqual([['provider: new',{commandRunText:'new'}]])
})

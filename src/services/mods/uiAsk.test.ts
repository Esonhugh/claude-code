import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { createModsRuntime } from './runtime.js'
import { createModToolHost } from './toolHost.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys = ['HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
let saved: (string | undefined)[]
beforeEach(async () => {
  saved = keys.map(key => process.env[key])
  root = await realpath(await mkdtemp(join(tmpdir(), 'mods-ui-ask-')))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.ANTHROPIC_API_KEY = 'sk-ui-ask-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]
    else process.env[key] = saved[i]
  })
  await rm(root, { recursive: true, force: true })
})

async function setup(body: string, canUseTool?: CanUseToolFn, observer?: string) {
  const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }
  const context = {
    options: { tools: [AskUserQuestionTool], mcpClients: [], isNonInteractiveSession: false },
    abortController: new AbortController(), messages: [],
    getAppState: () => state, setAppState: () => {}, setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
  const diagnostics: unknown[] = []
  runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: canUseTool ? { toolHost: () => createModToolHost(context, canUseTool) } : {} })
  context.mods = runtime
  await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: !!canUseTool, sessionId: 'ui-ask' })
  const sender = join(root, 'sender.mjs')
  await writeFile(sender, `export function register(on){on('tool.call',async($,e)=>{
    if(e.tool==='AskUserQuestion')return {deny:'the calling hook was not excluded'};
    ${body}
  });}`)
  const inputs = [{ name: 'sender', storageId: 'sender@fixture', pluginRoot: root, entrypoints: [sender] }]
  if (observer) {
    const entry = join(root, 'observer.mjs')
    await writeFile(entry, `export function register(on){on('tool.call',{tool:'AskUserQuestion'},${observer});}`)
    inputs.push({ name: 'observer', storageId: 'observer@fixture', pluginRoot: root, entrypoints: [entry] })
  }
  await runtime.reconcile(inputs)
  return { context, runtime, diagnostics, dispatch: (signal?: AbortSignal) => runtime!.dispatch('tool.call', { tool: 'Start', tool_use_id: 'ask-entry' }, async () => ({ result: 'missed' }), { signal }) }
}

// Official 2.1.292 measured with eight calls from a headless session.start hook.
test('ui.ask matches official argument errors and the missing headless tool error', async () => {
  const f = await setup(`const values=[];
    for(const args of [['Question?'],['Question?',['A','B']],['Question?',{options:['A'],header:'Approach',multiSelect:true}],[],[' '],[{}],['Question?',{options:'bad'}],['Question?',['A','B','C','D','E']]]){
      try{await $.ui.ask(...args)}catch(error){values.push({name:error.name,error:String(error)})}
    }return {result:values};`)
  const missing = { name: 'HooksError', error: 'HooksError: sender: $.tool.call: no tool named "AskUserQuestion" in this session' }
  const question = { name: 'HooksError', error: 'HooksError: sender: $.ui.ask takes the question first' }
  expect(await f.dispatch()).toEqual({ result: [missing, missing, missing, question, question, question,
    { name: 'HooksError', error: 'HooksError: sender: $.ui.ask takes its options as a list' },
    { name: 'HooksError', error: 'HooksError: sender: $.ui.ask takes at most 4 options (got 5)' },
  ] })
})

test('headless ui.ask never executes AskUserQuestion even when the host catalog contains it', async () => {
  let permissions = 0
  const canUseTool: CanUseToolFn = async () => { permissions++; return { behavior: 'allow' } }
  const f = await setup(`try{await $.ui.ask('Question?')}catch(error){return {result:String(error)}};return {result:'unexpected'};`, canUseTool)
  await f.runtime.bind({ cwd: root, surface: 'terminal', isInteractive: false, sessionId: 'ui-ask' })
  expect(await f.dispatch()).toEqual({ result: 'HooksError: sender: $.tool.call: no tool named "AskUserQuestion" in this session' })
  expect(permissions).toBe(0)
})

test('ui.ask uses the real tool executor, middleware and permissions and restores the original label', async () => {
  const inputs: Record<string, unknown>[] = []
  const canUseTool: CanUseToolFn = async (_tool, input) => {
    inputs.push(input as Record<string, unknown>)
    const question = (input as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
    return { behavior: 'allow', updatedInput: { ...input, answers: { [question.question]: question.options[0]!.label } } }
  }
  const f = await setup(`const chosen=await $.ui.ask('Pick\\ud800?',{options:['A\\ud800','B'],header:'12345678901😀tail',multiSelect:true});
    const padding=await $.ui.ask('Default?');let direct;
    try{await $.tool.call({tool:'AskUserQuestion',questions:[],entry:'ui.ask'})}catch(error){direct=String(error)}
    return {result:{chosen,padding,direct}};`, canUseTool,
    `async($,e,next)=>next({...e,questions:e.questions.map(q=>({...q,options:q.options.map(o=>({...o,description:'from observer'}))}))})`)
  const value = await f.dispatch()
  expect(value).toEqual({ result: {
    chosen: 'A\ud800', padding: 'Yes',
    direct: 'Error: sender: tool.call: runs the AskUserQuestion tool: that is $.ui.ask (host check)',
  } })
  expect(inputs).toHaveLength(2)
  expect(inputs[0]).toMatchObject({ questions: [{
    question: 'Pick�?', header: '12345678901', multiSelect: true,
    options: [{ label: 'A�', description: 'from observer' }, { label: 'B', description: 'from observer' }],
  }] })
  expect(inputs[1]).toMatchObject({ questions: [{
    question: 'Default?', header: 'Plugin', multiSelect: false,
    options: [{ label: 'Yes', description: 'from observer' }, { label: 'No', description: 'from observer' }],
  }] })
})

test('ui.ask returns hook-provided multi-select text and a veto never opens a dialog', async () => {
  let permissions = 0
  const canUseTool: CanUseToolFn = async () => { permissions++; return { behavior: 'allow' } }
  const f = await setup(`const chosen=await $.ui.ask('Many?',{options:['A\\ud800','B'],multiSelect:true});let denied;
    try{await $.ui.ask('Denied?')}catch(error){denied=String(error)}
    return {result:{chosen,denied}};`, canUseTool,
    // Official 2.1.292 measured: array answers fail the tool output shape; answers are strings with questions retained.
    `async($,e)=>e.questions[0].question==='Denied?'?{deny:'withheld by observer'}:{result:{questions:e.questions,answers:{'Many?':'A�, Other free text'}}}`)
  const value = await f.dispatch()
  expect(f.diagnostics).toEqual([])
  expect(value).toEqual({ result: {
    chosen: 'A�, Other free text',
    denied: 'HooksError: sender: $.ui.ask: no answer (withheld by observer)',
  } })
  expect(permissions).toBe(0)
})

test('the trusted ui.ask door cannot bypass the Agent tool refusal', async () => {
  let permissions = 0
  const canUseTool: CanUseToolFn = async () => { permissions++; return { behavior: 'allow' } }
  const f = await setup(`return {result:'unused'};`, canUseTool)
  const snapshot = f.runtime.capture()
  try {
    await expect(createModToolHost(f.context, canUseTool).call(
      { tool: 'Agent', prompt: 'must not run' }, snapshot, new AbortController().signal, 'sender', 'ui.ask',
    )).rejects.toThrow('$.agent.spawn')
    expect(permissions).toBe(0)
  } finally { snapshot.release() }
})

test('ui.ask preserves caller cancellation while the real permission handler is pending', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const canUseTool: CanUseToolFn = async (_tool, _input, context) => {
    const signal = context.abortController.signal
    started.resolve(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (signal.aborted) reject(signal.reason)
    })
  }
  const f = await setup(`return {result:await $.ui.ask('Pending?',['A','B'])};`, canUseTool)
  const controller = new AbortController()
  const pending = f.dispatch(controller.signal)
  const rejected = expect(pending).rejects
  const signal = await started.promise
  const reason = new Error('caller cancelled the question')
  controller.abort(reason)
  await rejected.toBe(reason)
  expect(signal.reason).toBe(reason)
})

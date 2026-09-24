import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { query, type QueryParams } from './query.js'
import type { Tool, ToolUseContext } from './Tool.js'
import { asAgentId } from './types/ids.js'
import type { AssistantMessage, Message } from './types/message.js'
import { createModsRuntime, type ModSnapshot } from './services/mods/runtime.js'
import { createAssistantMessage, handleMessageFromStream, normalizeMessagesForAPI, type StreamingThinking } from './utils/messages.js'
import {
  asSystemPrompt,
  getSystemPromptSections,
  withSystemPromptSections,
} from './utils/systemPromptType.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import { resetStateForTests } from './bootstrap/state.js'
import { createModTurnCompletion } from './services/mods/turnAdapter.js'
import { createSystemMessage, createCompactBoundaryMessage, createUserMessage } from './utils/messages.js'
import { prependUserContext } from './utils/api.js'
import { createAttachmentMessage, memoryFilesToAttachments } from './utils/attachments.js'
import { getUserContextInstructionFiles, withUserContextInstructionFiles } from './context.js'
import { reconcilePromptContext } from './services/mods/promptContext.js'

function response(id: string, text: string, input = 10, output = 2): AssistantMessage {
  const message = createAssistantMessage({ content: text })
  Object.assign(message.message, {
    id, model: 'claude-test', stop_reason: 'end_turn',
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  })
  return message
}

async function* streamedResponse(id: string, text: string): AsyncGenerator<AssistantMessage | import('./types/message.js').StreamEvent> {
  const completed = response(id, text, 10, 0)
  completed.message.stop_reason = null
  yield {type:'stream_event',event:{type:'message_start',message:{...completed.message,content:[]}}} as any
  yield {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}}
  yield {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}}
  // claude.ts emits the assembled block before forwarding content_block_stop.
  yield completed
  yield {type:'stream_event',event:{type:'content_block_stop',index:0}}
  completed.message.usage = {...completed.message.usage,output_tokens:9}
  completed.message.stop_reason = 'end_turn'
  yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:9}}} as any
  yield {type:'stream_event',event:{type:'message_stop'}}
}

function harness(callModel: NonNullable<QueryParams['deps']>['callModel']) {
  const calls: Array<{ event: string; input: any; result: any; options: any }> = []
  const order: string[] = []
  let rewrite: ((result: any, input: any) => any) | undefined
  let failure: Error | undefined
  const snapshot: ModSnapshot = {
    hasHooks: event => event === 'turn.complete',
    release: () => { order.push('release') },
    dispatch: async (event, input, core, options) => {
      order.push('dispatch')
      const call = { event, input, result: undefined as any, options }
      calls.push(call)
      if (failure) throw failure
      const result = await core(input)
      call.result = result
      const modified = rewrite ? rewrite(result, input) : result
      options?.validateResult?.(modified, [result])
      return modified
    },
  }
  let appState = getDefaultAppState()
  const context = {
    options: {
      commands: [], debug: false, mainLoopModel: 'claude-test', tools: [], verbose: false,
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => appState, setAppState: (update: any) => { appState = update(appState) },
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    messages: [],
    mods: { capture: () => { order.push('capture'); return snapshot }, hasHooks: snapshot.hasHooks },
  } as unknown as ToolUseContext
  let activeTurnId: string | undefined
  context.mods = {
    ...context.mods,
    beginPublicTurn(turnId: string) {
      activeTurnId = turnId
      return () => {
        if (activeTurnId === turnId) activeTurnId = undefined
      }
    },
    get activePublicTurnId() { return activeTurnId },
  } as unknown as ToolUseContext['mods']
  const params: QueryParams = {
    messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'answer' } }],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), toolUseContext: context,
    querySource: 'repl_main_thread',
    deps: { uuid: randomUUID, microcompact: async messages => ({ messages }),
      autocompact: async messages => ({ messages, wasCompacted: false }), callModel },
  }
  return { params, context, snapshot, calls, order,
    rewrite: (fn: typeof rewrite) => { rewrite = fn }, fail: (error: Error) => { failure = error } }
}

async function drain(iterator: ReturnType<typeof query>) {
  const messages: any[] = []
  while (true) {
    const step = await iterator.next()
    if (step.done) return { messages, terminal: step.value }
    messages.push(step.value)
  }
}

// Exercise control completions with an injected loop, but execute the exact
// public wrapper from query.ts rather than reimplementing its lifecycle.
const source = readFileSync(new URL('./query.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('query.ts', source, ts.ScriptTarget.Latest, true)
const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'query')!
const wrapperJS = ts.transpileModule(wrapper.getText(ast).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
}).outputText
function isolatedWrapper(loop: (...args: any[]) => AsyncGenerator<any, any>, diagnostics: any[], lifecycle: any[]) {
  return new Function('scope', `with (scope) { ${wrapperJS}; return query; }`)({
    queryLoop: loop, createModTurnCompletion, randomUUID, createSystemMessage,
    notifyCommandLifecycle: (...args: any[]) => lifecycle.push(args),
    logError: (error: any) => diagnostics.push(error), logForDebugging: (text: string) => diagnostics.push(text),
  }) as typeof query
}

afterEach(resetStateForTests)

test('turn.step drops every model text block without manufacturing assistant history', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-drop-'))
  const diagnostics:unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let completion; export function register(on) {
      on('turn.step',async function* ($,e,next) {const s=next(e);for await(const c of s) if(c.kind!=='text') yield c;return {...await s.result,answer:'RETURN_ONLY'}});
      on('turn.complete',($,e,next)=>{completion=e;return next(e)});
      on('tool.call',()=>({result:completion}));
    }`)
    await runtime.reconcile([{name:'drop',storageId:'drop@inline',pluginRoot:root,entrypoints:[entry]}])
    const h=harness(async function* () {yield* streamedResponse('drop','DROP_EVERYTHING')})
    h.context.mods=runtime
    const run=await drain(query(h.params))
    expect(run.messages.filter(m=>m.type==='assistant')).toEqual([])
    expect(JSON.stringify(run.messages)).not.toContain('DROP_EVERYTHING')
    expect(JSON.stringify(run.messages)).not.toContain('RETURN_ONLY')
    const {result}=await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:any}
    expect(result).toMatchObject({answer:'',usage:{output_tokens:9}})
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step request overrides resolve effort once without changing later steps or session state', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-effort-'))
  const diagnostics:unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  const previous=process.env.CLAUDE_CODE_EFFORT_LEVEL
  process.env.CLAUDE_CODE_EFFORT_LEVEL='high'
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let inputs=[]; export function register(on) {
      on('turn.step',async function* ($,e,next) {
        inputs.push(e);const s=next({...e,model:'override-model',effort:undefined});
        for await(const c of s) yield c;return await s.result;
      });
      on('tool.call',()=>({result:inputs}));
    }`)
    await runtime.reconcile([{name:'effort',storageId:'effort@inline',pluginRoot:root,entrypoints:[entry]}])
    const requests:any[]=[]
    const h=harness(async function* (request) {
      requests.push(request)
      if(requests.length===1) {
        const message=response('limit','partial');Object.assign(message,{apiError:'max_output_tokens',isApiErrorMessage:true});yield message
      } else yield* streamedResponse('effort','done')
    })
    h.context.mods=runtime
    h.context.setAppState(state=>({...state,effortValue:'low'}))
    await drain(query(h.params))
    expect(requests.map(r=>r.options)).toEqual([expect.objectContaining({model:'override-model',effortValue:undefined,effortResolved:true}),expect.objectContaining({model:'override-model',effortValue:undefined,effortResolved:true})])
    const {result:inputs}=await runtime.dispatch('tool.call',{},async()=>({result:[]})) as {result:any[]}
    expect(inputs.map(e=>({model:e.model,effort:e.effort}))).toEqual([{model:'claude-test',effort:'high'},{model:'claude-test',effort:'high'}])
    expect(h.context.options.mainLoopModel).toBe('claude-test')
    expect(h.context.getAppState().effortValue).toBe('low')
    expect(diagnostics).toEqual([])
  } finally {
    if(previous===undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL=previous
    await runtime.dispose();await rm(root,{recursive:true,force:true})
  }
})

test('turn.step text reaches the consumer before the fake model finishes its response', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-live-'))
  const runtime=createModsRuntime()
  let iterator:ReturnType<typeof query>|undefined
  let sourceFinished=false
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step',async function* ($,e,next) {const s=next(e);for await(const c of s) yield c.kind==='text'?{...c,text:'LIVE'}:c;return await s.result});
    }`)
    await runtime.reconcile([{name:'live',storageId:'live@inline',pluginRoot:root,entrypoints:[entry]}])
    const h=harness(async function* () {yield* streamedResponse('live','raw');sourceFinished=true})
    h.context.mods=runtime
    iterator=query(h.params)
    let item=await iterator.next()
    while(!item.done && !(item.value.type==='stream_event'&&(item.value.event as any)?.delta?.type==='text_delta')) item=await iterator.next()
    expect(item.done).toBe(false)
    expect((item.value as any).event.delta.text).toBe('LIVE')
    expect(sourceFinished).toBe(false)
    await drain(iterator)
    expect(sourceFinished).toBe(true)
  } finally {await iterator?.return({reason:'cleanup'});await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step stop rewrite reaches streamed and recorded metadata without changing next result', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-stop-'))
  const diagnostics:unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let result; export function register(on) {
      on('turn.step',async function* ($,e,next) {
        const s=next(e);for await(const c of s) yield c.kind==='stop'?{...c,stopReason:'stop_sequence',usage:{model:'rewrite-usage',input_tokens:21,output_tokens:34,cache_read_input_tokens:0,cache_creation_input_tokens:0}}:c;
        result=await s.result;return result;
      });
      on('tool.call',()=>({result}));
    }`)
    await runtime.reconcile([{name:'stop',storageId:'stop@inline',pluginRoot:root,entrypoints:[entry]}])
    const h=harness(async function* () {yield* streamedResponse('stop','answer')})
    h.context.mods=runtime
    const run=await drain(query(h.params))
    const message=run.messages.find(m=>m.type==='assistant')
    expect(message.message).toMatchObject({stop_reason:'stop_sequence',model:'rewrite-usage',usage:{input_tokens:21,output_tokens:34}})
    expect(run.messages.find(m=>m.type==='stream_event'&&m.event.type==='message_delta').event).toMatchObject({delta:{stop_reason:'stop_sequence'},usage:{input_tokens:21,output_tokens:34}})
    const {result}=await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:any}
    expect(result).toMatchObject({stopReason:'end_turn',usage:{model:'claude-test',input_tokens:10,output_tokens:9}})
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

for (const ending of ['close','abort'] as const) test(`turn.step ${ending} cleans up model iterator and snapshot`, async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-cancel-'))
  const runtime=createModsRuntime()
  let iterator:ReturnType<typeof query>|undefined
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step',async function* ($,e,next) {const s=next(e);for await(const c of s) yield c;return await s.result});
    }`)
    await runtime.reconcile([{name:'cancel',storageId:'cancel@inline',pluginRoot:root,entrypoints:[entry]}])
    let closed=false,released=0
    const capture=runtime.capture
    runtime.capture=services=>{const s=capture(services);return {...s,release(){released++;s.release()}}}
    const h=harness(async function* () {try {yield* streamedResponse('cancel','partial')} finally {closed=true}})
    h.context.mods=runtime
    iterator=query(h.params)
    let item=await iterator.next()
    while(!item.done && !(item.value.type==='stream_event'&&(item.value.event as any)?.type==='content_block_delta')) item=await iterator.next()
    expect(item.done).toBe(false)
    if(ending==='close') await iterator.return({reason:'consumer-return'})
    else {h.context.abortController.abort(new Error('cancel model step'));await drain(iterator)}
    expect(closed).toBe(true)
    expect(released).toBe(1)
  } finally {await iterator?.return({reason:'cleanup'});await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step preserves model fallback errors and increments the retry step', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-fallback-'))
  const diagnostics:unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let inputs=[]; export function register(on) {
      on('turn.step',async function* ($,e,next) {inputs.push(e);const s=next(e);for await(const c of s) yield c;return await s.result});
      on('tool.call',()=>({result:inputs}));
    }`)
    await runtime.reconcile([{name:'fallback',storageId:'fallback@inline',pluginRoot:root,entrypoints:[entry]}])
    const {FallbackTriggeredError}=await import('./services/api/withRetry.js')
    let calls=0
    const h=harness(async function* () {
      if(++calls===1) throw new FallbackTriggeredError('claude-test','fallback-model')
      yield* streamedResponse('fallback','recovered')
    })
    h.context.mods=runtime
    h.params.fallbackModel='fallback-model'
    const run=await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(calls).toBe(2)
    const {result:inputs}=await runtime.dispatch('tool.call',{},async()=>({result:[]})) as {result:any[]}
    expect(inputs.map(e=>({index:e.index,model:e.model}))).toEqual([{index:0,model:'claude-test'},{index:1,model:'fallback-model'}])
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step hook can call $.turn.step inside the active real query request', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-capability-'))
  const diagnostics:unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step',async function* ($,e) {
        const s=$.turn.step({...e,model:'capability-model',effort:'medium'});
        for await(const c of s) yield c.kind==='text'?{...c,text:'CAPABILITY_OUTPUT'}:c;
        return await s.result;
      });
    }`)
    await runtime.reconcile([{name:'capability',storageId:'capability@inline',pluginRoot:root,entrypoints:[entry]}])
    const requests:any[]=[]
    const h=harness(async function* (request) {requests.push(request);yield* streamedResponse('capability','raw')})
    h.context.mods=runtime
    const run=await drain(query(h.params))
    expect(requests).toHaveLength(1)
    expect(requests[0].options).toMatchObject({model:'capability-model',effortValue:'medium',effortResolved:true})
    expect(run.messages.filter(m=>m.type==='assistant').flatMap(m=>m.message.content)).toEqual([{type:'text',text:'CAPABILITY_OUTPUT'}])
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test.each([false, true])('turn.step repeated next keeps both response envelopes (streaming=%s)', async streaming => {
  const root = await mkdtemp(join(tmpdir(), 'mods-step-repeated-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step', async function* ($, e, next) {
        yield* next(e);
        return yield* next(e);
      });
    }`)
    await runtime.reconcile([{name:'repeated',storageId:'repeated@inline',pluginRoot:root,entrypoints:[entry]}])
    let calls = 0
    const h = harness(async function* () {
      const id = `response-${++calls}`
      if (streaming) yield* streamedResponse(id, id)
      else yield response(id, id)
    })
    h.context.mods = runtime
    const run = await drain(query(h.params))
    expect(calls).toBe(2)
    const messages = run.messages.filter(message => message.type === 'assistant')
    expect(messages.map(message => message.message.id)).toEqual(['response-1', 'response-2'])
    expect(messages.flatMap(message => message.message.content)).toEqual([
      {type:'text',text:'response-1'}, {type:'text',text:'response-2'},
    ])
    const events = run.messages.filter(message => message.type === 'stream_event').map(message => message.event.type)
    expect(events.filter(type => type === 'message_start')).toHaveLength(2)
    expect(events.filter(type => type === 'message_stop')).toHaveLength(2)
  } finally { await runtime.dispose(); await rm(root, {recursive:true,force:true}) }
})

test('turn.step completed-only response retains one envelope and distinct block identities', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-blocks-'))
  const runtime=createModsRuntime()
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let complete; export function register(on) {
      on('turn.step',async function* ($,e,next) {const s=next(e);for await(const c of s) yield c;return await s.result});
      on('turn.complete',($,e,next)=>{complete=e;return next(e)});
      on('tool.call',()=>({result:complete}));
    }`)
    await runtime.reconcile([{name:'blocks',storageId:'blocks@inline',pluginRoot:root,entrypoints:[entry]}])
    const h=harness(async function* () {
      const message=response('multi-block','first')
      message.message.content.push({type:'text',text:'second'})
      yield message
    })
    h.context.mods=runtime
    const run=await drain(query(h.params))
    const messages=run.messages.filter(m=>m.type==='assistant')
    const start=run.messages.find(m=>m.type==='stream_event'&&m.event.type==='message_start')
    expect(new Set(messages.map(m=>m.uuid)).size).toBe(2)
    expect(messages.map(m=>m.message.id)).toEqual([start.event.message.id,start.event.message.id])
    expect(start.event.message.model).toBe('claude-test')
    const {result}=await runtime.dispatch('tool.call',{},async()=>({result:null})) as {result:any}
    expect(result.answer).toBe('firstsecond')
    expect(result.usage.output_tokens).toBe(2)
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step retries increment indices and completed-only fallback produces a final stop chunk', async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-retry-'))
  const runtime=createModsRuntime()
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `let seen=[]; export function register(on) {
      on('turn.step', async function* ($,e,next) {
        const item={input:e,chunks:[]};seen.push(item);
        const stream=next(e);
        for await(const c of stream) {item.chunks.push(c);yield c}
        item.result=await stream.result;
        return item.result;
      });
      on('turn.complete',($,e,next)=>{seen.push({complete:e});return next(e)});
      on('tool.call',()=>({result:seen}));
    }`)
    await runtime.reconcile([{name:'retry',storageId:'retry@inline',pluginRoot:root,entrypoints:[entry]}])
    const requests:any[]=[]
    const h=harness(async function* (request) {
      requests.push(request)
      if(requests.length===1) {
        const exhausted=response('limit','partial')
        Object.assign(exhausted,{apiError:'max_output_tokens',isApiErrorMessage:true})
        yield exhausted
      } else yield response('fallback','finished')
    })
    h.context.mods=runtime
    const run=await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    const {result:seen}=await runtime.dispatch('tool.call',{},async()=>({result:[]})) as {result:any[]}
    expect(seen.slice(0,2).map(e=>e.input.index)).toEqual([0,1])
    expect(seen[0].input.turnId).toBe(seen[2].complete.turnId)
    expect(seen[1].chunks.filter((c:any)=>c.kind==='stop')).toEqual([expect.objectContaining({stopReason:'end_turn',usage:{model:'claude-test',input_tokens:10,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4}})])
    expect(seen[1].result.answer).toBe('finished')
    expect(run.messages.filter(m=>m.type==='assistant').flatMap(m=>m.message.content)).toEqual([{type:'text',text:'finished'}])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

for (const chunks of [false,true]) test(`turn.step hook-only subagent response consumes chunks, not return value (${chunks})`, async () => {
  const root=await mkdtemp(join(tmpdir(),'mods-step-synthetic-'))
  const diagnostics: unknown[]=[]
  const runtime=createModsRuntime({onDiagnostic:e=>diagnostics.push(e)})
  try {
    const entry=join(root,'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.step', async function* ($,e) {
        if(e.agentId!=='step-child'||e.index!==0) throw new Error('lost step identity');
        ${chunks ? "yield {kind:'thinking',index:0,text:'SYNTHETIC_THINKING'}; yield {kind:'text',index:1,text:'SYNTHETIC_ANSWER'}; yield {kind:'stop',stopReason:'end_turn',usage:null};" : ''}
        return {turnId:e.turnId,index:e.index,answer:'RETURN_ONLY',toolUses:[],stopReason:null,usage:null};
      });
    }`)
    await runtime.reconcile([{name:'synthetic',storageId:'synthetic@inline',pluginRoot:root,entrypoints:[entry]}])
    let calls=0,releases=0
    const capture=runtime.capture
    runtime.capture=services=>{const snapshot=capture(services);return {...snapshot,release(){releases++;snapshot.release()}}}
    const h=harness(async function* () {calls++;yield response('unexpected','MODEL')})
    h.context.mods=runtime
    h.context.agentId=asAgentId('step-child')
    const run=await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(calls).toBe(0)
    expect(releases).toBe(1)
    expect(run.messages.filter(m=>m.type==='assistant').flatMap(m=>m.message.content)).toEqual(chunks?[{type:'text',text:'SYNTHETIC_ANSWER'}]:[])
    const events=run.messages.filter(m=>m.type==='stream_event').map(m=>m.event)
    if(chunks) {
      expect(events[0].type).toBe('message_start')
      expect(events.at(-1).type).toBe('message_stop')
      expect(JSON.stringify(events)).toContain('SYNTHETIC_THINKING')
      let thinking: StreamingThinking | null = null
      for (const message of run.messages) {
        handleMessageFromStream(message, () => {}, () => {}, () => {}, () => {}, undefined,
          update => { thinking = update(thinking) })
      }
      expect(thinking).toMatchObject({thinking:'SYNTHETIC_THINKING',isStreaming:false})
    }
    expect(JSON.stringify(run.messages)).not.toContain('RETURN_ONLY')
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('turn.step Worker rewrites live text and recorded blocks before query completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-query-step-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let observed=[]; export function register(on) {
      on('turn.step', async function* ($,e,next) {
        const stream=next({...e,model:'rewritten-model',effort:'low'});
        for await (const chunk of stream) yield chunk.kind==='text' ? {...chunk,text:'REWRITTEN'} : chunk;
        observed.push({input:e,result:await stream.result});
        return {...await stream.result,answer:'RETURN_ONLY'};
      });
      on('turn.complete', ($,e,next) => {observed.push({complete:e});return next(e)});
      on('tool.call', () => ({result:observed}));
    }`)
    await runtime.reconcile([{name:'step',storageId:'step@inline',pluginRoot:root,entrypoints:[entry]}])
    const requests: any[] = []
    const h = harness(async function* (request) {requests.push(request);yield* streamedResponse('step-response','ORIGINAL')})
    h.context.mods = runtime
    const run = await drain(query(h.params))
    const live = run.messages.filter(m=>m.type==='stream_event'&&m.event.type==='content_block_delta').map(m=>m.event.delta.text).join('')
    expect(live).toBe('REWRITTEN')
    expect(run.messages.filter(m=>m.type==='assistant').flatMap(m=>m.message.content)).toEqual([{type:'text',text:'REWRITTEN'}])
    expect(requests[0].options).toMatchObject({model:'rewritten-model',effortValue:'low'})
    const {result:observed} = await runtime.dispatch('tool.call',{},async()=>({result:[]})) as {result:any[]}
    expect(observed[0]).toMatchObject({input:{index:0,messageCount:requests[0].messages.length},result:{answer:'ORIGINAL',usage:{output_tokens:9}}})
    expect(observed[1].complete).toMatchObject({turnId:observed[0].input.turnId,answer:'REWRITTEN',usage:{output_tokens:9}})
    expect(JSON.stringify(run.messages)).not.toContain('RETURN_ONLY')
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

for (const inputJSON of ['{"value":"REWRITTEN"}', '{broken']) test.each([false, true])(`turn.step Worker rewrites tool execution and history while preserving signed thinking (${inputJSON}, drop=%s)`, async dropThinking => {
  const root = await mkdtemp(join(tmpdir(), 'mods-query-step-tools-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let seen=[]; export function register(on) {
      on('turn.step', async function* ($,e,next) {
        const stream=next(e); seen.push(e);
        for await (const c of stream) {
          if(c.kind==='text' && c.text==='DROP_TEXT' || c.kind==='tool' && c.id==='drop-tool' || ${dropThinking} && c.kind==='thinking') continue;
          yield c.kind==='tool' ? {...c,name:'HarmlessStep'} : c.kind==='input' ? {...c,json:${JSON.stringify(inputJSON)}} : c.kind==='thinking' ? {...c,text:'DISPLAY_ONLY'} : c;
        }
        return await stream.result;
      });
      on('tool.call',{tool:'InspectSteps'},()=>({result:seen}));
    }`)
    await runtime.reconcile([{name:'step-tools',storageId:'step-tools@inline',pluginRoot:root,entrypoints:[entry]}])
    const {z} = await import('zod/v4')
    const calls: unknown[] = [], requests: any[] = []
    const tool = {name:'HarmlessStep',inputSchema:z.object({value:z.string()}),maxResultSizeChars:Infinity,isConcurrencySafe:()=>true,
      call:async (input: unknown)=>{calls.push(input);return {data:input}},
      mapToolResultToToolResultBlockParam:(data: unknown,id:string)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),
    } as unknown as Tool
    const originalThinking = {type:'thinking' as const,thinking:'SIGNED_ORIGINAL',signature:'signed-fixture'}
    type StreamBlock =
      | typeof originalThinking
      | {type:'text';text:string}
      | {type:'tool_use';id:string;name:string;input:{value:string}}
    const blocks: StreamBlock[] = [originalThinking,{type:'text',text:'DROP_TEXT'},
      {type:'tool_use',id:'keep-tool',name:'OriginalTool',input:{value:'ORIGINAL'}},
      {type:'tool_use',id:'drop-tool',name:'OriginalTool',input:{value:'DROPPED'}},
    ]
    const h = harness(async function* (request) {
      requests.push(request)
      if(requests.length>1) {yield* streamedResponse('tool-final','done');return}
      const template=response('tool-step','',10,0)
      template.message.stop_reason=null
      yield {type:'stream_event',event:{type:'message_start',message:{...template.message,content:[]}}}
      let completed=template
      for(let index=0;index<blocks.length;index++) {
        const block=blocks[index]!
        yield {type:'stream_event',event:{type:'content_block_start',index,content_block:block.type==='text'?{...block,text:''}:block.type==='thinking'?{...block,thinking:'',signature:''}:{...block,input:{}}}}
        yield {type:'stream_event',event:{type:'content_block_delta',index,delta:block.type==='text'?{type:'text_delta',text:block.text}:block.type==='thinking'?{type:'thinking_delta',thinking:block.thinking}:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}}
        if(block.type==='thinking') yield {type:'stream_event',event:{type:'content_block_delta',index,delta:{type:'signature_delta',signature:block.signature}}}
        completed={...template,uuid:randomUUID(),message:{...template.message,content:[block]}}
        yield completed
        yield {type:'stream_event',event:{type:'content_block_stop',index}}
      }
      completed.message.stop_reason='tool_use'
      completed.message.usage={...completed.message.usage,output_tokens:9}
      yield {type:'stream_event',event:{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:9}}}
      yield {type:'stream_event',event:{type:'message_stop'}}
    })
    h.context.mods=runtime
    h.context.options.tools=[tool]
    h.params.canUseTool=async (_tool,input)=>({behavior:'allow',updatedInput:input})
    const run=await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    const valid = inputJSON !== '{broken'
    expect(calls).toEqual(valid ? [{value:'REWRITTEN'}] : [])
    if (!valid) expect(run.messages.filter(m=>m.type==='user').flatMap(m=>m.message.content).some(block=>block.type==='tool_result'&&block.is_error)).toBe(true)
    expect(requests).toHaveLength(2)
    const history=requests[1].messages.filter((m:any)=>m.type==='assistant').flatMap((m:any)=>m.message.content)
    expect(history).toEqual([originalThinking,{type:'tool_use',id:'keep-tool',name:'HarmlessStep',input:valid ? {value:'REWRITTEN'} : inputJSON}])
    expect(JSON.stringify(requests[1].messages)).not.toContain('DROP_TEXT')
    expect(JSON.stringify(requests[1].messages)).not.toContain('drop-tool')
    expect(JSON.stringify(run.messages.filter(m=>m.type==='stream_event')).includes('DISPLAY_ONLY')).toBe(!dropThinking)
    let thinking: StreamingThinking | null = null
    const displayed: string[] = []
    for (const message of run.messages) {
      handleMessageFromStream(message, () => {}, () => {}, () => {}, () => {}, undefined,
        update => {
          thinking = update(thinking)
          if (thinking) displayed.push(thinking.thinking)
        })
    }
    expect(displayed.includes('DISPLAY_ONLY')).toBe(!dropThinking)
    expect(displayed).not.toContain('SIGNED_ORIGINAL')
    if (dropThinking) expect(thinking === null || thinking.thinking === '').toBe(true)
    else expect(thinking).toMatchObject({thinking:'DISPLAY_ONLY',isStreaming:false})
    const observed=await runtime.dispatch('tool.call',{tool:'InspectSteps'},async()=>({result:[]})) as {result:any[]}
    expect(observed.result.map(e=>e.index)).toEqual([0,1])
    expect(observed.result.map(e=>e.messageCount)).toEqual(requests.map(r=>r.messages.length))
    expect(observed.result[0].turnId).toBe(observed.result[1].turnId)
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})


describe('public query prompt.context', () => {
  test('context rendering preserves ordered numeric names and omits empty snapshots', () => {
    const original = process.env.NODE_ENV
    delete process.env.NODE_ENV
    try {
      const input: Message[] = [createSystemMessage('unchanged', 'info')]
      const rendered = prependUserContext(input, [{name:'9',text:'first'},{name:'2',text:'second'}])
      expect(rendered[0]?.type).toBe('user')
      expect((rendered[0] as any).message.content).toContain('# 9\nfirst\n# 2\nsecond')
      expect(rendered[1]).toBe(input[0])
      expect(prependUserContext(input, [])).toBe(input)
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
  test('renders ordered rewritten blocks once before the model without running classic prompt hooks', async () => {
    const requests: any[] = []
    const h = harness(async function* (request) {
      requests.push(request)
      yield response('context', 'answer')
    })
    const events: string[] = []
    let released = 0
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context',
        release: () => { released++ },
        dispatch: async (event: string, input: any, _core: any, options: any) => {
          events.push(event)
          expect(input).toEqual({blocks:[{name:'claudeMd',text:'private instruction'},{name:'currentDate',text:'today'}]})
          const result = {blocks:[{name:'9',text:'first'},{name:'2',text:'second'},{name:'currentDate',text:'changed'}]}
          options.validateResult(result, [])
          return result
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.userContext = {claudeMd:'private instruction', currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext).toEqual({'9':'first','2':'second',currentDate:'changed'})
      return {messages, wasCompacted:false}
    }
    await drain(query(h.params))
    expect(events).toEqual(['prompt.context'])
    expect(released).toBe(1)
    expect(requests).toHaveLength(1)
    expect(h.params.userContext).toEqual({claudeMd:'private instruction',currentDate:'today'})
  })
})

describe('public query turn lifecycle', () => {
  test('dispatches main turn.start before the loop and shares its identity with turn.complete', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.params.publicTurn = { text: 'hello' }

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.start', 'turn.complete'])
    expect(h.calls[0]!.input.text).toBe('hello')
    expect(h.calls[0]!.result).toEqual({ turnId: h.calls[0]!.input.turnId })
    expect(h.calls[0]!.input.turnId).toBe(h.calls[1]!.input.turnId)
  })

  test('publishes the public turn id only while the query is in flight', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness(async function* () {
      entered.resolve()
      await release.promise
      yield response('one', 'answer')
    })
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }

    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    const running = drain(query(h.params))
    try {
      await entered.promise
      expect(h.context.mods?.activePublicTurnId).toBe(h.calls[0]!.input.turnId)
    } finally {
      release.resolve()
      await running
    }
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
  })

  test('keeps the public turn visible while start and completion hooks are pending', async () => {
    const startEntered = Promise.withResolvers<void>()
    const startRelease = Promise.withResolvers<void>()
    const completeEntered = Promise.withResolvers<void>()
    const completeRelease = Promise.withResolvers<void>()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.params.publicTurn = { text: 'hello' }
    const dispatch = h.snapshot.dispatch
    const ids: string[] = []
    h.snapshot.dispatch = async (event, input, core, options) => {
      ids.push(input.turnId as string)
      if (event === 'turn.start') {
        startEntered.resolve()
        await startRelease.promise
      } else {
        completeEntered.resolve()
        await completeRelease.promise
      }
      return dispatch(event, input, core, options)
    }
    const running = drain(query(h.params))
    try {
      await startEntered.promise
      expect(h.context.mods?.activePublicTurnId).toBe(ids[0])
      startRelease.resolve()
      await completeEntered.promise
      expect(ids[1]).toBe(ids[0])
      expect(h.context.mods?.activePublicTurnId).toBe(ids[1])
    } finally {
      startRelease.resolve()
      completeRelease.resolve()
      await running
    }
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
  })

  test('real runtime tracks public turns without any lifecycle hooks', async () => {
    const runtime = createModsRuntime()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.context.mods = runtime
    h.params.publicTurn = { text: 'hello' }
    const iterator = query(h.params)
    try {
      expect(runtime.activePublicTurnId).toBeUndefined()
      expect((await iterator.next()).done).toBe(false)
      expect(runtime.activePublicTurnId).toEqual(expect.any(String))
      await drain(iterator)
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      await runtime.dispose()
    }
  })

  test('closing an older query does not clear a newer public turn on the same runtime', async () => {
    const runtime = createModsRuntime()
    const h = harness(async function* () { yield response('one', 'answer') })
    h.context.mods = runtime
    h.params.publicTurn = { text: 'hello' }
    const older = query(h.params)
    const newer = query(h.params)
    try {
      await older.next()
      const olderId = runtime.activePublicTurnId
      expect(olderId).toEqual(expect.any(String))
      await newer.next()
      const newerId = runtime.activePublicTurnId
      expect(newerId).toEqual(expect.any(String))
      expect(newerId).not.toBe(olderId)
      await older.return({ reason: 'consumer-return' })
      expect(runtime.activePublicTurnId).toBe(newerId)
      await newer.return({ reason: 'consumer-return' })
      expect(runtime.activePublicTurnId).toBeUndefined()
    } finally {
      await older.return({ reason: 'consumer-return' })
      await newer.return({ reason: 'consumer-return' })
      await runtime.dispose()
    }
  })

  test('releases a start-only snapshot after the query', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.start'])
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('releases a start-only snapshot when turn.start fails', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    const error = new Error('turn.start failed')
    h.snapshot.hasHooks = event => event === 'turn.start'
    h.params.publicTurn = { text: 'hello' }
    h.fail(error)
    const dispatch = h.snapshot.dispatch
    h.snapshot.dispatch = (event, input, core, options) => {
      expect(h.context.mods?.activePublicTurnId).toBe(input.turnId as string)
      return dispatch(event, input, core, options)
    }

    await expect(drain(query(h.params))).rejects.toBe(error)

    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('does not dispatch turn.start without an explicit public turn', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'

    await drain(query(h.params))

    expect(h.calls.map(call => call.event)).toEqual(['turn.complete'])
  })

  for (const event of ['tool.list', 'tool.describe', 'agent.offer'] as const) {
    test(`keeps a ${event}-only snapshot through the model request and releases it once`, async () => {
      let received: ModSnapshot | undefined
      const h = harness(async function* ({ options }) {
        received = options.modsSnapshot
        yield response('one', 'answer')
      })
      h.snapshot.hasHooks = name => name === event

      await drain(query(h.params))

      expect(received).toBe(h.snapshot)
      expect(h.calls).toEqual([])
      expect(h.order).toEqual(['capture', 'release'])
    })
  }

  test('releases a catalog-only snapshot when the query fails', async () => {
    const h = harness(async function* () {})
    const error = new Error('microcompact failed')
    h.snapshot.hasHooks = event => event === 'tool.describe'
    h.params.deps!.microcompact = async () => { throw error }

    await expect(drain(query(h.params))).rejects.toBe(error)

    expect(h.order).toEqual(['capture', 'release'])
  })

  test('normal completion uses the final response, updated usage and real duration once', async () => {
    const h = harness(async function* () {
      const first = response('one', 'first', 10, 0)
      yield first
      first.message.usage.output_tokens = 7
      const second = response('two', 'final', 20, 0)
      yield second
      second.message.usage.output_tokens = 11
      await Bun.sleep(12)
    })
    h.context.queryTracking = { chainId: 'analytics-chain', depth: 0 }
    const run = await drain(query(h.params))
    expect(run.terminal).toEqual({ reason: 'completed' })
    expect(h.calls).toHaveLength(1)
    const { input, result, options } = h.calls[0]!
    expect(input).toMatchObject({ answer: 'final', isAborted: false, reason: 'answer' })
    expect(input.turnId).not.toBe('analytics-chain')
    expect(input).not.toHaveProperty('agentId')
    expect(input).not.toHaveProperty('refusal')
    expect(input.durationMs).toBeGreaterThanOrEqual(10)
    expect(input.usage).toEqual({ model: 'claude-test', input_tokens: 30, output_tokens: 18, cache_read_input_tokens: 6, cache_creation_input_tokens: 8 })
    expect(result).toEqual({ text: 'final', usage: input.usage })
    expect(options.signal).toBeUndefined()
    expect(h.order).toEqual(['capture', 'dispatch', 'release'])
  })

  test('same response blocks accumulate, repeated snapshots replace instead of append', async () => {
    const h = harness(async function* () {
      const first = response('one', 'A')
      yield first
      yield { ...first, message: { ...first.message, content: [{ type: 'text', text: 'AB' }] } }
      yield response('one', 'C')
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } }
    })
    await drain(query(h.params))
    expect(h.calls[0]?.input.answer).toBe('ABC')
    expect(h.calls[0]?.input.usage.output_tokens).toBe(9)
    expect(h.calls[0]?.input.usage.input_tokens).toBe(10)
  })

  test('main-loop rewrite is a UI system message, never an API assistant answer', async () => {
    const original = response('one', 'real answer')
    const h = harness(async function* () { yield original })
    h.rewrite(result => ({ ...result, text: 'hook annotation' }))
    const run = await drain(query(h.params))
    const added = run.messages.filter(message => message.type === 'system' && message.content === 'hook annotation')
    expect(added).toHaveLength(1)
    expect(normalizeMessagesForAPI([added[0]] as Message[], [])).toEqual([])
    expect(original.message.content[0]?.text).toBe('real answer')
    expect(run.terminal).toEqual({ reason: 'completed' })
  })

  test('subagent completion carries agent identity and does not display a rewrite', async () => {
    const h = harness(async function* () { yield response('one', 'child answer') })
    h.context.agentId = 'child-agent' as ToolUseContext['agentId']
    h.rewrite(result => ({ ...result, text: 'not for main UI' }))
    const run = await drain(query(h.params))
    expect(h.calls[0]?.input.agentId).toBe('child-agent')
    expect(run.messages.some(message => message.content === 'not for main UI')).toBe(false)
    expect(run.terminal).toEqual({ reason: 'completed' })
  })

  test.each([false, true])('subagents never replace the public turn, even with publicTurn=%s', async publicTurn => {
    const h = harness(async function* () { yield response('one', 'child answer') })
    h.snapshot.hasHooks = event => event === 'turn.start' || event === 'turn.complete'
    h.context.agentId = 'child-agent' as ToolUseContext['agentId']
    if (publicTurn) h.params.publicTurn = { text: 'inherited prompt' }
    const end = h.context.mods!.beginPublicTurn('parent-turn')
    const iterator = query(h.params)
    try {
      await iterator.next()
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      await drain(iterator)
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      expect(h.calls.map(call => call.event)).toEqual(['turn.complete'])
      expect(h.calls[0]!.input.turnId).not.toBe('parent-turn')
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      end()
    }
  })

  test('queries without an explicit public turn do not replace an existing public turn', async () => {
    const h = harness(async function* () { yield response('one', 'answer') })
    const end = h.context.mods!.beginPublicTurn('parent-turn')
    const iterator = query(h.params)
    try {
      await iterator.next()
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
      await drain(iterator)
      expect(h.context.mods?.activePublicTurnId).toBe('parent-turn')
    } finally {
      await iterator.return({ reason: 'consumer-return' })
      end()
    }
  })

  test('abort dispatches without the cancelled query signal and releases afterwards', async () => {
    const h = harness(async function* () {
      expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
      yield response('one', 'partial')
      h.context.abortController.abort('interrupt')
    })
    h.params.publicTurn = { text: 'hello' }
    await drain(query(h.params))
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'aborted', isAborted: true, answer: 'partial' })
    expect(h.calls[0]?.options.signal).toBeUndefined()
    expect(h.order.at(-1)).toBe('release')
  })

  test('consumer return finalizes once without yielding a cleanup message', async () => {
    const h = harness(async function* () { yield response('one', 'unfinished') })
    h.params.publicTurn = { text: 'hello' }
    h.rewrite(() => ({ text: 'must not keep iterator alive' }))
    const iterator = query(h.params)
    let step = await iterator.next()
    while (!step.done && step.value.type !== 'assistant') step = await iterator.next()
    expect(step.done).toBe(false)
    expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
    expect(await iterator.return({ reason: 'consumer-return' })).toEqual({ done: true, value: { reason: 'consumer-return' } })
    await iterator.return({ reason: 'again' })
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'aborted', isAborted: true, answer: 'unfinished' })
    expect(h.order.at(-1)).toBe('release')
  })

  test('uncaught query failure still finalizes', async () => {
    const h = harness(async function* () {})
    const error = new Error('microcompact failed')
    h.params.publicTurn = { text: 'hello' }
    h.params.deps!.microcompact = async () => {
      expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
      throw error
    }
    await expect(drain(query(h.params))).rejects.toBe(error)
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.input).toMatchObject({ reason: 'error', isAborted: false, answer: '' })
    expect(h.order.at(-1)).toBe('release')
  })

  test('turn identity stays separate from analytics tracking and is fresh for each public query', async () => {
    const analyticsIds: string[] = []
    const h = harness(async function* ({ options }) {
      analyticsIds.push(options.queryTracking!.chainId)
      yield response(randomUUID(), 'answer')
    })
    await drain(query(h.params))
    await drain(query(h.params))
    const turnIds = h.calls.map(call => call.input.turnId)
    expect(turnIds[0]).not.toBe(turnIds[1])
    expect(analyticsIds[0]).not.toBe(analyticsIds[1])
    expect(turnIds).not.toEqual(analyticsIds)
    expect(h.context.queryTracking).toBeUndefined()
  })

  test('refusal derives only from the API stop reason, with null unsupplied metadata', async () => {
    const h = harness(async function* () {
      const message = response('refused', 'No')
      message.message.stop_reason = 'refusal'
      yield message
    })
    await drain(query(h.params))
    expect(h.calls[0]?.input).toMatchObject({ reason: 'refusal', refusal: { category: null, explanation: null } })
  })

  test('synthetic API errors do not fabricate response usage or refusal metadata', async () => {
    const h = harness(async function* () {
      yield {type:'stream_event', event:{type:'ping'}}
      throw new Error('API unavailable')
    })
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('model_error')
    expect(h.calls[0]?.input.reason).toBe('error')
    expect(h.calls[0]?.input).not.toHaveProperty('usage')
    expect(h.calls[0]?.input).not.toHaveProperty('refusal')
  })
})

test('mid-turn drain preserves admitted context and never injects a core-refused prompt', async () => {
  const { enqueue, getCommandQueue, resetCommandQueue } = await import('./utils/messageQueueManager.js')
  const { createUserMessage } = await import('./utils/messages.js')
  const { createAttachmentMessage } = await import('./utils/attachments.js')
  const admitted = [
    createUserMessage({ content: '/rewritten-as-text' }),
    createAttachmentMessage({ type: 'hook_additional_context', content: ['retained admission context'], hookName: 'prompt.submit', toolUseID: 'hook-admitted', hookEvent: 'UserPromptSubmit' }),
  ]
  const requests: any[] = []
  const h = harness(async function* (request) {
    requests.push(request)
    if (requests.length === 1) {
      enqueue({ value: 'raw input must not return', mode: 'prompt', admitted: {
        messages: admitted, shouldQuery: true, admission: { text: '/rewritten-as-text' },
      } })
      enqueue({ value: 'refused prompt', mode: 'prompt', admitted: {
        messages: [createUserMessage({ content: 'refused prompt' })], shouldQuery: false,
        admission: { drop: 'stopped by core' },
      } })
      yield createAssistantMessage({ content: [{ type: 'tool_use', caller: { type: 'direct' }, id: 'fixture-call', name: 'UnavailableFixture', input: {} }] })
    } else yield response('done', 'answer')
  })
  try {
    const run = await drain(query(h.params))
    expect(requests).toHaveLength(2)
    expect(run.messages).toContainEqual(admitted[0])
    expect(run.messages).toContainEqual(admitted[1])
    expect(JSON.stringify(requests[1].messages)).toContain('retained admission context')
    expect(JSON.stringify(requests[1].messages)).not.toContain('raw input must not return')
    expect(JSON.stringify(requests[1].messages)).not.toContain('refused prompt')
    expect(getCommandQueue().map(command => command.value)).toEqual(['refused prompt'])
  } finally {
    resetCommandQueue()
  }
})

test('model request catalogs follow refreshed tools between query iterations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-catalog-refresh-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('tool.describe', ($, e) => ({description:e.description}));
      on('tool.call', async ($) => ({result:await $.tool.list()}));
    }`)
    await runtime.reconcile([{name:'catalog-refresh',storageId:'catalog-refresh@inline',pluginRoot:root,entrypoints:[entry]}])
    const { z } = await import('zod/v4')
    const makeTool = (name: string) => ({
      name,inputSchema:z.object({}),inputJSONSchema:{type:'object',properties:{}},
      prompt:async () => name,maxResultSizeChars:Infinity,isConcurrencySafe:()=>false,
      mapToolResultToToolResultBlockParam:(data: unknown,id:string)=>({type:'tool_result',tool_use_id:id,content:JSON.stringify(data)}),
    }) as unknown as Tool
    const first = makeTool('InitialCatalog')
    const refreshed = makeTool('RefreshedCatalog')
    const catalogs: unknown[] = []
    const h = harness(async function* (request) {
      catalogs.push(await request.options.modsSnapshot!.dispatch('tool.call',{tool:'catalog'},async()=>({result:'unexpected'})))
      if (catalogs.length === 1) {
        yield createAssistantMessage({content:[{type:'tool_use',caller:{type:'direct'},id:'catalog-refresh-call',name:first.name,input:{}}]})
      } else yield response('catalog-done','answer')
    })
    h.context.mods = runtime
    h.context.options.tools = [first]
    h.context.options.refreshTools = () => [refreshed]
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(catalogs).toEqual([
      {result:[{name:first.name,description:first.name,mcp:false}]},
      {result:[{name:refreshed.name,description:refreshed.name,mcp:false}]},
    ])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('model requests receive a catalog-bound Mods snapshot even without turn lifecycle hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-catalog-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('tool.describe', ($, e) => ({description:e.description+' projected'}));
      on('tool.call', async ($) => ({result:await $.tool.list()}));
    }`)
    await runtime.reconcile([{name:'catalog-query',storageId:'catalog-query@inline',pluginRoot:root,entrypoints:[entry]}])
    const retained: ModSnapshot[] = []
    let requests = 0
    const h = harness(async function* (request) {
      requests++
      const snapshot = request.options.modsSnapshot!
      expect(snapshot).toBeDefined()
      retained.push(snapshot)
      expect(await snapshot.dispatch('tool.call', {tool:'catalog'}, async () => ({result:'unexpected'}))).toEqual({
        result:[{name:'CatalogProbe',description:'Original catalog description',mcp:false}],
      })
      yield response('catalog','answer')
    })
    h.context.options.tools = [{name:'CatalogProbe',inputJSONSchema:{type:'object',properties:{}},prompt:async () => 'Original catalog description'} as unknown as Tool]
    h.context.mods = runtime
    const run = await drain(query(h.params))
    expect(run.terminal.reason).toBe('completed')
    expect(requests).toBe(1)
    expect(retained).toHaveLength(1)
    await expect(retained[0]!.dispatch('tool.list', {}, async () => ({value:[]}))).rejects.toThrow('snapshot released')
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker prompt.context runs once for a snapshot across model recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const value = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...value.blocks, {name:'plugin',text:'extra'}]};
      });
    }`)
    await runtime.reconcile([{name:'context-query',storageId:'context-query@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('prompt.context')).toBe(true)
    const observed: any[] = []
    const dispatch = runtime.capture
    runtime.capture = () => {
      const snapshot = dispatch()
      return {...snapshot, dispatch: async (event, input, core, options) => {
        const result = await snapshot.dispatch(event,input,core,options)
        if (event === 'prompt.context') observed.push(result)
        return result
      }}
    }
    let requests = 0
    const h = harness(async function* () {
      requests++
      if (requests === 1) {
        const exhausted = response('limit','partial')
        Object.assign(exhausted, {apiError:'max_output_tokens', isApiErrorMessage:true})
        yield exhausted
      } else yield response('one','answer')
    })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    await drain(query(h.params))
    expect(requests).toBe(2)
    expect(observed).toEqual([{blocks:[{name:'currentDate',text:'today'},{name:'plugin',text:'extra'}]}])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker rejects duplicate context names and keeps the completed inner rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-invalid-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const result = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...result.blocks, {name:'currentDate',text:'duplicate'}]};
      });
    }`)
    await runtime.reconcile([{name:'invalid-context',storageId:'invalid-context@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    let models = 0
    let compactions = 0
    const h = harness(async function* () { models++; yield response('one','answer') })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      compactions++
      expect(forkContext.userContext).toEqual({currentDate:'today'})
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    expect(models).toBe(1)
    expect(compactions).toBe(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({message:expect.stringContaining('unique named text blocks')})
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real runtime wiring: Worker turn.complete rewrite reaches the public query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-turn-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        return { ...result, text: 'runtime annotation' };
      });
    }`)
    await runtime.reconcile([{ name: 'turn-query', storageId: 'turn-query@inline', pluginRoot: root, entrypoints: [entry] }])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('turn.complete')).toBe(true)
    const h = harness(async function* () { yield response('one', 'real answer') })
    h.context.mods = runtime
    const run = await drain(query(h.params))
    expect(diagnostics).toEqual([])
    expect(run.messages.some(message => message.type === 'system' && message.content === 'runtime annotation')).toBe(true)
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

for (const mode of ['none', 'no-hook', 'hook']) {
  for (const ending of ['return', 'throw', 'close']) {
    test(`actual wrapper preserves command lifecycle: ${mode}/${ending}`, async () => {
      const h = harness(async function* () {})
      if (mode === 'none') h.context.mods = undefined
      if (mode === 'no-hook') h.snapshot.hasHooks = () => false
      const lifecycle: any[] = []
      const diagnostics: any[] = []
      const original = new Error('query failure')
      const run = isolatedWrapper(async function* (_params, consumed) {
        consumed.push('command')
        lifecycle.push(['command', 'started'])
        yield { type: 'stream_request_start' }
        if (ending === 'throw') throw original
        return { reason: 'completed' }
      }, diagnostics, lifecycle)(h.params)
      await run.next()
      if (ending === 'throw') await expect(run.next()).rejects.toBe(original)
      else if (ending === 'close') await run.return({ reason: 'consumer' })
      else await run.next()
      expect(lifecycle).toEqual(ending === 'return'
        ? [['command', 'started'], ['command', 'completed']]
        : [['command', 'started']])
      expect(diagnostics).toEqual([])
      expect(h.calls).toHaveLength(mode === 'hook' ? 1 : 0)
      if (mode === 'hook') expect(h.calls[0]?.input.reason).toBe(
        ending === 'close' ? 'aborted' : ending === 'throw' ? 'error' : 'answer')
    })
  }
}

for (const ending of ['return', 'throw', 'close']) {
  test(`finalizer failure is diagnostic without overriding ${ending}`, async () => {
    const h = harness(async function* () {})
    h.params.publicTurn = { text: 'hello' }
    h.fail(new Error('dispatch failed'))
    const original = new Error('original failure')
    const diagnostics: any[] = []
    const run = isolatedWrapper(async function* () {
      yield { type: 'stream_request_start' }
      if (ending === 'throw') throw original
      return { reason: 'completed' }
    }, diagnostics, [])(h.params)
    await run.next()
    expect(h.context.mods?.activePublicTurnId).toEqual(expect.any(String))
    if (ending === 'throw') await expect(run.next()).rejects.toBe(original)
    else if (ending === 'close') expect(await run.return({ reason: 'consumer' })).toEqual({ done: true, value: { reason: 'consumer' } })
    else expect(await run.next()).toEqual({ done: true, value: { reason: 'completed' } })
    expect(h.context.mods?.activePublicTurnId).toBeUndefined()
    expect(diagnostics.some(value => String(value).includes('Mods turn.complete failed'))).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.order.at(-1)).toBe('release')
  })
}


test('mid-turn drain leaves an unadmitted plugin prompt in the host queue', async () => {
  const { enqueue, getCommandQueue, resetCommandQueue } = await import('./utils/messageQueueManager.js')
  const requests: any[] = []
  const h = harness(async function* (request) {
    requests.push(request)
    if (requests.length === 1) {
      enqueue({
        value: 'plugin follow-up must wait for admission',
        mode: 'prompt',
        priority: 'later',
        promptSubmitReceipt: { admit() {}, cancel() {} },
        promptSubmitMetadata: {
          origin: { kind: 'plugin', name: 'fixture' },
          wait: false,
        },
      })
      yield createAssistantMessage({ content: [{ type: 'tool_use', caller: { type: 'direct' }, id: 'fixture-call', name: 'UnavailableFixture', input: {} }] })
    } else yield response('done', 'answer')
  })
  try {
    await drain(query(h.params))
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1].messages)).not.toContain('plugin follow-up must wait for admission')
    expect(getCommandQueue().map(command => command.value)).toEqual([
      'plugin follow-up must wait for admission',
    ])
  } finally {
    resetCommandQueue()
  }
})

test('hands the actual instruction snapshot to hooks and preserves replacement provenance for forks', async () => {
    const files = [{ path: '/fixture/CLAUDE.md', kind: 'project' as const, content: 'original marker' }]
    const original = reconcilePromptContext({ blocks: [], instructionFiles: files }, { blocks: [], instructionFiles: [] })
    const replacement = [{ ...files[0]!, content: 'replacement marker' }]
    const h = harness(async function* () { yield response('context-sources', 'answer') })
    h.params.userContext = withUserContextInstructionFiles(
      Object.fromEntries(original.blocks.map(block => [block.name, block.text])), files,
    )
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context', release() {},
        dispatch: async (_event: string, input: any, core: any, options: any) => {
          expect(input.instructionFiles).toEqual(files)
          const rewritten = options.restoreInput({ ...input, instructionFiles: replacement }, input)
          expect(rewritten.blocks[0].text).toContain('replacement marker')
          expect(rewritten.blocks[0].text).not.toContain('original marker')
          return core(rewritten)
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext.claudeMd).toContain('replacement marker')
      expect(getUserContextInstructionFiles(forkContext.userContext)).toEqual(replacement)
      return { messages, wasCompacted: false }
    }
    await drain(query(h.params))
    expect(getUserContextInstructionFiles(h.params.userContext)).toEqual(files)
  })

test('renders ordered rewritten blocks once before the model without running classic prompt hooks', async () => {
    const requests: any[] = []
    const h = harness(async function* (request) {
      requests.push(request)
      yield response('context', 'answer')
    })
    const events: string[] = []
    let released = 0
    h.context.mods = {
      hasHooks: (event: string) => event === 'prompt.context',
      capture: () => ({
        hasHooks: (event: string) => event === 'prompt.context',
        release: () => { released++ },
        dispatch: async (event: string, input: any, _core: any, options: any) => {
          events.push(event)
          expect(input).toEqual({blocks:[{name:'claudeMd',text:'private instruction'},{name:'currentDate',text:'today'}]})
          const result = {blocks:[{name:'9',text:'first'},{name:'2',text:'second'},{name:'currentDate',text:'changed'}]}
          options.validateResult(result, [])
          return result
        },
      }),
    } as unknown as NonNullable<ToolUseContext['mods']>
    h.params.userContext = {claudeMd:'private instruction', currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      expect(forkContext.userContext).toEqual({'9':'first','2':'second',currentDate:'changed'})
      return {messages, wasCompacted:false}
    }
    await drain(query(h.params))
    expect(events).toEqual(['prompt.context'])
    expect(released).toBe(1)
    expect(requests).toHaveLength(1)
    expect(h.params.userContext).toEqual({claudeMd:'private instruction',currentDate:'today'})
  })

for (const ending of ['return', 'throw', 'close', 'abort'] as const) {
  test(`prompt.context-only snapshot releases exactly once on ${ending}`, async () => {
    const h = harness(async function* () { yield response('context-only', 'answer') })
    h.snapshot.hasHooks = event => event === 'prompt.context'
    h.context.mods!.hasHooks = h.snapshot.hasHooks
    const error = new Error('context failed')
    if (ending === 'throw') h.fail(error)
    if (ending === 'abort') {
      h.snapshot.dispatch = async (_event, _input, _core, options) => {
        h.context.abortController.abort(error)
        options!.signal!.throwIfAborted()
      }
    }
    const iterator = query(h.params)
    if (ending === 'throw' || ending === 'abort') await expect(drain(iterator)).rejects.toBe(error)
    else if (ending === 'close') {
      await iterator.next()
      await iterator.return({ reason: 'consumer-return' })
    } else await drain(iterator)
    expect(h.order.filter(step => step === 'capture')).toHaveLength(1)
    expect(h.order.filter(step => step === 'release')).toHaveLength(1)
  })
}

test('real Worker caches context per input generation and invalidates through the saved engine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-cache-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
      on('tool.call', async $ => {await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'context-cache',storageId:'context-cache@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string, string>[] = []
    const h = harness(async function* () { yield response('cached-context', 'answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    h.params.userContext = {date:'first'}
    await drain(query(h.params))
    h.params.userContext = {date:'changed but not invalidated'}
    await drain(query(h.params))
    h.context.agentId = asAgentId('child')
    h.params.userContext = {}
    await drain(query(h.params))
    await drain(query(h.params))
    expect(contexts).toEqual([
      {date:'first',calls:'1'}, {date:'changed but not invalidated',calls:'2'},
      {calls:'3'}, {calls:'3'},
    ])
    delete h.context.agentId
    expect(await runtime.dispatch('tool.call', {}, async () => ({result:'core'}))).toEqual({result:'invalidated'})
    h.params.userContext = {date:'refreshed'}
    await drain(query(h.params))
    h.context.agentId = asAgentId('child')
    h.params.userContext = {}
    await drain(query(h.params))
    expect(contexts).toEqual([
      {date:'first',calls:'1'}, {date:'changed but not invalidated',calls:'2'},
      {calls:'3'}, {calls:'3'},
      {date:'refreshed',calls:'4'}, {calls:'5'},
    ])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root, {recursive:true,force:true})
  }
})

test('context invalidation while a real Worker is pending cannot repopulate the cleared cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-pending-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  const release = Promise.withResolvers<void>()
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', async ($,e,next) => {
        const count=++calls;
        await next(e);
        return {blocks:[{name:'calls',text:String(count)}]};
      });
      on('tool.call', async $ => {await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'pending-context',storageId:'pending-context@inline',pluginRoot:root,entrypoints:[entry]}])
    const entered = Promise.withResolvers<void>()
    const capture = runtime.capture
    let first = true
    runtime.capture = services => {
      const snapshot = capture(services)
      return { ...snapshot, dispatch: (event, input, core, options) => snapshot.dispatch(event,input,async value => {
        if (event === 'prompt.context' && first) {
          first = false
          entered.resolve()
          await release.promise
        }
        return core(value)
      },options) }
    }
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('pending-context', 'answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    const pending = drain(query(h.params))
    await entered.promise
    try {
      expect(await runtime.dispatch('tool.call',{},async()=>({result:'core'}))).toEqual({result:'invalidated'})
      await drain(query(h.params))
    } finally { release.resolve(); await pending }
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'2'},{calls:'1'},{calls:'2'}])
    expect(diagnostics).toEqual([])
  } finally {
    release.resolve()
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('context cache does not reuse a result for different explicit input', async () => {
  const h = harness(async function* () { yield response('context-input', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot, { promptContexts: new Map() })
  h.rewrite((_result, input) => ({ blocks: input.blocks }))
  const contexts: Record<string, string>[] = []
  h.params.deps!.autocompact = async (messages, _context, forkContext) => {
    contexts.push(forkContext.userContext)
    return { messages, wasCompacted: false }
  }

  h.params.userContext = { scenario: 'first' }
  await drain(query(h.params))
  h.params.userContext = { scenario: 'second' }
  await drain(query(h.params))

  expect(contexts).toEqual([{ scenario: 'first' }, { scenario: 'second' }])
  expect(h.calls.map(call => call.event)).toEqual(['prompt.context', 'prompt.context'])
})

test('context cache evicts failed work and never exposes its owned blocks to consumers', async () => {
  const h = harness(async function* () { yield response('cached', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  const cache = new Map()
  Object.assign(h.snapshot, {promptContexts:cache})
  const error = new Error('read failed')
  h.fail(error)
  await expect(drain(query(h.params))).rejects.toBe(error)
  expect(cache.size).toBe(0)
  h.fail(undefined)
  h.params.userContext = {context:'original'}
  const contexts: Record<string,string>[] = []
  h.params.deps!.autocompact = async (messages, _context, forkContext) => {
    contexts.push({...forkContext.userContext})
    forkContext.userContext.context = 'mutated by consumer'
    return {messages,wasCompacted:false}
  }
  await drain(query(h.params))
  await drain(query(h.params))
  expect(contexts).toEqual([{context:'original'},{context:'original'}])
  expect(h.calls.map(call=>call.event)).toEqual(['prompt.context','prompt.context'])
})

test('an aborted context-cache waiter releases without cancelling the query computing the context', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () { yield response('waiter', 'answer') })
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot, {promptContexts:new Map()})
  const dispatch = h.snapshot.dispatch
  h.snapshot.dispatch = async (...args) => {
    entered.resolve()
    await release.promise
    return dispatch(...args)
  }
  const first = drain(query(h.params))
  await entered.promise
  const controller = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controller}}))
  const error = new Error('waiter cancelled')
  let settled = false
  const result = second.catch(reason => { settled = true; return reason })
  controller.abort(error)
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await result).toBe(error)
    expect(h.order.filter(step=>step==='release')).toHaveLength(1)
    expect(h.context.abortController.signal.aborted).toBe(false)
  } finally {
    release.resolve()
    await first
    await result
  }
  expect(h.calls).toHaveLength(1)
  expect(h.order.filter(step=>step==='release')).toHaveLength(2)
})

test('cancelling the context computation owner does not fail another live query waiting for it', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('survivor','answer')})
  h.snapshot.hasHooks = event => event === 'prompt.context'
  Object.assign(h.snapshot,{promptContexts:new Map()})
  let reads = 0
  h.params.refreshUserContext = async () => {
    if (++reads === 1) { entered.resolve(); await release.promise }
    return {source:'fresh'}
  }
  const first = drain(query(h.params))
  await entered.promise
  const secondController = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:secondController}}))
  const error = new Error('context owner cancelled')
  const firstResult = first.catch(reason => reason)
  const secondResult = second.catch(reason => reason)
  h.context.abortController.abort(error)
  release.resolve()
  expect(await firstResult).toBe(error)
  expect(await secondResult).toMatchObject({terminal:{reason:'completed'}})
  expect(secondController.signal.aborted).toBe(false)
  expect(reads).toBe(2)
  expect(h.calls).toHaveLength(1)
  expect(h.order.filter(step=>step==='release')).toHaveLength(2)
})

test('a live context waiter retries without waiting for the cancelled owner read to settle', async () => {
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('survivor','answer')})
  h.snapshot.hasHooks = event => event === 'prompt.context'
  const cache = new Map()
  Object.assign(h.snapshot,{promptContexts:cache})
  let reads = 0
  h.params.refreshUserContext = async () => {
    const read = ++reads
    if (read === 1) { entered.resolve(); await release.promise }
    return {source:`read-${read}`}
  }
  const first = drain(query(h.params)).catch(error => error)
  await entered.promise
  const ownerResult = cache.get(undefined).result.catch(() => {})
  const controller = new AbortController()
  const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controller}}))
  const deadline = Promise.withResolvers<never>()
  const timer = setTimeout(() => deadline.reject(new Error('live waiter is blocked on cancelled context read')), 1000)
  try {
    const reason = new Error('cancel raw context read')
    h.context.abortController.abort(reason)
    expect(await first).toBe(reason)
    expect(await Promise.race([second,deadline.promise])).toMatchObject({terminal:{reason:'completed'}})
    expect(reads).toBe(2)
    expect(h.calls).toHaveLength(1)
  } finally {
    clearTimeout(timer)
    release.resolve()
    await ownerResult
    await second
  }
  expect((await cache.get(undefined).result).blocks).toEqual([{name:'source',text:'read-2'}])
  expect(h.order.filter(step => step === 'release')).toHaveLength(2)
})

test('a live query recomputes context after the real Worker computation owner is cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-owner-cancel-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  const entered = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const cancelled = Promise.withResolvers<void>()
  const snapshots: ModSnapshot[] = []
  const releases: number[] = []
  const controllers = [new AbortController(), new AbortController()]
  const running: Promise<unknown>[] = []
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const call=++calls;
        const result=await next(e);
        return {blocks:[...result.blocks,{name:'calls',text:String(call)}]};
      });
    }`)
    await runtime.reconcile([{name:'owner-cancel',storageId:'owner-cancel@inline',pluginRoot:root,entrypoints:[entry]}])
    const capture = runtime.capture
    let coreCalls = 0
    runtime.capture = services => {
      const snapshot = capture(services)
      const index = snapshots.length
      snapshots.push(snapshot)
      return {
        ...snapshot,
        get promptContexts() {
          if (index === 1) waiting.resolve()
          return snapshot.promptContexts
        },
        dispatch: (event, input, core, options) => snapshot.dispatch(event, input, async (value, signal) => {
          if (event === 'prompt.context' && ++coreCalls === 1) {
            entered.resolve()
            await new Promise<void>(resolve => {
              const abort = () => { cancelled.resolve(); resolve() }
              signal!.addEventListener('abort', abort, {once:true})
              if (signal!.aborted) abort()
            })
            signal!.throwIfAborted()
          }
          return core(value, signal)
        }, options),
        release() { releases.push(index); snapshot.release() },
      }
    }
    let requests = 0
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { requests++; yield response('survivor', 'answer') })
    h.context.mods = runtime
    h.context.abortController = controllers[0]!
    let reads = 0
    h.params.refreshUserContext = async () => ({source:`read-${++reads}`})
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    const first = drain(query(h.params)).catch(error => error)
    running.push(first)
    await entered.promise
    const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controllers[1]!}}))
    running.push(second)
    await waiting.promise
    const reason = new Error('context owner cancelled')
    controllers[0]!.abort(reason)
    expect(await first).toBe(reason)
    await cancelled.promise
    expect(await second).toMatchObject({terminal:{reason:'completed'}})
    expect(contexts).toEqual([{source:'read-2',calls:'2'}])
    expect(requests).toBe(1)
    expect(reads).toBe(2)
    expect(coreCalls).toBe(2)
    expect(controllers[1]!.signal.aborted).toBe(false)
    expect(releases.toSorted()).toEqual([0,1])
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots)
      await expect(snapshot.dispatch('prompt.context', {}, async input => input)).rejects.toThrow('snapshot released')
    expect(diagnostics).toEqual([])
  } finally {
    for (const controller of controllers) controller.abort()
    await Promise.allSettled(running)
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('concurrent queries share the pending context reread as well as its hook dispatch', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = harness(async function* () {yield response('reread','answer')})
  h.snapshot.hasHooks = event=>event==='prompt.context'
  Object.assign(h.snapshot,{promptContexts:new Map()})
  let reads = 0
  h.params.refreshUserContext = async () => {
    reads++
    entered.resolve()
    await release.promise
    return {source:'fresh'}
  }
  const first = drain(query(h.params))
  await entered.promise
  const second = drain(query(h.params))
  release.resolve()
  await Promise.all([first,second])
  expect(reads).toBe(1)
  expect(h.calls).toHaveLength(1)
})

test('context cache follows session binding without resetting on an unchanged bind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-binding-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', () => ({blocks:[{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'first'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'binding',storageId:'binding@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('binding','answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    delete h.context.agentId
    await runtime.bind({...binding})
    await drain(query(h.params))
    await runtime.bind({...binding,sessionId:'resumed'})
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'1'},{calls:'2'},{calls:'1'},{calls:'3'},{calls:'2'}])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('same-ID conversation restore invalidates main context without disturbing admitted queries or background agents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-resume-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'same-id'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'resume',storageId:'resume@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('resume','answer') })
    h.context.mods = runtime
    h.params.userContext = {source:'original'}
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    h.context.agentId = asAgentId('background')
    await drain(query(h.params))
    delete h.context.agentId
    const previous = runtime.capture()
    try {
      runtime.invalidatePromptContext()
      await runtime.bind({...binding})
      h.params.userContext = {source:'restored'}
      await drain(query(h.params))
      h.context.agentId = asAgentId('background')
      await drain(query(h.params))
      expect(await previous.promptContexts!.get(undefined)!.result).toEqual({blocks:[
        {name:'source',text:'original'},{name:'calls',text:'1'},
      ],instructionFiles:[]})
      expect(contexts).toEqual([
        {source:'original',calls:'1'}, {source:'original',calls:'2'},
        {source:'restored',calls:'3'}, {source:'original',calls:'2'},
      ])
    } finally { previous.release() }
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('ending and rebinding the same conversation recomputes its context exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-ended-'))
  const runtime = createModsRuntime()
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', () => ({blocks:[{name:'calls',text:String(++calls)}]}));
    }`)
    const binding = {cwd:root,surface:'terminal' as const,isInteractive:false,sessionId:'same-id'}
    await runtime.bind(binding)
    await runtime.reconcile([{name:'ended',storageId:'ended@inline',pluginRoot:root,entrypoints:[entry]}])
    const contexts: Record<string,string>[] = []
    const h = harness(async function* () { yield response('ended','answer') })
    h.context.mods = runtime
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      contexts.push(forkContext.userContext)
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    await runtime.endSession('resume')
    await runtime.bind({...binding})
    await drain(query(h.params))
    await runtime.bind({...binding})
    await drain(query(h.params))
    expect(contexts).toEqual([{calls:'1'},{calls:'2'},{calls:'2'}])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('successful compaction rereads context before the same query sends its model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-compact-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event=>diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let calls=0; export function register(on) {
      on('prompt.context', ($,e) => ({blocks:[...e.blocks,{name:'calls',text:String(++calls)}]}));
      on('tool.call',async $=>{await $.ui.invalidate('prompt.context');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'compact-context',storageId:'compact-context@inline',pluginRoot:root,entrypoints:[entry]}])
    const h = harness(async function* () {yield response('compact-context','answer')})
    h.context.mods = runtime
    h.params.userContext = {source:'old'}
    let refreshes = 0
    let source = 'old'
    Object.assign(h.params, {refreshUserContext:async()=>{refreshes++;return {source}}})
    let compact = false
    const boundary = createCompactBoundaryMessage('auto',100)
    const summary = createUserMessage({content:'summary'})
    const seen: Record<string,string>[] = []
    const captured: import('./utils/forkedAgent.js').CacheSafeParams[] = []
    const compactParams: import('./utils/forkedAgent.js').CacheSafeParams[] = []
    h.params.onCacheSafeParams = params => { captured.push(params) }
    h.params.deps!.autocompact = async (messages,_context,forkContext) => {
      seen.push({...forkContext.userContext})
      compactParams.push(forkContext)
      if (!compact) return {messages,wasCompacted:false}
      compact = false
      source = 'reread'
      return {wasCompacted:true,compactionResult:{
        boundaryMarker:boundary,
        summaryMessages:[summary],attachments:[],hookResults:[],
      }}
    }
    await drain(query(h.params))
    expect(refreshes).toBe(1)
    compact = true
    await drain(query(h.params))
    expect(refreshes).toBe(2)
    h.params.messages = [boundary, summary]
    await drain(query(h.params))
    expect(seen).toEqual([
      {source:'old',calls:'1'}, {source:'old',calls:'1'}, {source:'reread',calls:'2'},
    ])
    expect(captured.map(params => params.userContext)).toEqual([
      {source:'old',calls:'1'}, {source:'reread',calls:'2'}, {source:'reread',calls:'2'},
    ])
    expect(compactParams.map(params => params.resolvedPromptContextBlocks)).toEqual([
      [{name:'source',text:'old'},{name:'calls',text:'1'}],
      [{name:'source',text:'old'},{name:'calls',text:'1'}],
      [{name:'source',text:'reread'},{name:'calls',text:'2'}],
    ])
    expect(refreshes).toBe(2)
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('a persisted compact boundary invalidates only its conversation once', async () => {
  const h = harness(async function* () {yield response('boundary','answer')})
  h.snapshot.hasHooks = event=>event==='prompt.context'
  const cache = new Map()
  const boundaries = new Map()
  Object.assign(h.snapshot, {promptContexts:cache,promptContextBoundaries:boundaries})
  let calls = 0
  h.rewrite(value=>({...value,blocks:[{name:'calls',text:String(++calls)}]}))
  const seen: Record<string,string>[] = []
  h.params.deps!.autocompact = async (messages,_context,forkContext) => {
    seen.push(forkContext.userContext)
    return {messages,wasCompacted:false}
  }
  await drain(query(h.params))
  h.context.agentId = asAgentId('child')
  await drain(query(h.params))
  h.params.messages = [createCompactBoundaryMessage('manual',100),createUserMessage({content:'summary'})]
  await drain(query(h.params))
  await drain(query(h.params))
  delete h.context.agentId
  h.params.messages = []
  await drain(query(h.params))
  expect(seen).toEqual([{calls:'1'},{calls:'2'},{calls:'3'},{calls:'3'},{calls:'1'}])
})

test('real Worker prompt.context runs once for a snapshot across model recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-query-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const value = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...value.blocks, {name:'plugin',text:'extra'}]};
      });
    }`)
    await runtime.reconcile([{name:'context-query',storageId:'context-query@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('prompt.context')).toBe(true)
    const observed: any[] = []
    const dispatch = runtime.capture
    runtime.capture = () => {
      const snapshot = dispatch()
      return {...snapshot, dispatch: async (event, input, core, options) => {
        const result = await snapshot.dispatch(event,input,core,options)
        if (event === 'prompt.context') observed.push(result)
        return result
      }}
    }
    let requests = 0
    const h = harness(async function* () {
      requests++
      if (requests === 1) {
        const exhausted = response('limit','partial')
        Object.assign(exhausted, {apiError:'max_output_tokens', isApiErrorMessage:true})
        yield exhausted
      } else yield response('one','answer')
    })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    await drain(query(h.params))
    expect(requests).toBe(2)
    expect(observed).toEqual([{blocks:[{name:'currentDate',text:'today'},{name:'plugin',text:'extra'}]}])
    expect(diagnostics).toEqual([])
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('real Worker rejects duplicate context names and keeps the completed inner rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-context-invalid-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic: event => diagnostics.push(event)})
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.context', async ($, e, next) => {
        const result = await next({blocks:e.blocks.filter(block => block.name !== 'claudeMd')});
        return {blocks:[...result.blocks, {name:'currentDate',text:'duplicate'}]};
      });
    }`)
    await runtime.reconcile([{name:'invalid-context',storageId:'invalid-context@inline',pluginRoot:root,entrypoints:[entry]}])
    expect(diagnostics).toEqual([])
    let models = 0
    let compactions = 0
    const h = harness(async function* () { models++; yield response('one','answer') })
    h.context.mods = runtime
    h.params.userContext = {claudeMd:'private',currentDate:'today'}
    h.params.deps!.autocompact = async (messages, _context, forkContext) => {
      compactions++
      expect(forkContext.userContext).toEqual({currentDate:'today'})
      return {messages,wasCompacted:false}
    }
    await drain(query(h.params))
    expect(models).toBe(1)
    expect(compactions).toBe(1)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({message:expect.stringContaining('unique named text blocks')})
  } finally {
    await runtime.dispose()
    await rm(root,{recursive:true,force:true})
  }
})

test('main query completion pushes actual response usage through session.measure, never for a subagent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-query-measure-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `let events=[]; export function register(on) {
      on('session.start', ($,e,next) => {events.push('start');return next(e)});
      on('turn.complete', ($,e,next) => {events.push('complete');return next(e)});
      on('session.measure', async ($,e,next) => {events.push({input:e,usage:await $.session.usage()});return next(e)});
      on('tool.call', () => ({result:events}));
    }`)
    await runtime.reconcile([{name:'measure-query',storageId:'measure-query@inline',pluginRoot:root,entrypoints:[entry]}])
    await runtime.bind({cwd:root,sessionId:'measure-query',surface:null,isInteractive:false})
    const h = harness(async function* () {yield response('measure','actual answer',1000)})
    h.context.mods = runtime
    h.context.options.mainLoopModel = 'claude-sonnet-4-6'
    await drain(query(h.params))
    const read = () => runtime.dispatch('tool.call',{tool:'Inspect',tool_use_id:'inspect'},async () => ({result:null})) as Promise<{result:any[]}>
    const events = (await read()).result
    expect(events.slice(0,2)).toEqual(['start','complete'])
    expect(events[2].input.context).toEqual({window:200000,tokens:1007,percent:1})
    expect(events[2].input.changed).toContain('context')
    expect(events[2].usage.context).toEqual(events[2].input.context)
    h.context.agentId = asAgentId('measure-child')
    await drain(query(h.params))
    expect((await read()).result.filter(event => typeof event === 'object')).toHaveLength(1)
    h.context.agentId = undefined
    h.params.deps!.callModel = async function* () {yield response('measure-cancel','last visible answer',2000)}
    const interrupted = query(h.params)
    while (true) {
      const next = await interrupted.next()
      if (next.done) throw new Error('query never yielded its response')
      if (next.value.type === 'assistant') break
    }
    await interrupted.return({reason:'completed'} as never)
    const last = (await read()).result.filter(event => typeof event === 'object').at(-1)
    expect(last.input.context.tokens).toBe(2007)
    expect(diagnostics).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

describe('public query prompt.section', () => {
  test('cache-safe callback freezes unhooked section bytes and does not mutate the parent context', async () => {
    const captured: import('./utils/forkedAgent.js').CacheSafeParams[] = []
    const h = harness(async function* (request) {
      expect(captured).toHaveLength(1)
      expect(request.systemPrompt).toEqual(captured[0]!.systemPrompt)
      yield response('unhooked', 'done')
    })
    h.context.mods = undefined
    h.params.systemPrompt = withSystemPromptSections([{ name: 'identity', text: 'original' }])
    h.params.onCacheSafeParams = params => { captured.push(params) }
    await drain(query(h.params))
    expect(captured).toHaveLength(1)
    expect([...captured[0]!.systemPrompt]).toEqual(['original'])
    expect(getSystemPromptSections(captured[0]!.systemPrompt)).toBeUndefined()
    expect(captured[0]!.resolvedPromptContextBlocks).toEqual([])
    expect(getSystemPromptSections(h.params.systemPrompt)).toEqual([{ name: 'identity', text: 'original' }])
    expect(captured[0]!.toolUseContext.renderedSystemPrompt).toBe(captured[0]!.systemPrompt)
    expect(h.context.renderedSystemPrompt).toBeUndefined()
  })

  test('joined teammate sections keep original block separators after Worker drop and fill', async () => {
    const { concatSystemPrompts, joinSystemPrompt } = await import('./utils/systemPromptType.js')
    const root = await mkdtemp(join(tmpdir(), 'mods-section-joined-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.section', ($, e) => ({text: e.name === 'drop' ? null : 'MOD_' + e.name}));
      }`)
      await runtime.reconcile([{ name: 'joined', storageId: 'joined@inline', pluginRoot: root, entrypoints: [entry] }])
      const requests: (readonly string[])[] = []
      const h = harness(async function* (request) { requests.push(request.systemPrompt); yield response('joined', 'done') })
      h.context.mods = runtime
      h.params.systemPrompt = concatSystemPrompts(joinSystemPrompt(withSystemPromptSections([
        { name: 'identity', text: 'identity' }, { name: 'drop', text: 'drop' },
        { name: 'language', text: null }, { text: 'TEAMMATE_APPEND' },
      ]), '\n'), ['Notes'])
      expect([...h.params.systemPrompt]).toEqual(['identity\ndrop\nTEAMMATE_APPEND', 'Notes'])
      await drain(query(h.params))
      expect(requests).toEqual([['MOD_identity\nMOD_language\nTEAMMATE_APPEND', 'Notes']])
      expect(diagnostics).toEqual([])
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  test('malformed Worker answers recover inside catch and failed hooks preserve completed downstream text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-section-recovery-'))
    const diagnostics: { message: string }[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.section', {name:'caught'}, async ($,e,next) => {
          await next(e); return {text:123};
        }).catch(async ($,e,next) => ({text:(await next(e)).text+':caught'}));
        on('prompt.section', {name:'kept'}, async ($,e,next) => {
          await next({...e,text:'downstream'}); throw new Error('after next');
        });
        on('prompt.section', {name:'passthrough'}, () => {throw new Error('before next')});
        on('prompt.section', {name:'bad-input'}, ($,e,next) => next({...e,text:123}));
      }`)
      await runtime.reconcile([{name:'recovery',storageId:'recovery@inline',pluginRoot:root,entrypoints:[entry]}])
      const cores: string[] = [], requests: (readonly string[])[] = []
      const capture = runtime.capture
      runtime.capture = services => {
        const snapshot = capture(services)
        return {...snapshot,dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
          if (event === 'prompt.section') cores.push(String(value.name))
          return core(value,signal)
        },options)}
      }
      const h = harness(async function* (request) { requests.push(request.systemPrompt); yield response('recovered','done') })
      h.context.mods = runtime
      h.params.systemPrompt = withSystemPromptSections([
        {name:'caught',text:'original'}, {name:'kept',text:'original'},
        {name:'passthrough',text:'original'}, {name:'bad-input',text:'original'},
      ])
      await drain(query(h.params))
      await drain(query(h.params))
      expect(requests).toEqual([
        ['original:caught','downstream','original','original'],
        ['original:caught','downstream','original','original'],
      ])
      expect(cores).toEqual(['caught','kept','passthrough','bad-input'])
      expect(diagnostics.map(event => event.message)).toEqual([
        'prompt.section must return text', 'after next', 'before next', 'prompt.section must return text or null',
      ])
    } finally { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  })

  test('invalidation during Worker section assembly keeps the old query stable without repopulating the new cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-section-invalidation-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const running: Promise<unknown>[] = []
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `let calls=0; export function register(on) {
        on('prompt.section', async ($,e,next) => { const call=++calls; await next(e); return {text:e.name+':'+call}; });
        on('tool.call', async $ => {await $.ui.invalidate('prompt.section');return {result:'invalidated'}});
      }`)
      await runtime.reconcile([{name:'invalidation',storageId:'invalidation@inline',pluginRoot:root,entrypoints:[entry]}])
      const capture = runtime.capture
      let first = true, releases = 0
      runtime.capture = services => {
        const snapshot = capture(services)
        return {...snapshot,dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
          if (event === 'prompt.section' && first) { first=false; entered.resolve(); await release.promise }
          return core(value,signal)
        },options),release() { releases++; snapshot.release() }}
      }
      const requests: (readonly string[])[] = []
      const h = harness(async function* (request) { requests.push(request.systemPrompt); yield response('sections','done') })
      h.context.mods = runtime
      h.params.systemPrompt = withSystemPromptSections([{name:'identity',text:'original'},{name:'memory',text:null}])
      const firstQuery = drain(query(h.params))
      running.push(firstQuery)
      await entered.promise
      await runtime.dispatch('tool.call',{},async () => ({result:'core'}))
      await drain(query(h.params))
      release.resolve()
      await firstQuery
      await drain(query(h.params))
      expect(requests).toEqual([['identity:2','memory:3'],['identity:1','memory:4'],['identity:2','memory:3']])
      expect(releases).toBe(3)
      expect(diagnostics).toEqual([])
    } finally { release.resolve(); await Promise.allSettled(running); await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  })

  test.each(['owner','waiter'] as const)('cancelling the section %s preserves the other live query and releases both snapshots', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'mods-section-cancellation-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    const entered = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const controllers = [new AbortController(),new AbortController()]
    const running: Promise<unknown>[] = []
    const snapshots: ModSnapshot[] = [], releases: number[] = [], requests: (readonly string[])[] = []
    let cores = 0
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `let calls=0; export function register(on) {
        on('prompt.section', async ($,e,next) => { const call=++calls; const value=await next(e); return {text:value.text+':'+call}; });
      }`)
      await runtime.reconcile([{name:'cancel',storageId:'cancel@inline',pluginRoot:root,entrypoints:[entry]}])
      const capture = runtime.capture
      runtime.capture = services => {
        const snapshot = capture(services), index = snapshots.length
        snapshots.push(snapshot)
        return {...snapshot,get promptSections() { if (index===1) waiting.resolve(); return snapshot.promptSections },
          dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
            if (event === 'prompt.section' && ++cores===1) { entered.resolve(); await release.promise }
            return core(value,signal)
          },options),release() { releases.push(index); snapshot.release() }}
      }
      const h = harness(async function* (request) { requests.push(request.systemPrompt); yield response('survivor','done') })
      h.context.mods = runtime
      h.context.abortController = controllers[0]!
      h.params.systemPrompt = withSystemPromptSections([{name:'identity',text:'original'}])
      const captured: import('./utils/forkedAgent.js').CacheSafeParams[] = []
      h.params.onCacheSafeParams = params => { captured.push(params) }
      const first = drain(query(h.params)).catch(error => error)
      running.push(first)
      await entered.promise
      const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controllers[1]!}})).catch(error => error)
      running.push(second)
      await waiting.promise
      expect(captured).toEqual([])
      const reason = new Error('cancel '+mode)
      controllers[mode==='owner' ? 0 : 1]!.abort(reason)
      expect(await (mode==='owner' ? first : second)).toBe(reason)
      if (mode==='waiter') release.resolve()
      const deadline = Promise.withResolvers<never>()
      const timer = setTimeout(() => deadline.reject(new Error('live section query blocked by cancelled peer')),1000)
      try { expect(await Promise.race([mode==='owner' ? second : first,deadline.promise])).toMatchObject({terminal:{reason:'completed'}}) }
      finally { clearTimeout(timer) }
      expect(requests).toEqual([[mode==='owner' ? 'original:2' : 'original:1']])
      expect(captured).toHaveLength(1)
      expect([...captured[0]!.systemPrompt]).toEqual([...requests[0]!])
      expect(getSystemPromptSections(captured[0]!.systemPrompt)).toBeUndefined()
      expect(captured[0]!.toolUseContext.abortController).toBe(controllers[mode==='owner' ? 1 : 0])
      expect(cores).toBe(mode==='owner' ? 2 : 1)
      expect(releases.toSorted()).toEqual([0,1])
      expect(controllers[mode==='owner' ? 1 : 0]!.signal.aborted).toBe(false)
      for (const snapshot of snapshots)
        await expect(snapshot.dispatch('prompt.section',{},async input => input)).rejects.toThrow('snapshot released')
      expect(diagnostics).toEqual([])
    } finally { release.resolve(); controllers.forEach(controller=>controller.abort()); await Promise.allSettled(running); await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  })

  test('real Worker rewrites, drops and fills named slots, caches by name, and preserves resolved fork bytes', async () => {
    const root = await mkdtemp(join(tmpdir(),'mods-query-sections-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry,`let calls=0;export function register(on) {
        on('prompt.section',($,e) => {
          calls++;
          return {text:e.name==='drop' ? null : e.name+':'+String(e.text)+':'+calls};
        });
        on('tool.call',async $ => {await $.ui.invalidate('prompt.section');return {result:'invalidated'}});
      }`)
      await runtime.reconcile([{name:'sections',storageId:'sections@inline',pluginRoot:root,entrypoints:[entry]}])
      const requests: (readonly string[])[] = [], forks: any[] = []
      const h = harness(async function* (request) {
        requests.push(request.systemPrompt)
        yield response('section-answer','done')
      })
      h.context.mods = runtime
      h.params.systemPrompt = withSystemPromptSections([
        {name:'identity',text:'core identity'}, {text:'literal boundary'},
        {name:'drop',text:'must disappear'}, {name:'memory',text:null}, {text:'literal append'},
      ])
      h.params.deps!.autocompact = async (messages,context) => {
        forks.push(context.renderedSystemPrompt)
        return {messages,wasCompacted:false}
      }
      await drain(query(h.params))
      expect(requests[0]).toEqual(['identity:core identity:1','literal boundary','memory:null:3','literal append'])
      expect(forks[0]).toEqual(requests[0])
      expect(getSystemPromptSections(forks[0])).toBeUndefined()
      expect(h.context.renderedSystemPrompt).toBeUndefined()
      h.params.systemPrompt = withSystemPromptSections([
        {name:'identity',text:'new core'}, {text:'literal boundary'},
        {name:'drop',text:'different core'}, {name:'memory',text:'changed core'}, {text:'literal append'},
      ])
      await drain(query(h.params))
      expect(requests[1]).toEqual(requests[0])
      expect(await runtime.dispatch('tool.call',{},async () => ({result:'core'}))).toEqual({result:'invalidated'})
      await drain(query(h.params))
      expect(requests[2]).toEqual(['identity:new core:4','literal boundary','memory:changed core:6','literal append'])
      h.params.systemPrompt = asSystemPrompt(forks[0])
      await drain(query(h.params))
      expect(requests[3]).toEqual(requests[0])
      expect(diagnostics).toEqual([])
    } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
  })
})

describe('public query prompt.attachment', () => {
  test('an invalidated in-flight attachment cannot overwrite the fresh cache answer', async () => {
    const root = await mkdtemp(join(tmpdir(),'mods-attachment-inflight-'))
    const runtime = createModsRuntime()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const running: Promise<unknown>[] = []
    const requests: string[] = []
    let cores = 0
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `let calls=0; export function register(on) {
        on('prompt.attachment',async ($,e,next) => {const n=++calls;await next(e);return {text:'GEN_'+n}});
        on('tool.call',async $ => {await $.ui.invalidate('prompt.attachment');return {result:'invalidated'}});
      }`)
      await runtime.reconcile([{name:'inflight',storageId:'inflight@inline',pluginRoot:root,entrypoints:[entry]}])
      const capture = runtime.capture
      runtime.capture = services => {
        const snapshot = capture(services)
        return {...snapshot,dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
          if(event==='prompt.attachment' && ++cores===1) {entered.resolve();await release.promise}
          return core(value,signal)
        },options)}
      }
      const h = harness(async function* (request) {requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)));yield response('inflight','done')})
      h.context.mods = runtime
      h.params.messages.push(createAttachmentMessage({type:'edited_text_file',filename:'/fixture.ts',snippet:'original'}))
      const first = drain(query(h.params)); running.push(first)
      await entered.promise
      await runtime.dispatch('tool.call',{},async () => ({result:'core'}))
      await drain(query(h.params))
      release.resolve(); await first
      await drain(query(h.params))
      expect(requests[0]).toContain('GEN_2')
      expect(requests[1]).toContain('GEN_1')
      expect(requests[2]).toContain('GEN_2')
    } finally {release.resolve();await Promise.allSettled(running);await runtime.dispose();await rm(root,{recursive:true,force:true})}
  })

  test('an old snapshot cannot seed a new attachment key after invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(),'mods-attachment-generation-'))
    const runtime = createModsRuntime()
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const running: Promise<unknown>[] = []
    const requests: string[] = []
    let cores = 0
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `let generation='OLD'; export function register(on) {
        on('prompt.attachment',async ($,e,next) => {const value=generation;await next(e);return {text:value+'_'+e.text}});
        on('tool.call',async $ => {generation='NEW';await $.ui.invalidate('prompt.attachment');return {result:'invalidated'}});
      }`)
      await runtime.reconcile([{name:'generation',storageId:'generation@inline',pluginRoot:root,entrypoints:[entry]}])
      const capture = runtime.capture
      runtime.capture = services => {
        const snapshot = capture(services)
        return {...snapshot,dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
          if(event==='prompt.attachment' && ++cores===1) {entered.resolve();await release.promise}
          return core(value,signal)
        },options)}
      }
      const h = harness(async function* (request) {requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)));yield response('generation','done')})
      h.context.mods = runtime
      h.params.messages.push(
        createAttachmentMessage({type:'edited_text_file',filename:'/first.ts',snippet:'first'}),
        createAttachmentMessage({type:'edited_text_file',filename:'/second.ts',snippet:'second'}),
      )
      const first = drain(query(h.params)); running.push(first)
      await entered.promise
      await runtime.dispatch('tool.call',{},async () => ({result:'core'}))
      h.params.messages.pop()
      await drain(query(h.params))
      release.resolve(); await first
      h.params.messages.push(createAttachmentMessage({type:'edited_text_file',filename:'/second.ts',snippet:'second'}))
      await drain(query(h.params))
      expect(requests[0]).toContain('NEW_')
      expect(requests[0]).toContain('first')
      expect(requests[1]).toContain('OLD_')
      expect(requests[1]).toContain('second')
      expect(requests[2]).toContain('NEW_')
      expect(requests[2]).toContain('second')
    } finally {release.resolve();await Promise.allSettled(running);await runtime.dispose();await rm(root,{recursive:true,force:true})}
  })

  test('joins framed text for one Worker call and preserves media and display-only attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-media-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', ($,e) => {
          if(e.type==='queued_command') return {text:'QUEUED_MEDIA_REWRITE'};
          if(e.type!=='directory') throw new Error('display-only attachment dispatched');
          if(e.text.includes('<system-reminder>')||!e.text.includes('Called the Bash tool')||!e.text.includes('fixture-file')) throw new Error('text not joined');
          return {text:'DIRECTORY_REWRITE'};
        });
      }`)
      await runtime.reconcile([{name:'media',storageId:'media@inline',pluginRoot:root,entrypoints:[entry]}])
      const requests: string[] = []
      const h = harness(async function* (request) {
        requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)))
        yield response('attachment-media','done')
      })
      h.context.mods = runtime
      h.params.messages.push(
        createAttachmentMessage({type:'directory',path:'/fixture',displayPath:'fixture',content:'fixture-file'}),
        createAttachmentMessage({type:'queued_command',prompt:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}]}),
        createAttachmentMessage({type:'dynamic_skill',skillDir:'/fixture',skillNames:['fixture'],displayPath:'fixture'}),
      )
      const transcript = structuredClone(h.params.messages)
      await drain(query(h.params))
      expect(requests[0]).toContain('DIRECTORY_REWRITE')
      expect(requests[0]).not.toContain('fixture-file')
      expect(requests[0]).toContain('aW1hZ2U=')
      expect(requests[0]).toContain('QUEUED_MEDIA_REWRITE')
      expect(h.params.messages).toEqual(transcript)
      expect(diagnostics).toEqual([])
    } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
  })

  test.each(['owner', 'waiter'] as const)('cancelling the attachment cache %s does not cancel the other request', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-cancel-'))
    const runtime = createModsRuntime()
    const entered = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const controllers = [new AbortController(), new AbortController()]
    const running: Promise<unknown>[] = []
    const requests: string[] = []
    let cores = 0, captures = 0
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `let calls=0; export function register(on) {
        on('prompt.attachment', async ($,e,next) => { const n=++calls; const result=await next(e); return {text:'LIVE_'+n}; });
      }`)
      await runtime.reconcile([{name:'cancel-attachment',storageId:'cancel-attachment@inline',pluginRoot:root,entrypoints:[entry]}])
      const capture = runtime.capture
      runtime.capture = services => {
        const snapshot = capture(services), index = captures++
        return {...snapshot,
          get promptAttachments() { if(index===1) waiting.resolve(); return snapshot.promptAttachments },
          dispatch:(event,input,core,options) => snapshot.dispatch(event,input,async (value,signal) => {
            if(event==='prompt.attachment' && ++cores===1) { entered.resolve(); await release.promise }
            return core(value,signal)
          },options),
        }
      }
      const h = harness(async function* (request) { requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages))); yield response('cancel-attachment','done') })
      h.context.mods = runtime
      h.context.abortController = controllers[0]!
      h.params.messages.push(createAttachmentMessage({type:'edited_text_file',filename:'/fixture.ts',snippet:'original'}))
      const first = drain(query(h.params)).catch(error => error)
      running.push(first)
      await entered.promise
      const second = drain(query({...h.params,toolUseContext:{...h.context,abortController:controllers[1]!}})).catch(error => error)
      running.push(second)
      await waiting.promise
      controllers[mode==='owner' ? 0 : 1]!.abort(new Error('cancel attachment'))
      release.resolve()
      await Promise.all(running)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain(mode==='owner' ? 'LIVE_2' : 'LIVE_1')
    } finally { release.resolve(); await Promise.allSettled(running); await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  })

  test('Worker restores omitted identity and rejects metadata rewrites before callModel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-pins-'))
    const diagnostics: { message: string }[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', {type:'nested_memory'}, ($,e,next) => next({text:'OMITTED_METADATA'}));
        on('prompt.attachment', {type:'nested_memory'}, ($,e,next) => {
          if(e.origin.kind!=='engine'||e.agentId!=='attachment-agent') throw new Error('lost metadata');
          return next({...e,text:e.text+':restored'});
        });
        on('prompt.attachment', {type:'edited_text_file'}, ($,e,next) => next({...e,type:'skill_listing',text:'BAD_TYPE'}));
        on('prompt.attachment', {type:'skill_listing'}, ($,e,next) => next({...e,origin:{kind:'hook',event:'SessionStart'},text:'BAD_ORIGIN'}));
        on('prompt.attachment', {type:'date_change'}, ($,e,next) => next({...e,agentId:'spoofed',text:'BAD_AGENT'}));
        on('prompt.attachment', {type:'hook_additional_context'}, ($,e,next) => {
          if(e.origin.kind!=='hook'||e.origin.event!=='UserPromptSubmit') throw new Error('wrong hook author');
          return next({...e,text:123});
        });
        on('prompt.attachment', {type:'todo_reminder'}, () => ({text:123})).catch(() => ({text:'RECOVERED_TODO'}));
      }`)
      await runtime.reconcile([{name:'pins',storageId:'pins@inline',pluginRoot:root,entrypoints:[entry]}])
      expect(diagnostics).toEqual([])
      expect(runtime.hasHooks('prompt.attachment')).toBe(true)
      const requests: string[] = []
      const h = harness(async function* (request) {
        requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)))
        yield response('attachment-pins', 'done')
      })
      h.context.mods = runtime
      h.context.agentId = asAgentId('attachment-agent')
      h.params.messages.push(
        createAttachmentMessage(memoryFilesToAttachments([{path:'/project/CLAUDE.md',type:'Project',content:'MEMORY_ORIGINAL'}], h.context)[0]!),
        createAttachmentMessage({type:'edited_text_file',filename:'/project/file.ts',snippet:'EDIT_ORIGINAL'}),
        createAttachmentMessage({type:'skill_listing',content:'SKILL_ORIGINAL',skillCount:1,isInitial:true}),
        createAttachmentMessage({type:'date_change',newDate:'DATE_ORIGINAL'}),
        createAttachmentMessage({type:'hook_additional_context',content:['HOOK_ORIGINAL'],hookName:'fixture',hookEvent:'UserPromptSubmit',toolUseID:'fixture'}),
        createAttachmentMessage({type:'todo_reminder',content:[],itemCount:0}),
      )
      await drain(query(h.params))
      expect(requests[0]).toContain('OMITTED_METADATA:restored')
      for (const text of ['EDIT_ORIGINAL','SKILL_ORIGINAL','DATE_ORIGINAL','HOOK_ORIGINAL','RECOVERED_TODO']) expect(requests[0]).toContain(text)
      for (const text of ['BAD_TYPE','BAD_ORIGIN','BAD_AGENT']) expect(requests[0]).not.toContain(text)
      expect(diagnostics.map(event => event.message)).toEqual([
        'prompt.attachment cannot rewrite type', 'prompt.attachment cannot rewrite origin',
        'prompt.attachment cannot rewrite agentId', 'prompt.attachment requires text',
        'prompt.attachment must return text',
      ])
    } finally { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
  })

  test('attributes Mod chain context to the producing plugin event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-plugin-origin-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
    try {
      const entry = join(root,'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', {type:'hook_additional_context'}, ($,e) => ({text:e.origin.kind+':'+e.origin.event+':'+e.text}));
      }`)
      await runtime.reconcile([{name:'plugin-origin',storageId:'plugin-origin@inline',pluginRoot:root,entrypoints:[entry]}])
      const requests: string[] = []
      const h = harness(async function* (request) {requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)));yield response('attachment-plugin-origin','done')})
      h.context.mods = runtime
      h.params.messages.push(createAttachmentMessage({
        type:'hook_additional_context',content:['PLUGIN_CONTEXT'],hookName:'prompt.submit',
        hookEvent:'UserPromptSubmit',toolUseID:'plugin-context',modEvent:'prompt.submit',
      }))
      await drain(query(h.params))
      expect(requests[0]).toContain('plugin:prompt.submit:prompt.submit hook additional context: PLUGIN_CONTEXT')
      expect(diagnostics).toEqual([])
    } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
  })

  test('nested memory and skill listing answers cache per attachment and recompute after Worker invalidation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-cache-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `let calls = 0; export function register(on) {
        on('prompt.attachment', ($, e) => ({ text: e.type === 'skill_listing' ? null : 'MEMORY_' + (++calls) + ':' + e.text }));
        on('tool.call', async $ => { await $.ui.invalidate('prompt.attachment'); return { result: 'invalidated' }; });
      }`)
      await runtime.reconcile([{ name: 'cache', storageId: 'cache@inline', pluginRoot: root, entrypoints: [entry] }])
      const requests: string[] = []
      const h = harness(async function* (request) {
        requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)))
        yield response('attachment-cache', 'done')
      })
      h.context.mods = runtime
      h.params.messages.push(
        ...memoryFilesToAttachments([{ path: '/project/nested/CLAUDE.md', type: 'Project', content: 'NESTED_MEMORY' }], h.context).map(createAttachmentMessage),
        createAttachmentMessage({ type: 'skill_listing', content: 'SKILL_LISTING', skillCount: 1, isInitial: true }),
      )
      const transcript = structuredClone(h.params.messages)
      await drain(query(h.params))
      // A copied record is still the same attachment, not a cache miss.
      await drain(query({ ...h.params, messages: structuredClone(h.params.messages) }))
      expect(requests[0]).toContain('MEMORY_1:Contents of /project/nested/CLAUDE.md:')
      expect(requests[1]).toContain('MEMORY_1:Contents of /project/nested/CLAUDE.md:')
      expect(requests.every(request => !request.includes('SKILL_LISTING'))).toBe(true)
      expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({ result: 'invalidated' })
      await drain(query(h.params))
      expect(requests[2]).toContain('MEMORY_2:Contents of /project/nested/CLAUDE.md:')
      expect(requests[2]).not.toContain('SKILL_LISTING')
      // Same contents, new record: ask again rather than caching by text/type.
      h.params.messages[1] = { ...h.params.messages[1]!, uuid: randomUUID() }
      await drain(query(h.params))
      expect(requests[3]).toContain('MEMORY_3:Contents of /project/nested/CLAUDE.md:')
      expect(transcript[1]).toEqual({ ...h.params.messages[1], uuid: transcript[1]!.uuid, timestamp: transcript[1]!.timestamp })
      expect(diagnostics).toEqual([])
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  test('autocompaction and the model consume the same projected attachment bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-sizing-'))
    const runtime = createModsRuntime()
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', ($, e) => ({text: 'PROJECTED_ATTACHMENT'}));
      }`)
      await runtime.reconcile([{name:'attachment-sizing',storageId:'attachment-sizing@inline',pluginRoot:root,entrypoints:[entry]}])
      const compactInputs: string[] = []
      const modelInputs: string[] = []
      const h = harness(async function* (request) {
        modelInputs.push(JSON.stringify(normalizeMessagesForAPI(request.messages)))
        yield response('attachment-sizing', 'done')
      })
      h.context.mods = runtime
      h.params.messages.push(createAttachmentMessage({
        type: 'edited_text_file',
        filename: '/fixture.ts',
        snippet: 'UNPROJECTED_ATTACHMENT',
      }))
      h.params.deps!.autocompact = async messages => {
        compactInputs.push(JSON.stringify(normalizeMessagesForAPI(messages)))
        return {messages, wasCompacted: false}
      }
      const transcript = structuredClone(h.params.messages)
      await drain(query(h.params))
      expect(compactInputs).toHaveLength(1)
      expect(compactInputs[0]).toContain('PROJECTED_ATTACHMENT')
      expect(compactInputs[0]).not.toContain('UNPROJECTED_ATTACHMENT')
      expect(modelInputs[0]).toContain('PROJECTED_ATTACHMENT')
      expect(modelInputs[0]).not.toContain('UNPROJECTED_ATTACHMENT')
      expect(h.params.messages).toEqual(transcript)
    } finally {
      await runtime.dispose()
      await rm(root, {recursive: true, force: true})
    }
  })

  test('blocking limit uses projected attachment bytes', async () => {
    const savedCompact = process.env.DISABLE_AUTO_COMPACT
    const savedLimit = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-blocking-'))
    const runtime = createModsRuntime()
    try {
      process.env.DISABLE_AUTO_COMPACT = '1'
      process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = '700'
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', () => ({text:''}));
      }`)
      await runtime.reconcile([{name:'attachment-blocking',storageId:'attachment-blocking@inline',pluginRoot:root,entrypoints:[entry]}])
      let modelCalls = 0
      const h = harness(async function* () {
        modelCalls++
        yield response('attachment-blocking', 'done')
      })
      h.context.mods = runtime
      h.params.messages.push(createAttachmentMessage({
        type: 'edited_text_file',
        filename: '/fixture.ts',
        snippet: 'x'.repeat(2000),
      }))
      const result = await drain(query(h.params))
      expect(result.terminal.reason).toBe('completed')
      expect(modelCalls).toBe(1)
    } finally {
      if (savedCompact === undefined) delete process.env.DISABLE_AUTO_COMPACT
      else process.env.DISABLE_AUTO_COMPACT = savedCompact
      if (savedLimit === undefined)
        delete process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
      else process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = savedLimit
      await runtime.dispose()
      await rm(root, {recursive: true, force: true})
    }
  })

  test('Worker rewrites a real attachment only in the model request, not the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-attachment-'))
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('prompt.attachment', { type: 'edited_text_file' }, async ($, e, next) => {
          if (e.origin.kind !== 'engine' || e.agentId !== undefined || e.text.includes('<system-reminder>'))
            throw new Error('invalid attachment input');
          return next({ ...e, text: 'MODEL_EDITED_TEXT' });
        });
      }`)
      await runtime.reconcile([{ name: 'attachments', storageId: 'attachments@inline', pluginRoot: root, entrypoints: [entry] }])
      const requests: string[] = []
      const h = harness(async function* (request) {
        requests.push(JSON.stringify(normalizeMessagesForAPI(request.messages)))
        yield response('attachment', 'done')
      })
      h.context.mods = runtime
      h.params.messages.push(createAttachmentMessage({ type: 'edited_text_file', filename: '/project/file.ts', snippet: 'ORIGINAL_EDITED_TEXT' }))
      const transcript = structuredClone(h.params.messages)
      await drain(query(h.params))
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain('<system-reminder>\\nMODEL_EDITED_TEXT\\n</system-reminder>')
      expect(requests[0]).not.toContain('ORIGINAL_EDITED_TEXT')
      expect(h.params.messages).toEqual(transcript)
      expect(diagnostics).toEqual([])
    } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})

test('main query publishes completed cache-safe fork snapshot and sends tool-less choice', async () => {
  const requests: any[] = [], snapshots: any[] = []
  const h = harness(async function* (request) {requests.push(request);yield response('fork-parent','completed')})
  Object.assign(h.context.mods!, {captureForkSnapshotWriter:() => (value: unknown) => snapshots.push(value)})
  h.params.toolChoice = {type:'none'}
  await drain(query(h.params))
  expect(requests[0].options.toolChoice).toEqual({type:'none'})
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].forkContextMessages.at(-1).message.content).toEqual([{type:'text',text:'completed'}])
  h.context.agentId = asAgentId('child')
  await drain(query(h.params))
  expect(snapshots).toHaveLength(1)
})

test('query projects dynamic tools on first and later prompts without retaining retired registrations', async () => {
  const { z } = await import('zod/v4')
  const base = {name:'BaseFixture',inputSchema:z.object({})} as unknown as Tool
  const first = {name:'mcp__fixture__dynamic',inputSchema:z.object({})} as unknown as Tool
  const replacement = {...first} as Tool
  let current: Tool | undefined = first
  const owned = new Set([first, replacement])
  const requests: (readonly Tool[])[] = []
  const h = harness(async function* (request) {
    requests.push(request.tools)
    yield response('dynamic-projection', 'done')
  })
  h.context.options.tools = [base]
  Object.assign(h.context.mods!, {
    tools: {
      projection: (tools: readonly Tool[]) => [
        ...tools.filter(tool => !owned.has(tool)),
        ...(current ? [current] : []),
      ],
    },
  })
  await drain(query(h.params))
  expect(requests[0]).toEqual([base, first])
  h.context.options.tools = requests[0]!
  current = replacement
  await drain(query(h.params))
  expect(requests[1]).toEqual([base, replacement])
  expect(requests[1]![1]).toBe(replacement)
  h.context.options.tools = requests[1]!
  current = undefined
  await drain(query(h.params))
  expect(requests[2]).toEqual([base])
})

test('session.start dynamic tool enters the first query schema and real executor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mods-query-dynamic-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry, `export function register(on) {
      on('session.start',async ($,e,next) => {
        await $.tool.register({name:'echo',description:'Dynamic echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}});
        return next(e);
      });
      on('tool.call',{tool:'mcp__dynamic__echo'},($,e) => ({result:'dynamic:'+e.text}));
    }`)
    await runtime.reconcile([{name:'dynamic',storageId:'dynamic@inline',pluginRoot:root,entrypoints:[entry]}])
    await runtime.bind({cwd:root,surface:null,isInteractive:false,sessionId:'query-dynamic'})
    let requests = 0
    const h = harness(async function* (request) {
      const tool = request.tools.find(tool => tool.name === 'mcp__dynamic__echo')
      expect(tool).toBeDefined()
      expect(tool!.inputJSONSchema).toMatchObject({type:'object',required:['text']})
      if (++requests === 1) yield createAssistantMessage({content:[{
        type:'tool_use',caller:{type:'direct'},id:'dynamic-call',name:tool!.name,input:{text:'first'},
      }]})
      else yield response('dynamic-answer','done')
    })
    h.context.mods = runtime
    const result = await drain(query(h.params))
    expect(result.terminal.reason).toBe('completed')
    expect(requests).toBe(2)
    expect(result.messages.flatMap(message => message.type === 'user' && Array.isArray(message.message.content) ? message.message.content : []))
      .toContainEqual(expect.objectContaining({type:'tool_result',tool_use_id:'dynamic-call',content:'dynamic:first'}))
    expect(diagnostics).toEqual([])
  } finally { await runtime.dispose(); await rm(root,{recursive:true,force:true}) }
})

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import { createModsRuntime } from '../mods/runtime.js'
import { call } from '../../commands/compact/compact.js'
import compactCommand from '../../commands/compact/index.js'
import { processSlashCommand } from '../../utils/processUserInput/processSlashCommand.js'
import { autoCompactIfNeeded, getAutoCompactThreshold } from './autoCompact.js'
import * as compact from './compact.js'
import * as codex from './codexCompact.js'
import * as memory from './sessionMemoryCompact.js'
import * as cleanup from './postCompactCleanup.js'
import * as mode from './compactMode.js'
import * as config from '../../utils/config.js'
import * as tokens from '../../utils/tokens.js'
import {
  createAssistantMessage,
  createUserMessage,
  createCompactBoundaryMessage,
} from '../../utils/messages.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { resetStateForTests } from '../../bootstrap/state.js'
import { query, type QueryParams } from '../../query.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import type { Message } from '../../types/message.js'
import { asAgentId } from '../../types/ids.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime>
let diagnostics: unknown[]
let saved: (string | undefined)[]
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']
const restores: (() => void)[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-compact-'))
  saved = envKeys.map(key => process.env[key])
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
  resetSettingsCache()
  resetStateForTests()
  diagnostics = []
  runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  for (const stub of [
    spyOn(mode, 'getCompactMode').mockReturnValue('claude'),
    spyOn(config, 'getGlobalConfig').mockReturnValue({ autoCompactEnabled: true } as never),
    spyOn(tokens, 'tokenCountWithEstimation').mockReturnValue(190000),
    spyOn(cleanup, 'runPostCompactCleanup').mockImplementation(() => {}),
    spyOn(memory, 'trySessionMemoryCompaction').mockImplementation(async () => { throw new Error('unexpected compaction core') }),
    spyOn(compact, 'compactConversation').mockImplementation(async () => { throw new Error('unexpected summarizer') }),
  ]) restores.push(() => stub.mockRestore())
})
afterEach(async () => {
  try {
    await runtime.dispose()
  } finally {
    for (const restore of restores.splice(0)) restore()
    resetSettingsCache()
    resetStateForTests()
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    await rm(root, { recursive: true, force: true })
  }
})
async function register(source: string) {
  const entry = join(root, 'compact.ts')
  await writeFile(entry, source)
  await runtime.reconcile([{ name: 'compact', storageId: 'compact@test', pluginRoot: root, entrypoints: [entry] }])
}
function context(): Parameters<typeof call>[1] {
  let state = getDefaultAppState()
  return {
    getAppState: () => state, setAppState: update => { state = update(state) },
    readFileState: createFileStateCacheWithSizeLimit(10),
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
    mods: runtime,
    messages: [createUserMessage({ content: 'original' }), createAssistantMessage({ content: 'old answer' })],
    options: { mainLoopModel: 'claude-sonnet-4-6', verbose: true, tools: [], commands: [], debug: false,
      ideInstallationStatus: null, theme: 'dark',
      thinkingConfig: {type:'disabled'}, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false,
      agentDefinitions: {activeAgents:[],allAgents:[],allowedAgentTypes:undefined} },
    abortController: new AbortController(),
    setMessages() {}, onChangeAPIKey() {},
  } as Parameters<typeof call>[1]
}
function coreResult(messages: Message[] = [createUserMessage({content:'core summary',isCompactSummary:true,isMeta:true})]): compact.CompactionResult {
  return { boundaryMarker:createCompactBoundaryMessage('auto',190000),summaryMessages:[],messagesToKeep:messages,attachments:[],hookResults:[],preCompactTokenCount:190000,postCompactTokenCount:20 }
}
function params(ctx: ToolUseContext) {
  return { toolUseContext: ctx, systemPrompt: [], userContext: {}, systemContext: {}, forkContextMessages: ctx.messages } as any
}

test('manual compact consumes a real Worker replacement instead of running the compaction core', async () => {
  await register(`export function register(on) {
    on('session.compact', {trigger:'manual'}, ($,e,next) => ({messages:[{role:'user',text:e.trigger+':'+e.instructions+':'+next.origin.plugin,toolUses:[]}]}));
  }`)
  expect(diagnostics).toEqual([])
  const result = await call(' preserve plan ', context())
  expect(result.type).toBe('compact')
  if (result.type !== 'compact') throw new Error('expected installed compaction')
  const messages = compact.buildPostCompactMessages(result.compactionResult)
  expect(messages.filter(m => m.type === 'user').map(m => m.message.content)).toEqual([
    [{ type: 'text', text: 'manual:preserve plan:engine' }],
  ])
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(compact.compactConversation).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test('manual compact without a calling snapshot exposes captured usage', async () => {
  await register(`export function register(on) {
    on('session.compact', async ($,e) => ({messages:[{role:'user',text:'manual window '+(await $.session.usage()).context.window,toolUses:[]}]}));
  }`)
  const result = await call('', context())
  expect(result.type).toBe('compact')
  if (result.type !== 'compact')
    throw new Error('expected compaction with request context')
  expect(
    JSON.stringify(compact.buildPostCompactMessages(result.compactionResult)),
  ).toContain('manual window 200000')
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test('compaction retains the calling snapshot generation and request services', async () => {
  await register(`export function register(on) {
    on('session.compact', async ($,e) => ({messages:[{role:'user',text:'captured window '+(await $.session.usage()).context.window,toolUses:[]}]}));
  }`)
  const snapshot = runtime.capture({captureUsage: () => async () => ({context:{window:123456},rateLimits:[]})})
  try {
    await runtime.reconcile([])
    const ctx = context()
    ctx.modsSnapshot = snapshot
    const result = await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')
    expect(result.wasCompacted).toBe(true)
    expect(JSON.stringify(compact.buildPostCompactMessages(result.compactionResult!))).toContain('captured window 123456')
    expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
    expect(await snapshot.dispatch('session.compact',{trigger:'auto',messages:[]},async () => ({skip:'no active hook'}))).toMatchObject({
      messages:[{text:'captured window 123456'}],
    })
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('auto compact consumes a Worker veto without replacing messages or reporting a failed summary', async () => {
  await register(`export function register(on) {on('session.compact',{trigger:'auto'},()=>({skip:'keep current conversation'}));}`)
  expect(diagnostics).toEqual([])
  const ctx = context()
  const result = await autoCompactIfNeeded(ctx.messages, ctx, params(ctx), 'repl_main_thread')
  expect(result).toEqual({ wasCompacted: false, skip: 'keep current conversation' })
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(compact.compactConversation).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test('auto rewrite reaches the summarizer and cache context, preserves handles and unwinds hooks in order', async () => {
  await register(`export function register(on) {
    on('session.compact', async ($,e,next) => {
      if(next.event!=='session.compact'||next.origin.plugin!=='engine'||next.signal.aborted) throw Error('wrong context');
      const result=await next({trigger:e.trigger,instructions:'outer',messages:[{...e.messages[1],text:'ignored due to handle'}, {role:'user',text:'inserted',toolUses:[]}]});
      return {...result,messages:[...result.messages,{role:'assistant',text:'outer-after',toolUses:[]}]};
    });
    on('session.compact', async ($,e,next) => {
      if(e.agentId!=='fork-one'||e.instructions!=='outer') throw Error('lost pinned context');
      const result=await next({...e,instructions:e.instructions+':inner'});
      return {...result,messages:[...result.messages,{role:'user',text:'inner-after',toolUses:[]}]};
    });
  }`)
  const ctx=context();ctx.agentId=asAgentId('fork-one')
  let coreMessages: Message[] = []
  const summary=coreResult()
  spyOn(compact,'compactConversation').mockImplementation(async (messages, context, cache, _suppress, instructions) => {
    coreMessages=messages
    expect(instructions).toBe('outer:inner')
    expect(context.messages).toBe(messages)
    expect(cache.forkContextMessages).toBe(messages)
    expect(cache.toolUseContext).toBe(context)
    expect(context.agentId).toBe(asAgentId('fork-one'))
    return summary
  })
  const result=await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')
  expect(result.wasCompacted).toBe(true)
  expect(coreMessages[0]).toBe(ctx.messages[1])
  expect(coreMessages[1]?.type==='user' && coreMessages[1].message.content).toEqual([{type:'text',text:'inserted'}])
  const output=compact.buildPostCompactMessages(result.compactionResult!)
  expect(output[1]).toBe(summary.messagesToKeep![0]!)
  expect(output[0]?.uuid).not.toBe(summary.boundaryMarker.uuid)
  expect((output[0] as any).compactMetadata.preservedSegment).toEqual({headUuid:output[1]!.uuid,anchorUuid:output[0]!.uuid,tailUuid:output.at(-1)!.uuid})
  expect(output.slice(2).map(m => (m as any).message.content[0].text)).toEqual(['inner-after','outer-after'])
  expect(result.compactionResult?.preCompactTokenCount).toBe(190000)
  expect(result.compactionResult?.postCompactTokenCount).toBe(20)
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test('Codex auto compact receives rewritten messages and instructions under the same event', async () => {
  await register(`export function register(on) {on('session.compact',($,e,next)=>next({...e,instructions:'codex keep',messages:[{role:'user',text:'codex input',toolUses:[]}]}));}`)
  const ctx=context(), expected=coreResult()
  spyOn(mode,'getCompactMode').mockReturnValue('codex')
  const stub=spyOn(codex,'compactConversationCodexStyle').mockImplementation(async (messages, context, cache, suppress, instructions, auto) => {
    expect((messages[0] as any).message.content).toEqual([{type:'text',text:'codex input'}])
    expect(context.messages).toBe(messages)
    expect(cache.forkContextMessages).toBe(messages)
    expect([suppress,instructions,auto]).toEqual([true,'codex keep',true])
    return expected
  })
  restores.push(()=>stub.mockRestore())
  expect((await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')).compactionResult).toBe(expected)
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(compact.compactConversation).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test.each(['manual','auto'] as const)('%s next passthrough preserves the complete session-memory result', async trigger => {
  await register(`export function register(on) {on('session.compact',($,e,next)=>next(e));}`)
  const ctx=context()
  const result=coreResult()
  spyOn(memory,'trySessionMemoryCompaction').mockResolvedValue(result)
  const output=trigger==='manual' ? await call('',ctx) : await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')
  expect((output as any).compactionResult).toBe(result)
  expect(memory.trySessionMemoryCompaction).toHaveBeenCalledTimes(1)
  expect(compact.compactConversation).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test.each([
  ["next({...e,trigger:'plugin'})", 'trigger or agentId'],
  ["next({...e,agentId:'someone-else'})", 'trigger or agentId'],
  ["next({...e,instructions:12})", 'instructions'],
  ["next({...e,messages:[{...e.messages[0],handle:'unknown'}]})", 'unknown message handle'],
  ["({messages:[],skip:'both'})", 'messages or skip'],
  ["({messages:[{role:'user',text:'x',toolUses:[]}],tokensAfter:-1})", 'token counts'],
  ["({messages:[],tokensAfter:Infinity})", 'Non-finite module value'],
])('malformed compact rewrite/result recovers inside the Worker catch: %s', async (expression, error) => {
  await register(`export function register(on) {
    on('session.compact',($,e,next)=>${expression}).catch(($,e,next)=>({skip:next.error.message}));
  }`)
  const result=await call('',context())
  expect(result.type).toBe('text')
  expect((result as any).value).toContain(error)
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([expect.objectContaining({stage:'session.compact',message:expect.stringContaining(error)})])
})

test('cancelled Worker compaction forwards cancellation to the core and never installs late output', async () => {
  await register(`export function register(on) {on('session.compact',async($,e,next)=>{const result=await next(e);return result;});}`)
  const ctx=context(), entered=Promise.withResolvers<AbortSignal>(), release=Promise.withResolvers<void>()
  spyOn(memory,'trySessionMemoryCompaction').mockResolvedValue(null)
  spyOn(compact,'compactConversation').mockImplementation(async (_messages, context) => {
    entered.resolve(context.abortController.signal);await release.promise;return coreResult()
  })
  const pending=autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')
  const signal=await entered.promise
  ctx.abortController.abort(new Error('cancel compact'))
  expect(signal.aborted).toBe(true)
  release.resolve()
  const result=await pending
  expect(result.wasCompacted).toBe(false)
  expect(result.compactionResult).toBeUndefined()
  expect(result.compactionFailure).toBeUndefined()
  expect(cleanup.runPostCompactCleanup).not.toHaveBeenCalled()
})

test('manual cancellation before dispatch rejects without running Worker or core', async () => {
  await register(`export function register(on) {on('session.compact',()=>({messages:[{role:'user',text:'late',toolUses:[]}]}));}`)
  const ctx=context();ctx.abortController.abort()
  await expect(call('',ctx)).rejects.toThrow('Compaction canceled.')
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(cleanup.runPostCompactCleanup).not.toHaveBeenCalled()
})

test('a veto after downstream compaction preserves the transcript and skips commit cleanup', async () => {
  await register(`export function register(on) {on('session.compact',async($,e,next)=>{await next(e);return {skip:'retain original'};});}`)
  const ctx=context(), original=[...ctx.messages]
  spyOn(memory,'trySessionMemoryCompaction').mockResolvedValue(coreResult())
  const result=await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')
  expect(result).toEqual({wasCompacted:false,skip:'retain original'})
  expect(ctx.messages).toEqual(original)
  expect(memory.trySessionMemoryCompaction).toHaveBeenCalledTimes(1)
  expect(cleanup.runPostCompactCleanup).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test.each(["({messages:[]})", "({skip:''})"])('empty compact outcomes recover instead of clearing the conversation: %s', async expression => {
  await register(`export function register(on) {on('session.compact',()=>${expression}).catch(()=>({skip:'recovered empty'}));}`)
  expect(await call('',context())).toEqual({type:'text',value:'recovered empty'})
  expect(diagnostics).toHaveLength(1)
})

test('built tool blocks are installed and old handles cannot escape to a later compaction', async () => {
  await register(`let saved;export function register(on) {
    on('session.compact',($,e)=>{
      if(saved)return {messages:[saved]};
      saved=e.messages[0];
      return {messages:[
        {role:'assistant',text:'calling',toolUses:[{tool_use_id:'new-call',tool:'Read',input:{path:'x'}}]},
        {role:'user',text:'result',toolUses:[],toolResults:[{tool_use_id:'new-call',text:'answer',isError:false,result:{data:1}}]}
      ]};
    }).catch(($,e,next)=>({skip:next.error.message}));
  }`)
  const ctx=context(), first=await call('',ctx)
  expect(first.type).toBe('compact')
  const output=compact.buildPostCompactMessages((first as any).compactionResult)
  expect((output[1] as any).message.content).toEqual([{type:'text',text:'calling'},{type:'tool_use',id:'new-call',name:'Read',input:{path:'x'}}])
  expect((output[2] as any).message.content).toEqual([{type:'text',text:'result'},{type:'tool_result',tool_use_id:'new-call',content:'answer',is_error:false}])
  expect(await call('',ctx)).toEqual({type:'text',value:'session.compact unknown message handle'})
})

test('compact sees the whole transcript beyond the session reader limit', async () => {
  await register(`export function register(on) {on('session.compact',($,e)=>({messages:[{role:'user',text:String(e.messages.length)+':'+e.messages[0].text,toolUses:[]}]}));}`)
  const ctx=context();ctx.messages=Array.from({length:4100},(_,i)=>createUserMessage({content:'row-'+i}))
  const result=await call('',ctx)
  expect(result.type).toBe('compact')
  expect(JSON.stringify(compact.buildPostCompactMessages((result as any).compactionResult))).toContain('4100:row-0')
})

test('disabled, recursive and below-threshold auto paths do not dispatch compact', async () => {
  await register(`export function register(on) {on('session.compact',()=>({skip:'unexpected event'}));}`)
  const ctx=context()
  for(const source of ['compact','session_memory'] as const)
    expect(await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),source)).toEqual({wasCompacted:false})
  spyOn(tokens,'tokenCountWithEstimation').mockReturnValue(10)
  expect(await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')).toEqual({wasCompacted:false})
  spyOn(tokens,'tokenCountWithEstimation').mockReturnValue(190000)
  process.env.DISABLE_AUTO_COMPACT='1'
  expect(await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread')).toEqual({wasCompacted:false})
  delete process.env.DISABLE_AUTO_COMPACT
  expect(await autoCompactIfNeeded(ctx.messages,ctx,params(ctx),'repl_main_thread',{compacted:false,turnCounter:0,turnId:'turn',consecutiveFailures:3})).toEqual({wasCompacted:false})
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test.each(['replace','skip'] as const)('slash command consumer installs compact %s without losing command notices', async action => {
  await register(`export function register(on) {on('session.compact',()=>${action==='skip' ? "({skip:'manual veto notice'})" : "({messages:[{role:'user',text:'MANUAL_COMPACT_SUMMARY',toolUses:[]}]})"});}`)
  const ctx=context();ctx.options.commands=[compactCommand]
  const result=await processSlashCommand('/compact',[],[],[],ctx as any,()=>{})
  expect(result.shouldQuery).toBe(false)
  if(action==='replace') {
    expect(JSON.stringify(result.messages)).toContain('MANUAL_COMPACT_SUMMARY')
    expect(result.messages.some(m=>m.type==='system'&&m.subtype==='compact_boundary')).toBe(true)
    expect(JSON.stringify(result.messages)).toContain('local-command-stdout')
  } else {
    expect(result.resultText).toBe('manual veto notice')
    expect(result.messages.some(m=>m.type==='system'&&m.subtype==='compact_boundary')).toBe(false)
  }
  expect(diagnostics).toEqual([])
})

test('real query lends its snapshot and captured usage to compact without unrelated hooks', async () => {
  spyOn(tokens,'tokenCountWithEstimation').mockReturnValue(getAutoCompactThreshold('claude-sonnet-4-6') + 1000)
  await register(`export function register(on) {
    on('session.compact', async ($,e) => ({messages:[{role:'user',text:'query window '+(await $.session.usage()).context.window,toolUses:[]}]}));
  }`)
  const ctx=context(), requests: Message[][]=[]
  const input: QueryParams={
    messages:ctx.messages,systemPrompt:[] as any,userContext:{},systemContext:{},toolUseContext:ctx,
    canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:'repl_main_thread',
    deps:{uuid:randomUUID,microcompact:async messages=>({messages}),autocompact:autoCompactIfNeeded,
      callModel:async function*(request) {requests.push(request.messages);yield createAssistantMessage({content:'done'})}},
  }
  const events = []
  for await(const event of query(input)) events.push(event)
  expect(JSON.stringify(events)).toContain('query window 200000')
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0])).toContain('query window 200000')
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test('subagent compaction keeps the main session reader separate from its own transcript', async () => {
  await runtime.dispose()
  runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: {messages: () => [{role:'user',text:'main conversation',toolUses:[]}]},
  })
  spyOn(tokens,'tokenCountWithEstimation').mockReturnValue(getAutoCompactThreshold('claude-sonnet-4-6') + 1000)
  await register(`export function register(on) {
    on('session.compact', async ($,e) => ({messages:[{
      role:'user',toolUses:[],text:JSON.stringify({agentId:e.agentId,own:e.messages.map(m=>m.text),main:(await $.session.messages()).map(m=>m.text)})
    }]}));
  }`)
  const ctx=context(), requests: Message[][]=[]
  ctx.agentId=asAgentId('compact-child')
  const input: QueryParams={
    messages:ctx.messages,systemPrompt:[] as any,userContext:{},systemContext:{},toolUseContext:ctx,
    canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:'agent:compact-child',
    deps:{uuid:randomUUID,microcompact:async messages=>({messages}),autocompact:autoCompactIfNeeded,
      callModel:async function*(request) {requests.push(request.messages);yield createAssistantMessage({content:'done'})}},
  }
  await Array.fromAsync(query(input))
  const replacement=requests[0]?.find(message=>message.type==='user')
  expect(replacement?.type).toBe('user')
  if(replacement?.type!=='user') throw Error('missing replacement transcript')
  const content=replacement.message.content
  const text=typeof content==='string'?content:content.flatMap(block=>block.type==='text'?[block.text]:[]).join('')
  expect(JSON.parse(text)).toEqual({agentId:'compact-child',own:['original','old answer'],main:['main conversation']})
  expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

test.each(['replace','skip','late-skip'] as const)('real query consumes compact %s in its next request and transcript', async action => {
  spyOn(tokens,'tokenCountWithEstimation').mockReturnValue(getAutoCompactThreshold('claude-sonnet-4-6') + 1000)
  const handler = action==='late-skip' ? "async ($,e,next)=>{await next(e);return {skip:'veto notice'}}"
    : action==='skip' ? "()=>({skip:'veto notice'})"
      : "()=>({messages:[{role:'user',text:'MOD_COMPACT_SUMMARY',toolUses:[]}]})"
  await register(`export function register(on) {on('session.compact',${handler});}`)
  if(action==='late-skip') spyOn(memory,'trySessionMemoryCompaction').mockResolvedValue(coreResult())
  const ctx=context(), requests: Message[][]=[], events: any[]=[]
  const input: QueryParams={
    messages:ctx.messages,systemPrompt:[] as any,userContext:{},systemContext:{},toolUseContext:ctx,
    canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:'repl_main_thread',
    deps:{uuid:randomUUID,microcompact:async messages=>({messages}),autocompact:autoCompactIfNeeded,
      callModel:async function*(request) {
        requests.push(request.messages)
        const answer=createAssistantMessage({content:'done'})
        Object.assign(answer.message,{stop_reason:'end_turn',model:'claude-test',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}})
        yield answer
      }},
  }
  for await(const event of query(input)) events.push(event)
  expect(requests).toHaveLength(1)
  if(action==='replace') {
    expect(JSON.stringify(requests[0])).toContain('MOD_COMPACT_SUMMARY')
    expect(JSON.stringify(requests[0])).not.toContain('old answer')
    expect(events.some(m=>m.type==='system'&&m.subtype==='compact_boundary')).toBe(true)
  } else {
    expect(requests[0]).toEqual(ctx.messages)
    expect(events.filter(m=>m.type==='system'&&m.content==='veto notice')).toHaveLength(1)
    expect(events.some(m=>m.type==='system'&&m.subtype==='compact_boundary')).toBe(false)
    expect(cleanup.runPostCompactCleanup).not.toHaveBeenCalled()
  }
  if(action==='late-skip') expect(memory.trySessionMemoryCompaction).toHaveBeenCalledTimes(1)
  else expect(memory.trySessionMemoryCompaction).not.toHaveBeenCalled()
  expect(diagnostics).toEqual([])
})

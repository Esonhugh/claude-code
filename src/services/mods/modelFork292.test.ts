import { APIError } from '@anthropic-ai/sdk'
import { getAssistantMessageFromError } from '../api/errors.js'
import { expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { createModModelFork } from './modelAdapter.js'

// Error formatting reads authentication and settings even with a fake fork runner.
// Keep those reads independent of the developer's credentials and HOME.
const testEnvKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]
let testConfigRoot: string | undefined
let savedTestEnvironment: (string | undefined)[] = []
beforeEach(async () => {
  savedTestEnvironment = testEnvKeys.map(key => process.env[key])
  testConfigRoot = await realpath(await mkdtemp(join(tmpdir(), 'mods-fork-test-config-')))
  process.env.HOME = testConfigRoot
  process.env.CLAUDE_CONFIG_DIR = join(testConfigRoot, 'config')
  process.env.XDG_CONFIG_HOME = join(testConfigRoot, 'xdg-config')
  process.env.XDG_CACHE_HOME = join(testConfigRoot, 'xdg-cache')
  process.env.XDG_STATE_HOME = join(testConfigRoot, 'xdg-state')
  process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  resetSettingsCache()
})
afterEach(async () => {
  try {
    if (testConfigRoot !== undefined) {
      await rm(testConfigRoot, { recursive: true, force: true })
      testConfigRoot = undefined
    }
  } finally {
    resetSettingsCache()
    testEnvKeys.forEach((key, i) => {
      if (savedTestEnvironment[i] === undefined) delete process.env[key]
      else process.env[key] = savedTestEnvironment[i]
    })
  }
})

const usage={input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4}
const reply=(content:unknown[],extra={})=>({type:'assistant',message:{content},...extra})
const snapshot=()=>({forkContextMessages:[],toolUseContext:{options:{tools:['retained']}}}) as never

test('292 fork checks saved context before cancellation and returns the cold discriminant',async()=>{
 const stop=new AbortController();stop.abort('user-cancel');let runs=0
 const fork=createModModelFork(()=>null,async()=>{runs++;throw Error('unexpected')})
 expect(await fork({prompt:'cold'},stop.signal)).toEqual({isAnswered:false,reason:'nothing-to-fork'});expect(runs).toBe(0)
})
test('292 fork denies tools with native query settings and strips only trailing assistant tool calls',async()=>{
 const user={type:'user',message:{content:'context'}}
 const historical=reply([{type:'tool_use',id:'past'}]);const mixed=reply([{type:'text',text:'kept'},{type:'tool_use',id:'pending'}]);const tools=reply([{type:'tool_use',id:'drop'}])
 const messages=[historical,user,mixed,tools],original=structuredClone(messages);let call:any
 const saved={...snapshot() as any,forkContextMessages:messages}
 const fork=createModModelFork(()=>saved,async params=>{call=params;return {messages:[reply([{type:'text',text:'first'},{type:'text',text:'second'}]),reply([{type:'text',text:' third '}])],totalUsage:usage} as never})
 expect(await fork({prompt:'question'})).toEqual({isAnswered:true,text:'first\nsecond\nthird',usage})
 expect(call).toMatchObject({querySource:'hook_prompt',forkLabel:'plugin_model_fork',maxTurns:2,skipCacheWrite:true,skipTranscript:true})
 expect(call.toolChoice).toBeUndefined();expect(call.overrides.requireCanUseTool).toBeUndefined()
 expect(await call.canUseTool()).toEqual({behavior:'deny',message:'A model fork cannot use tools',decisionReason:{type:'other',reason:'model.fork'}})
 expect(call.cacheSafeParams.forkContextMessages).toEqual([historical,user,reply([{type:'text',text:'kept'}])]);expect(messages).toEqual(original)
 expect(call.cacheSafeParams.toolUseContext).toBe(saved.toolUseContext)
})
test('292 fork prefers nonempty assistant text, then the last API error, then an empty reply',async()=>{
 const first=reply([],{isApiErrorMessage:true,apiErrorStatus:401,error:'authentication_failed'}),last=reply([],{isApiErrorMessage:true,apiErrorStatus:529,error:'overloaded'})
 for(const [messages,result]of [
  [[first,reply([{type:'text',text:' answered '}]),last],{isAnswered:true,text:'answered',usage}],
  [[first,last],{isAnswered:false,reason:'api-error',status:529,error:'overloaded',usage}],
  [[reply([{type:'text',text:'   '}])],{isAnswered:false,reason:'empty-reply',usage}],
 ]as const)expect(await createModModelFork(snapshot,async()=>({messages,totalUsage:usage}) as never)({prompt:'x'})).toEqual(result)
})
test('292 fork waits for cooperative cancellation, preserves measured usage and propagates runner errors',async()=>{
 const stop=new AbortController(),entered=Promise.withResolvers<void>();let closed=false
 const fork=createModModelFork(snapshot,async params=>{entered.resolve();await new Promise<void>(resolve=>params.overrides!.abortController!.signal.addEventListener('abort',()=>resolve(),{once:true}));closed=true;return {messages:[],totalUsage:usage} as never})
 const pending=fork({prompt:'held'},stop.signal);await entered.promise;stop.abort('user-cancel')
 expect(await pending).toEqual({isAnswered:false,reason:'aborted',usage});expect(closed).toBe(true)
 const error=Error('runner failed');await expect(createModModelFork(snapshot,async()=>{throw error})({prompt:'x'})).rejects.toBe(error)
})

test('292 fork preserves actual HTTP status and category without exposing the error body',async()=>{
 const failure=getAssistantMessageFromError(APIError.generate(529,{error:{type:'overloaded_error',message:'PRIVATE_OWNED_BODY'}},'PRIVATE_OWNED_DETAIL',new Headers()),'haiku')
 expect(failure.apiErrorStatus).toBe(529)
 const fork=createModModelFork(snapshot,async()=>({messages:[failure],totalUsage:usage}) as never)
 expect(await fork({prompt:'owned'})).toEqual({isAnswered:false,reason:'api-error',status:529,error:'server_error',usage})
})

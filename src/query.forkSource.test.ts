import {afterAll, expect, spyOn, test} from 'bun:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {query, type QueryParams} from './query.js'
import type {ToolUseContext} from './Tool.js'
import {createModsRuntime} from './services/mods/runtime.js'
import {getDefaultAppState} from './state/AppStateStore.js'
import {createFileStateCacheWithSizeLimit} from './utils/fileStateCache.js'
import {createAssistantMessage, createUserMessage} from './utils/messages.js'
import {asSystemPrompt} from './utils/systemPromptType.js'
import {asAgentId} from './types/ids.js'

const saved = ['CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'].map(key=>process.env[key])
const root = await realpath(await mkdtemp(join(tmpdir(),'mods-fork-source-')))
process.env.CLAUDE_CONFIG_DIR = root
process.env.ANTHROPIC_API_KEY = 'dummy-fork-source'
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
;(globalThis as typeof globalThis & {MACRO:MacroGlobals}).MACRO = {VERSION:'test',ISSUES_EXPLAINER:'report an issue'}
afterAll(async()=>{
  ['CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'].forEach((key,index)=>{
    if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index]
  })
  await rm(root,{recursive:true,force:true})
})

test.each([
  ['repl_main_thread',false,1], ['repl_main_thread:outputStyle:Explanatory',false,1],
  ['repl_main_thread:outputStyle:custom',false,1], ['sdk',false,1],
  ['agent:custom',false,0], ['repl_main_thread:outputStyle:Explanatory',true,0],
] as const)('main-thread fork capture handles source %s (agent=%s)',async(source,isAgent,captures)=>{
  const runtime=createModsRuntime()
  const capture=spyOn(runtime,'captureForkSnapshotWriter')
  const state=getDefaultAppState()
  const context={
    options:{commands:[],debug:false,mainLoopModel:'claude-sonnet-4-6',tools:[],verbose:false,thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:true,agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}},
    ...(isAgent?{agentId:asAgentId('fork-source-agent')}:{ }),
    abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(10),
    getAppState:()=>state,setAppState(){},setInProgressToolUseIDs(){},setResponseLength(){},updateFileHistoryState(){},updateAttributionState(){},messages:[],mods:runtime,
  } as unknown as ToolUseContext
  const params:QueryParams={
    messages:[createUserMessage({content:'answer'})],systemPrompt:asSystemPrompt(['system']),userContext:{},systemContext:{},toolUseContext:context,
    canUseTool:async()=>({behavior:'allow',updatedInput:{}}),querySource:source,
    deps:{uuid:randomUUID,microcompact:async messages=>({messages}),autocompact:async messages=>({messages,wasCompacted:false}),
      callModel:async function*(){const message=createAssistantMessage({content:'done'});Object.assign(message.message,{id:'fork-source-answer',model:'claude-sonnet-4-6',stop_reason:'end_turn'});yield message},
    },
  }
  try{
    for await(const _message of query(params)){ /* Drain the actual main-thread query. */ }
    expect(capture).toHaveBeenCalledTimes(captures)
    if(captures)expect(capture.mock.results[0]!.value).toBeFunction()
  }finally{capture.mockRestore();await runtime.dispose()}
})

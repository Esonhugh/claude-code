import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Process isolation keeps tool mocks, permission state and discovery caches local.
const modules = Object.fromEntries(
  Object.entries({
    bootstrap: '../bootstrap/state.ts',
    config: './config.ts',
    loader: '../skills/loadSkillsDir.ts',
    app: '../state/AppStateStore.ts',
    tool: '../Tool.ts',
    agent: '../tools/AgentTool/built-in/generalPurposeAgent.ts',
    runner: '../tools/AgentTool/runAgent.ts',
    lifecycle: '../tools/AgentTool/agentToolUtils.ts',
    messages: './messages.ts',
    fileState: './fileStateCache.ts',
    preparation: './forkedAgent.ts',
    slash: './processUserInput/processSlashCommand.tsx',
    skill: '../tools/SkillTool/SkillTool.ts',
    bundled: '../skills/bundledSkills.ts',
    scope: './forkedSkillScope.ts',
    storage: './sessionStorage.ts',
    resume: '../tools/AgentTool/resumeAgent.ts',
  }).map(([key, path]) => [key, new URL(path, import.meta.url).href]),
)
const childSource = `
import assert from 'node:assert/strict'
import {mock} from 'bun:test'
import {mkdir,writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
const m=JSON.parse(process.env.FORK_TEST_MODULES),scenario=process.env.FORK_TEST_CASE
const boot=await import(m.bootstrap);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setCwdState(process.cwd());boot.setIsInteractive(true)
const {enableConfigs}=await import(m.config);enableConfigs()
const {getDefaultAppState}=await import(m.app),{getEmptyToolPermissionContext}=await import(m.tool)
const {GENERAL_PURPOSE_AGENT}=await import(m.agent)
const {createAssistantMessage,createUserMessage}=await import(m.messages)
const {createFileStateCacheWithSizeLimit}=await import(m.fileState)
const command={name:'fork-probe',type:'prompt',description:'probe',progressMessage:'running',contentLength:1,source:'mcp',loadedFrom:'mcp',context:'fork',allowedTools:['Read'],disallowedTools:['Bash'],effort:'high',getPromptForCommand:async()=>[{type:'text',text:'SKILL-BODY'}]}
let state={...getDefaultAppState(),runningSubagents:1,toolPermissionContext:{...getEmptyToolPermissionContext(),alwaysAllowRules:{command:['Write'],session:['Glob']},alwaysDenyRules:{command:['Edit'],session:['WebFetch']}},agentDefinitions:{activeAgents:[GENERAL_PURPOSE_AGENT]},mcp:{...getDefaultAppState().mcp,commands:[command]}}
let executions=[],finished=[]
mock.module(m.runner,()=>({async *runAgent(params){executions.push(params);yield createAssistantMessage({content:'WORKER-DONE'})}}))
mock.module(m.lifecycle,()=>({resolveAgentTools:()=>({validTools:['Read'],hasWildcard:false}),async runAsyncAgentLifecycle(params){try{for await(const message of params.makeStream(undefined)){}finished.push(params)}finally{params.onRunSettled?.()}}}))
const context={options:{commands:[command],tools:[],isNonInteractiveSession:false,mainLoopModel:'claude-sonnet-4-6',agentDefinitions:{activeAgents:[GENERAL_PURPOSE_AGENT]}},messages:[],abortController:new AbortController(),getAppState:()=>state,setAppState:fn=>{state=fn(state)},setResponseLength:()=>{},readFileState:createFileStateCacheWithSizeLimit(20)}
const permit=async()=>({behavior:'allow'})
if(scenario==='loader'){
 const {parseSkillFrontmatterFields}=await import(m.loader)
 for(const [raw,expected] of [[false,false],['false',false],[0,false],['OFF',false],[true,true],[1,true],['yes',true],[undefined,undefined],[null,undefined],['bogus',undefined],[[],undefined]]){
  const parsed=parseSkillFrontmatterFields({background:raw,'disallowed-tools':['Bash','Edit']},'BODY','probe')
  assert.equal(parsed.background,expected);assert.deepEqual(parsed.disallowedTools,['Bash','Edit'])
 }
}else if(scenario==='bundled'){
 const {registerBundledSkill,getBundledSkills}=await import(m.bundled)
 registerBundledSkill({...command,background:false});const item=getBundledSkills().find(c=>c.name===command.name);assert.equal(item.background,false);assert.deepEqual(item.disallowedTools,['Bash'])
}else if(scenario==='partial-write'){
 const {persistForkedSkillScope,readForkedSkillScope,readForkedSkillWitness}=await import(m.scope)
 const {getAgentTranscriptPath}=await import(m.storage);const path=getAgentTranscriptPath('partial').replace(/\\.jsonl$/,'.forked-skill.json')
 await mkdir(path,{recursive:true});await assert.rejects(persistForkedSkillScope('partial',{skillName:'fork-probe',attributionName:'fork-probe'}))
 assert.equal(await readForkedSkillWitness('partial'),'fork-probe');const {rm}=await import('node:fs/promises');await rm(path,{recursive:true});assert.equal((await readForkedSkillScope('partial')).status,'absent-but-marked')
}else if(scenario==='prepare-scope'){
 const {prepareForkedCommandContext}=await import(m.preparation)
 command.getPromptForCommand=async(args,input)=>{assert.deepEqual(input.getAppState().toolPermissionContext.alwaysAllowRules.command,['Read']);assert.deepEqual(input.getAppState().toolPermissionContext.alwaysDenyRules.command,['Edit','Bash']);return [{type:'text',text:'SCOPED-BODY'}]}
 const prepared=await prepareForkedCommandContext(command,'',context,permit,{background:true});assert.equal(prepared.skillContent,'SCOPED-BODY')
}else if(scenario==='permissions'){
 const {createGetAppStateWithAllowedTools}=await import(m.preparation)
 const getter=createGetAppStateWithAllowedTools(context.getAppState,['Read'],['Bash'],{replaceCommandRules:true,frozenCommandDenies:['Write']})
 assert.deepEqual(getter().toolPermissionContext.alwaysAllowRules.command,['Read'])
 assert.deepEqual(getter().toolPermissionContext.alwaysAllowRules.session,['Glob'])
 assert.deepEqual(getter().toolPermissionContext.alwaysDenyRules.command,['Write','Edit','Bash'])
 state={...state,toolPermissionContext:{...state.toolPermissionContext,alwaysDenyRules:{...state.toolPermissionContext.alwaysDenyRules,command:['Read']}}}
 assert.deepEqual(getter().toolPermissionContext.alwaysDenyRules.command,['Write','Read','Bash'])
 assert.deepEqual(state.toolPermissionContext.alwaysAllowRules.command,['Write'])
}else if(scenario.startsWith('resume-')){
 const storage=await import(m.storage),id='fork-scope-probe',path=storage.getAgentTranscriptPath(id).replace(/\.jsonl$/,'.forked-skill.json'),marker=path.replace(/\.json$/,'.marker.json')
 await storage.recordSidechainTranscript([createUserMessage({content:'ORIGINAL'})],id);await storage.flushSessionStorage();await storage.writeAgentMetadata(id,{agentType:'general-purpose',name:'fork-probe',description:'/fork-probe',spawnDepth:1,model:'claude-sonnet-4-6'})
 const scope={skillName:'fork-probe',attributionName:'fork-probe',effort:'high',frozenCommandDenies:['Write']}
 await mkdir(dirname(path),{recursive:true})
 if(scenario!=='resume-live-missing')await writeFile(marker,JSON.stringify({forkedSkill:true,skillName:scenario==='resume-witness-mismatch'?'other':'fork-probe'}))
 if(!['resume-missing','resume-live-missing'].includes(scenario))await writeFile(path,scenario==='resume-malformed'?'{':scenario==='resume-oversize'?' '.repeat(524289):JSON.stringify(scope))
 if(scenario==='resume-live-missing'||scenario==='resume-live-mismatch')state.tasks[id]={type:'local_agent',agentId:id,status:'completed',forkedSkillName:scenario==='resume-live-mismatch'?'other':'fork-probe',keepaliveReasons:new Set()}
 if(scenario==='resume-unresolved')state.mcp.commands=[]
 if(scenario==='resume-inline')state.mcp.commands=[{...command,context:undefined}]
 const {resumeAgentBackground}=await import(m.resume)
 const run=()=>resumeAgentBackground({agentId:id,prompt:'CONTINUE',toolUseContext:context,canUseTool:permit})
 if(scenario==='resume-valid'){
  const r=await run();assert.equal(r.agentId,id);await new Promise(r=>setTimeout(r,25));assert.equal(executions.length,1)
  const p=executions[0];assert.equal(p.spawnedBySkill,'fork-probe');assert.equal(p.spawnedByForkedSkill,true);assert.equal(p.agentDefinition.effort,'high');assert.equal(p.name,'fork-probe');assert.equal(state.tasks[id].forkedSkillName,'fork-probe');assert.equal(state.agentNameRegistry.get('fork-probe'),id)
  assert.deepEqual(p.toolUseContext.getAppState().toolPermissionContext.alwaysAllowRules.command,['Read']);assert.deepEqual(p.toolUseContext.getAppState().toolPermissionContext.alwaysDenyRules.command,['Write','Edit','Bash'])
 }else{
  await assert.rejects(run,/forked.skill|fork.capable|permission scoping|provenance/i);assert.equal(executions.length,0);assert.equal(state.runningSubagents,1)
 }
}else{
 if(scenario.endsWith('false'))command.background=false
 if(scenario.endsWith('disabled'))process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1'
 if(scenario.endsWith('noninteractive')){context.options.isNonInteractiveSession=true;boot.setIsInteractive(false)}
 if(scenario.endsWith('depth'))context.options.subagentDepth=5
 if(scenario.endsWith('duplicate'))state.tasks.old={type:'local_agent',status:'running',forkedSkillName:command.name}
 if(scenario.endsWith('writefailure')){const {getAgentTranscriptPath}=await import(m.storage);const dir=dirname(getAgentTranscriptPath('unallocated'));await mkdir(dirname(dir),{recursive:true});await writeFile(dir,'not a directory')}
 let result
 if(scenario.startsWith('slash')){
  const {processSlashCommand}=await import(m.slash);result=await processSlashCommand('/fork-probe',[],[],[],context,()=>{},undefined,undefined,permit)
 }else{
  const {SkillTool}=await import(m.skill)
  if(scenario==='skill-recursion'){context.options.spawnedBySkill='fork-probe';context.options.spawnedByForkedSkill=true;const result=await SkillTool.validateInput({skill:'fork-probe'},context);assert.equal(result.result,false);assert.equal(result.errorCode,9);assert.equal(executions.length,0);process.exit(0)}
  result=await SkillTool.call({skill:'fork-probe'},context,permit,createAssistantMessage({content:'CALL'}))
 }
 await new Promise(r=>setTimeout(r,25));assert.equal(executions.length,1);const p=executions[0]
 const background=scenario==='slash-default'||scenario==='skill-default'
 assert.equal(p.isAsync,background);assert.equal(state.runningSubagents,1)
 if(background){
  assert.equal(p.spawnedBySkill,'fork-probe');assert.equal(p.spawnedByForkedSkill,true);assert.equal(p.spawnDepth,1);assert.ok(p.override.readFileState!==context.readFileState)
  assert.equal(state.tasks[p.override.agentId].forkedSkillName,'fork-probe');assert.equal(state.agentNameRegistry.get('fork-probe'),p.override.agentId)
  assert.deepEqual(p.toolUseContext.getAppState().toolPermissionContext.alwaysAllowRules.command,['Read'])
  assert.deepEqual(p.toolUseContext.getAppState().toolPermissionContext.alwaysDenyRules.command,['Edit','Bash'])
  const {getAgentTranscriptPath}=await import(m.storage);const scope=JSON.parse(await Bun.file(getAgentTranscriptPath(p.override.agentId).replace(/\.jsonl$/,'.forked-skill.json')).text());assert.equal(scope.skillName,'fork-probe');assert.deepEqual(scope.frozenCommandDenies,['Edit']);assert.equal(scope.effort,'high')
  if(scenario==='skill-default'){assert.equal(result.data.background,true);assert.equal(result.data.agentId,p.override.agentId)}else assert.ok(JSON.stringify(result.messages).includes('Running in the background as @fork-probe'))
 }else{assert.ok(JSON.stringify(result).includes('WORKER-DONE'));assert.equal(finished.length,0)}
}
`
const scenarios = [
  'loader',
  'permissions',
  'prepare-scope',
  'bundled',
  'partial-write',
  'slash-default',
  'skill-default',
  'slash-false',
  'skill-false',
  'slash-disabled',
  'skill-disabled',
  'slash-noninteractive',
  'skill-noninteractive',
  'slash-depth',
  'slash-duplicate',
  'slash-writefailure',
  'skill-recursion',
  'resume-valid',
  'resume-missing',
  'resume-live-missing',
  'resume-malformed',
  'resume-oversize',
  'resume-witness-mismatch',
  'resume-live-mismatch',
  'resume-unresolved',
  'resume-inline',
]
for (const scenario of scenarios) {
  test('fork skill launch and permission restore: ' + scenario, async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'fork-scope-')),
    )
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', '--eval', childSource],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: join(directory, 'home'),
          CLAUDE_CONFIG_DIR: join(directory, 'config'),
          TMPDIR: directory,
          TEST_ENABLE_SESSION_PERSISTENCE: '1',
          ANTHROPIC_API_KEY: 'owned-fork-dummy',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
          FORK_TEST_MODULES: JSON.stringify(modules),
          FORK_TEST_CASE: scenario,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    try {
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit, out + err).toBe(0)
    } finally {
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}

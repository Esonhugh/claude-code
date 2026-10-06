import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = [
  "import assert from 'node:assert/strict'",
  "import { spyOn } from 'bun:test'",
  'const {setOriginalCwd}=await import(' + JSON.stringify(new URL('../../bootstrap/state.ts',import.meta.url).href) + ')',
  'const {enableConfigs}=await import(' + JSON.stringify(new URL('../../utils/config.ts',import.meta.url).href) + ')',
  'setOriginalCwd(process.cwd());enableConfigs()',
  'const {getDefaultAppState}=await import(' + JSON.stringify(new URL('../../state/AppStateStore.ts',import.meta.url).href) + ')',
  'const {AgentTool}=await import(' + JSON.stringify(new URL('../../tools/AgentTool/AgentTool.tsx',import.meta.url).href) + ')',
  'const {createModToolHost}=await import(' + JSON.stringify(new URL('./toolHost.ts',import.meta.url).href) + ')',
  'let state=getDefaultAppState();let started=false;let returned=false;const observations=[]',
  'const context={options:{tools:[],mcpClients:[],isNonInteractiveSession:true},abortController:new AbortController(),messages:[],getAppState:()=>state,setAppState:update=>{state=update(state)}}',
  'const acknowledgement=Promise.withResolvers()',
  'const scenario=JSON.parse(process.env.MODS_SPAWN_LIFETIME_CASE)',
  "const call=spyOn(AgentTool,'call').mockImplementation(async(input,child)=>{child.modAgentStarted({model:'model',agentId:'announced-agent'});started=true;await acknowledgement.promise;if(scenario.failure)throw new Error('launch failed');return {data:scenario.data}})",
  'try {',
  " const result=createModToolHost(context,async()=>{throw new Error('no permission prompt')}).spawn({prompt:'owned'},{hasHooks:()=>false},new AbortController().signal,'author',id=>observations.push(id))",
  ' void result.then(()=>{returned=true},()=>{returned=true})',
  ' while(!started)await Bun.sleep(1)',
  ' await Bun.sleep(10);assert.equal(returned,false);assert.deepEqual(observations,[])',
  ' acknowledgement.resolve()',
  " if(scenario.failure)await assert.rejects(result,/launch failed/);else assert.deepEqual(await result,{model:'model',agentId:'announced-agent'})",
  ' assert.deepEqual(observations,scenario.observed)',
  '}finally{acknowledgement.resolve();call.mockRestore()}',
].join('\n')

for (const scenario of [
  {name:'async task',data:{status:'async_launched',agentId:'actual-agent'},observed:['actual-agent']},
  {name:'invalid async ID',data:{status:'async_launched',agentId:42},observed:[]},
  {name:'foreground completion',data:{status:'completed'},observed:[]},
  {name:'remote launch',data:{status:'remote_launched',taskId:'remote'},observed:[]},
  {name:'teammate launch',data:{status:'teammate_spawned',teammate_id:'peer'},observed:[]},
  {name:'failed launch',failure:true,observed:[]},
]) {
  test('spawn observer follows the actual Agent result: '+scenario.name,async()=>{
    const directory=await realpath(await mkdtemp(join(tmpdir(),'mods-spawn-lifetime-')))
    try {
      const child=Bun.spawn([process.execPath,'--eval',childSource],{
        cwd:directory,
        env:{PATH:process.env.PATH,HOME:directory,CLAUDE_CONFIG_DIR:join(directory,'config'),XDG_CONFIG_HOME:join(directory,'xdg'),XDG_CACHE_HOME:join(directory,'cache'),TMPDIR:directory,ANTHROPIC_API_KEY:'owned-spawn-lifetime-dummy',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',MODS_SPAWN_LIFETIME_CASE:JSON.stringify(scenario)},
        stdout:'pipe',stderr:'pipe',
      })
      const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      expect({exitCode,stdout,stderr}).toEqual({exitCode:0,stdout:'',stderr:''})
    }finally{await rm(directory,{recursive:true,force:true})}
  })
}

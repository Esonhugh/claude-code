import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const modules=Object.fromEntries(Object.entries({bootstrap:'../../bootstrap/state.ts',config:'../../utils/config.ts',app:'../../state/AppStateStore.ts',sender:'./SendMessageTool.ts'}).map(([key,path])=>[key,new URL(path,import.meta.url).href]))
const source=`
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const m=JSON.parse(process.env.PIN_MODULES),variant=process.env.PIN_VARIANT
const boot=await import(m.bootstrap);boot.setOriginalCwd(process.cwd());boot.setProjectRoot(process.cwd());boot.setIsInteractive(true)
const {enableConfigs}=await import(m.config);enableConfigs()
const {getDefaultAppState}=await import(m.app),{SendMessageTool}=await import(m.sender)
const A='a0123456789abcdef',B='afedcba9876543210',name='pin-target',ref=id=>createHash('sha256').update('subagent:'+id).digest('hex').slice(0,6)
const task=id=>({id,agentId:id,type:'local_agent',status:'running',pendingMessages:[]})
let state={...getDefaultAppState(),agentNameRegistry:new Map([[name,A]]),tasks:{[A]:task(A),[B]:task(B)}}
const writer=update=>{state=update(state)}
const context={getAppState:()=>state,setAppState:variant==='async-writer'?()=>{}:writer,...(variant==='async-writer'?{setAppStateForTasks:writer}:{})}
if(variant==='cancelled'){state.tasks[A]={...state.tasks[A],status:'killed',stoppedByUser:true}}
const send=(to,message)=>SendMessageTool.call({to,message},context,async()=>({behavior:'allow'}),undefined)
const first=await send(name,'FIRST')
if(variant==='live'||variant==='async-writer'){
 assert.deepEqual(first.data,{success:true,message:'Message queued for delivery to '+name+' at its next tool round.',pin:{id:A,name,ref:ref(A)}})
 assert.deepEqual(state.tasks[A].pendingMessages,['FIRST'])
}else if(variant==='cancelled'){
 assert.equal(first.data.success,false);assert.deepEqual(state.sendMessagePins,{});assert.deepEqual(state.tasks[A].pendingMessages,[])
}else if(variant.startsWith('format-')){
 const data={...first.data,display:'TERMINAL-ONLY',...(variant==='format-json'?{}:{inlineHandback:{displayName:name,content:[{type:'text',text:'REPORT'}],harnessNoteCount:0,harnessTailCount:0,harnessSectionHash:'234ba8118153d485'}})}
 const wire=SendMessageTool.mapToolResultToToolResultBlockParam(data,'format-result')
 const header=JSON.parse(wire.content[0].text.split('\\n')[0])
 assert.equal(header.display,undefined);assert.equal(header.inlineHandback,undefined)
 if(variant==='format-framed')assert.equal(header.pin,undefined);else assert.deepEqual(header.pin,first.data.pin)
 assert.equal(data.display,'TERMINAL-ONLY');assert.deepEqual(data.pin,first.data.pin)
}else{
 state.agentNameRegistry=new Map([[name,B]])
 if(variant==='rebound'){
  const answer=await send(name,'SHOULD-NOT-DELIVER')
  assert.equal(answer.data.success,false)
  assert.ok(answer.data.message.includes('earlier sends went to ['+ref(A)+']'))
  assert.ok(answer.data.message.includes(name+' ['+ref(B)+']'))
  assert.equal(answer.data.display,"Not sent — '"+name+"' now means a different agent than it did earlier in this conversation; asked Claude to confirm which one it wants.")
  assert.deepEqual(state.tasks[B].pendingMessages,[])
 }else{
  const answer=await send(name+' ['+ref(B)+']','CONFIRMED')
  assert.deepEqual(answer.data,{success:true,message:'Message queued for delivery to '+name+' at its next tool round.',pin:{id:B,name,ref:ref(B)}})
  assert.deepEqual(state.tasks[B].pendingMessages,['CONFIRMED'])
  const repeated=await send(name,'AGAIN');assert.equal(repeated.data.success,true);assert.deepEqual(repeated.data.pin,answer.data.pin)
 }
}
console.log('pin contract passed '+variant)
`
for(const variant of ['live','rebound','confirm','async-writer','cancelled','format-json','format-framed','format-unframed'])test('SendMessage identity binding: '+variant,async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'send-pin-')))
 const child=Bun.spawn([process.execPath,'--no-env-file','--eval',source],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),TMPDIR:dir,ANTHROPIC_API_KEY:'owned-pin-dummy',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',PIN_MODULES:JSON.stringify(modules),PIN_VARIANT:variant,...(variant==='format-unframed'?{CLAUDE_CODE_HANDBACK_PROVENANCE:'0'}:{})},stdout:'pipe',stderr:'pipe'})
 try{const [exit,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(exit,out+err).toBe(0)}finally{if(child.exitCode===null){child.kill();await child.exited}await rm(dir,{recursive:true,force:true})}
})

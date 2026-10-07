import { afterEach, describe, expect, test } from 'bun:test'
import { createModsRuntime, type ModsRuntime } from './runtime.js'
import { createModRemoteUIControl, modUIAttachError, modUIDetachError } from './remoteUiControl.js'
import { SDKControlRequestSchema } from '../../entrypoints/sdk/controlSchemas.js'
import type { SDKControlRequest, SDKControlUIAttachRequest, SDKControlUIDetachRequest } from '../../entrypoints/sdk/controlTypes.js'

const runtimes: ModsRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })
async function fixture() {
  const diagnostics: {stage:string; message:string}[] = []
  const runtime = createModsRuntime({onDiagnostic:e => diagnostics.push(e)})
  runtimes.push(runtime)
  await runtime.bind({cwd:process.cwd(),surface:null,isInteractive:false,sessionId:'remote-control'})
  const replies: {id:string; value?:Record<string, unknown>; error?:string}[] = []
  const control = createModRemoteUIControl({runtime:() => runtime,
    success:(message,value) => replies.push({id:message.request_id,value}),
    error:(message,error) => replies.push({id:message.request_id,error}),
  })
  let nextId=0
  const send=(request:SDKControlRequest['request']) => {
    const message:SDKControlRequest={type:'control_request',request_id:String(++nextId),request}
    const handled=control.handleRequest(message)
    return {handled,reply:replies.find(r => r.id===message.request_id)}
  }
  return {runtime,diagnostics,control,send,replies}
}

describe('SDK remote UI transport roster', () => {
  test('waits for SDK binding before resolving the runtime or committing a connection', async () => {
    const {runtime}=await fixture();const available:{runtime?:ModsRuntime}={}
    const ready=Promise.withResolvers<void>();const replies:unknown[]=[]
    const control=createModRemoteUIControl({ready:()=>ready.promise,runtime:()=>available.runtime,
      success:(_message,value)=>replies.push(value),error:(_message,error)=>replies.push({error}),
    })
    expect(control.handleRequest({type:'control_request',request_id:'early',request:{subtype:'ui_attach',surface:'desktop',client_id:'early'}})).toBe(true)
    let drained=false;const draining=control.settle().then(()=>{drained=true})
    await Bun.sleep(0)
    expect(drained).toBe(false)
    expect(replies).toEqual([]);expect(runtime.remoteClients.surfaces()).toEqual([])
    available.runtime=runtime;ready.resolve();await draining
    expect(drained).toBe(true)
    expect(replies).toEqual([{surfaces:['desktop']}]);expect(runtime.remoteClients.surfaces()).toEqual(['desktop'])
  })

  test('acknowledges before an observation hook settles and publishes the roster first', async () => {
    const {runtime,send}=await fixture()
    const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>()
    const seen:unknown[]=[]
    runtime.registerHostCallback({tier:'user',registration:{id:1,event:'session.attach',hasCatch:false}},async(_$,e,next)=>{
      seen.push({event:e,surfaces:runtime.remoteClients.surfaces()});entered.resolve()
      await release.promise
      seen.push(await next(e));return {clientId:'forged'}
    })
    const request:SDKControlUIAttachRequest={subtype:'ui_attach',surface:'desktop',client_id:'a',viewport:{columns:80,rows:24},answers:['ui_copy']}
    expect(send(request)).toEqual({handled:true,reply:{id:'1',value:{surfaces:['desktop']}}})
    await entered.promise
    expect(seen).toEqual([{event:{surface:'desktop',clientId:'a',viewport:{columns:80,rows:24}},surfaces:['desktop']}])
    expect(send(request).reply?.value).toEqual({surfaces:['desktop']})
    expect(send({...request,surface:'mobile'}).reply?.value).toEqual({surfaces:['desktop']})
    release.resolve();await runtime.settle()
    expect(seen).toEqual([{event:{surface:'desktop',clientId:'a',viewport:{columns:80,rows:24}},surfaces:['desktop']},{clientId:'a'}])
  })

  test('transport remains attached when render sites unmount, then explicit detach removes it', async () => {
    const {runtime,send}=await fixture()
    send({subtype:'ui_attach',surface:'vscode',client_id:'view-client'})
    const site=await runtime.ui.mount({surface:'vscode',component:'PromptHint',requestId:'hint',props:{}},
      {surface:'vscode',clientId:'view-client',render:()=>{},unmount:()=>{}})
    await site.dispose()
    expect(runtime.remoteClients.surfaces()).toEqual(['vscode'])
    const request:SDKControlUIDetachRequest={subtype:'ui_detach',client_id:'view-client'}
    expect(send(request).reply?.value).toEqual({detached:true,surfaces:[]})
    expect(send(request).reply?.value).toEqual({detached:false,surfaces:[]})
  })

  test('hook exceptions and forged results never undo transport events; surfaces follow roster order', async () => {
    const {runtime,send,diagnostics}=await fixture()
    const seen:unknown[]=[]
    for (const [id,event] of ['session.attach','session.detach'].entries()) runtime.registerHostCallback({
      tier:'user',registration:{id:id+1,event,hasCatch:false},
    },async(_$,e)=>{
      seen.push({event,input:e,surfaces:runtime.remoteClients.surfaces()})
      if(e.clientId==='bad')throw new Error('owned observation failure')
      return {clientId:'ignored'}
    })
    for(const [surface,clientId] of [['desktop','a'],['mobile','m'],['desktop','bad']] as const) {
      expect(send({subtype:'ui_attach',surface,client_id:clientId}).reply?.error).toBeUndefined()
      await runtime.settle()
    }
    expect(send({subtype:'ui_detach',client_id:'a'}).reply?.value).toEqual({detached:true,surfaces:['mobile','desktop']})
    await runtime.settle()
    expect(send({subtype:'ui_detach',client_id:'bad'}).reply?.value).toEqual({detached:true,surfaces:['mobile']})
    await runtime.settle()
    expect(seen).toHaveLength(5)
    expect(seen[0]).toEqual({event:'session.attach',input:{surface:'desktop',clientId:'a'},surfaces:['desktop']})
    expect(seen[3]).toEqual({event:'session.detach',input:{surface:'desktop',clientId:'a',reason:'detach'},surfaces:['mobile','desktop']})
    expect(diagnostics.filter(d=>d.message.includes('owned observation failure'))).toHaveLength(2)
  })

  test('session end detaches transport clients once before session.end', async () => {
    const {runtime,send}=await fixture();const seen:unknown[]=[]
    for(const [id,event] of ['session.detach','session.end'].entries())runtime.registerHostCallback({
      tier:'user',registration:{id:id+1,event,hasCatch:false},
    },async(_$,e,next)=>{seen.push({event,input:e,surfaces:runtime.remoteClients.surfaces()});return next(e)})
    send({subtype:'ui_attach',surface:'desktop',client_id:'a'})
    send({subtype:'ui_attach',surface:'mobile',client_id:'m'})
    await runtime.endSession('other')
    expect(seen).toEqual([
      {event:'session.detach',input:{surface:'desktop',clientId:'a',reason:'end'},surfaces:['mobile']},
      {event:'session.detach',input:{surface:'mobile',clientId:'m',reason:'end'},surfaces:[]},
      {event:'session.end',input:{reason:'other',sessionId:'remote-control',resume:{id:'remote-control'}},surfaces:[]},
    ])
    expect(send({subtype:'ui_attach',surface:'mobile',client_id:'late'}).reply?.error).toContain('ending')
  })

  test('rejects invalid transport identities and viewports before any roster mutation', async () => {
    const {runtime,send}=await fixture()
    const valid:SDKControlUIAttachRequest={subtype:'ui_attach',surface:'desktop',client_id:'a'}
    for(const change of [{surface:'terminal'},{client_id:'mobile:spoof'},{client_id:''},{client_id:'a'.repeat(65)},
      {viewport:{columns:0,rows:1}},{viewport:{columns:1.5,rows:1}},{viewport:{columns:1,rows:1,isFullscreen:1}},
      {answers:['unsupported']},{answers:'ui_copy'}]) {
      const request={...valid,...change}
      expect(SDKControlRequestSchema().safeParse({type:'control_request',request_id:'schema',request}).success).toBe(false)
      expect(send(request).reply?.error).toBe(modUIAttachError)
      expect(runtime.remoteClients.surfaces()).toEqual([])
    }
    expect(send({subtype:'ui_detach',client_id:'bad:id'}).reply?.error).toBe(modUIDetachError)
    expect(send({subtype:'unknown'})).toEqual({handled:false,reply:undefined})
    expect(send({...valid,client_id:'a'.repeat(64),answers:[]}).reply?.value).toEqual({surfaces:['desktop']})
  })
})

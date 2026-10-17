import { expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import { createModClients } from './client.js'
import type { ModDeclaration } from './types.js'

test.each(['draw','timer','key'] as const)('real Client watchdog records the executing %s phase without guessing from its request name', async mode => {
  const host=createModEnvironmentHost()
  const declaration:ModDeclaration={
    name:'owner',storageId:'owner@test',pluginRoot:'/fixture',tier:'user',options:{},fingerprint:mode,
    entrypoints:['/fixture/main.js'],events:['tool.call'],calls:[],nextTiers:[],links:[],
    clients:[{path:'/fixture/spin.js',module:'spin.js'}],
    modules:[{path:'/fixture/main.js',source:`export function register(on) {on('tool.call',()=> 'alive')}`},
      {path:'/fixture/spin.js',source:`export default function Spin(_,s) {
        if('${mode}'==='draw') while(true) {}
        if(s.state===undefined) {s.setState(0);s.every(1,()=>{if('${mode}'==='timer') while(true) {}});s.onKey(()=>{while(true) {}})}
        return s.elements.Text({children:'ready'});
      }`}],
  }
  try {
    const environment=await host.load(declaration)
    const operation=mode==='draw' ? environment.client({op:'mount',id:1,module:'spin.js',now:0}) : (async()=>{
      await environment.client({op:'mount',id:1,module:'spin.js',now:0})
      return mode==='timer' ? environment.client({op:'frame',id:1,now:1}) : environment.client({op:'key',id:1,event:{key:'a'}})
    })()
    const error=await operation.then(()=>null,error=>error)
    expect(error).toMatchObject({phase:mode==='draw' ? 'render' : 'run',timeoutMs:1000})
    expect(error.message).toContain('Script execution timed out')
    expect(await environment.invoke(environment.registrations[0]!.id,[])).toBe('alive')
  } finally {await host.dispose()}
})

test('an actual Client watchdog fault carries the official budget reason and owning surface address', async () => {
  const host=createModEnvironmentHost()
  try {
    const environment=await host.load({
      name:'owner',storageId:'owner@test',pluginRoot:'/fixture',tier:'user',options:{},fingerprint:'fault-budget',
      entrypoints:['/fixture/main.js'],events:[],calls:[],nextTiers:[],links:[],
      clients:[{path:'/fixture/spin.js',module:'spin.js'}],
      modules:[{path:'/fixture/main.js',source:'export function register() {}'},
        {path:'/fixture/spin.js',source:'export default function Spin() {while(true) {}}'}],
    })
    const heard=Promise.withResolvers<unknown>()
    const clients=createModClients({
      request:(_site,_plugin,request)=>environment.client(request),message:async()=>({}),validate(){},
      fault:(site,plugin,input)=>heard.resolve({id:site.id,plugin,input}),
    })
    const handle=clients.mount({owner:{},id:'panel',visible:true,surface:'terminal',component:'Pane',clock:'manual'},
      {type:'Client',group:{plugin:'owner'},props:{key:'spinner',module:'spin.js'}},()=>{})
    try {
      const error=await handle.ready.then(()=>null,error=>error)
      expect(error).toMatchObject({phase:'render',timeoutMs:1000})
      expect(await heard.promise).toEqual({id:'panel',plugin:'owner',input:{
        surface:'terminal',component:'Pane',requestId:'panel',element:'spinner',module:'spin.js',
        phase:'render',reason:'ran longer than its 1000ms budget',
      }})
    } finally {await handle.dispose()}
  } finally {await host.dispose()}
})

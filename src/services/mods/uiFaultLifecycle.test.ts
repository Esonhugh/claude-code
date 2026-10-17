import { expect, test } from 'bun:test'
import { createModUi } from './ui.js'
import { createModClients, type ModClientSite } from './client.js'

test('actual render-site fault redraw allows one automatic generation and reopens after an explicit update', async () => {
  let owner: object
  let draws = 0
  const clients = createModClients({request:async()=>({}),message:async()=>({}),validate(){}})
  const ui = createModUi({
    clients,pluginOf:()=> 'owner',dispatch:async(_o,_e,input,core)=>core(input),
    async draw(nextOwner,_input,drawing) {
      owner=nextOwner
      draws++
      if(draws===2) await ui.redrawForFault({...ui.getClientSite(owner,'site')!,drawing})
      return {type:'Text',children:[String(draws)]}
    },
    invokeDrawing:async()=>undefined,releaseDrawing:async()=>{},
  })
  const input = {surface:'terminal' as const,component:'AbovePrompt' as const,requestId:'site',props:{}}
  const site = await ui.mount(input,{surface:'terminal',render(){},unmount(){}})
  const first = ui.getClientSite(owner!,'site')!
  try {
    expect(draws).toBe(1)
    await ui.redrawForFault(first)
    expect(draws).toBe(2)
    await ui.redrawForFault(first)
    await ui.redrawForFault(ui.getClientSite(owner!,'site')!)
    expect(draws).toBe(2)
    await site.update({...input,props:{updated:true}})
    expect(draws).toBe(3)
    await ui.redrawForFault(ui.getClientSite(owner!,'site')!)
    expect(draws).toBe(4)
    await site.dispose()
    await ui.redrawForFault(first)
    expect(draws).toBe(4)
  } finally {await site.dispose();await ui.dispose()}
})

test('Client tree validation and consumer commit failures report render phase once after retiring the old key', async () => {
  for(const failure of ['validate','commit'] as const) {
    const observed: unknown[] = []
    const pane: ModClientSite = {owner:{},id:'p',visible:true,drawing:1,surface:'terminal',component:'Pane'}
    const node = {type:'Client',props:{key:'k',module:'surface.ts'},group:{plugin:'owner'}}
    let current = true
    const clients = createModClients({
      request:async(_pane,_plugin,request)=>request.op==='mount' ? {tree:{type:'Text',children:['draw']}} : {},
      message:async()=>({}),validate(){if(current && failure==='validate') throw Error('invalid drawing')},
      fault:(site,plugin,input)=>{
        observed.push({site,plugin,input})
        current=false
        const replacement = clients.mount(pane,node,()=>{})
        void replacement.ready.then(()=>replacement.dispose())
      },
    })
    const handle=clients.mount(pane,node,()=>{if(current && failure==='commit') throw Error('invalid drawing')})
    try {
      const error=await handle.ready.then(()=>null,error=>error)
      expect(error.message).toBe('invalid drawing')
      expect(observed).toEqual([{site:pane,plugin:'owner',input:{surface:'terminal',component:'Pane',requestId:'p',element:'k',module:'surface.ts',phase:'render',reason:'invalid drawing'}}])
    } finally {await handle.dispose()}
  }
})

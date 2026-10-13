import { expect, test } from 'bun:test'
import { createModEnvironmentHost } from './environment.js'
import type { ModDeclaration } from './types.js'

function declaration(name: string, source: string): ModDeclaration {
  return {name,storageId:name+'@inline',pluginRoot:'/fixture',entrypoints:['/fixture/register.js'],modules:[{path:'/fixture/register.js',source}],links:[],events:['tool.call'],calls:[],nextTiers:[],options:{},tier:'user',fingerprint:source}
}

test.each(['module','host'] as const)('real synchronous CPU does not require a guest acknowledgment to retire the %s',async kind=>{
  const deaths:unknown[]=[],entered=Promise.withResolvers<void>()
  const host=createModEnvironmentHost({onDied:(error,fault)=>deaths.push({error,fault})})
  try {
    const healthy=await host.load(declaration('healthy',`export function register(on){on('tool.call',()=>({read:()=>42}))}`))
    const handle=await healthy.invoke(healthy.registrations[0]!.id,[]) as {read():Promise<number>}
    expect(await handle.read()).toBe(42)
    const busy=await host.load(declaration('busy',`export function register(on){on('tool.call',$=>{$.entered();for(;;){}})}`))
    const invocation=busy.invoke(busy.registrations[0]!.id,[{entered:()=>entered.resolve()}]).catch(error=>error)
    await entered.promise
    const started=performance.now()
    const outcome=await (kind==='module'?busy.dispose():host.dispose()).catch(error=>error)
    expect(outcome).toBeUndefined()
    expect(performance.now()-started).toBeLessThan(500)
    expect(String(await invocation)).toMatch(/unloaded|disposed/)
    expect(deaths).toEqual([])
    await Promise.all([host.dispose(),host.dispose()])
    await expect(handle.read()).rejects.toThrow('unloaded')
    await busy.dispose()
    expect(deaths).toEqual([])
  } finally {await host.dispose()}
})

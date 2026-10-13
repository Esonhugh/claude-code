import { expect,test } from 'bun:test'
import { fileURLToPath } from 'node:url'
const fixture=fileURLToPath(new URL('./fixtures/clientReturnedProbe.ts',import.meta.url))
async function probe(mode:string,event='key',shape='promise') {
 const child=Bun.spawn([process.execPath,fixture,mode,event,shape],{stdout:'pipe',stderr:'pipe'})
 const limit=setTimeout(()=>child.kill(),3500)
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 clearTimeout(limit)
 expect({exit,stderr}).toEqual({exit:0,stderr:''})
 return JSON.parse(stdout.trim())
}
for(const event of ['pointer','key','tick','held']) {
 test(`actual Worker ${event} returned rejection faults idle numeric instance; sibling and hooks live`,async()=>{
  const result=await probe('returned',event)
  expect(result.faults).toEqual([{id:1,phase:'run',message:'Client surface.js: a promise it returned was rejected: returned failed'}])
  expect(result.warnings).toEqual([])
  expect(result.first).toEqual({stopped:true})
  expect(result.sibling.stopped).not.toBe(true)
  expect(result.hooks).toBe('hooks alive')
 })
 test(`actual Worker ${event} detached rejection only warns and keeps instance`,async()=>{
  const result=await probe('detached',event)
  expect(result.faults).toEqual([])
  expect(result.warnings).toEqual(['Client: a promise a surface module did not return was rejected: returned failed; the session goes on'])
  expect(result.first.stopped).not.toBe(true)
  expect(result.sibling.stopped).not.toBe(true)
  expect(result.hooks).toBe('hooks alive')
 })
 test(`actual Worker ${event} successful Promise value is ignored`,async()=>{
  const result=await probe('success',event)
  expect(result.faults).toEqual([])
  expect(result.warnings).toEqual([])
  expect(JSON.stringify(result)).not.toContain('must not draw')
  expect(result.first.stopped).not.toBe(true)
 })
}
for(const event of ['draw','pointer','key','tick','held']) test(`actual Worker ${event} is called bare`,async()=>{
 const result=await probe('bare',event)
 expect(result.observation).toEqual(event==='draw'?{bare:true}:{event,bare:true})
 expect(result.faults).toEqual([])
})
for(const shape of ['object','function','getter']) test(`actual Worker hears ${shape} thenable rejection`,async()=>{
 const result=await probe('returned','key',shape)
 expect(result.faults).toEqual([{id:1,phase:'run',message:`Client surface.js: a promise it returned was rejected: ${shape==='getter'?'getter failed':'returned failed'}`}])
 expect(result.warnings).toEqual([])
 expect(result.first).toEqual({stopped:true})
})
for(const mode of ['unmounted','generation','unloaded']) test(`actual Worker ${mode} rejects no newer numeric owner`,async()=>{
 const result=await probe(mode)
 expect(result.faults.filter((fault:any)=>fault.generation==='new')).toEqual([])
 expect(result.faults.length).toBeLessThanOrEqual(1)
 if(mode==='generation') {
  expect(result.heldDelivered).toBe(true)
  expect(result.invalidWarnings).toBe(0)
  expect(result.faults).toEqual([])
  expect(result.warnings).toEqual(['Client: a promise an instance since unmounted returned was rejected: returned failed'])
 }
 if(mode==='unloaded') {
  expect(result.heldDelivered).toBe(true)
  expect(result.faults).toEqual([])
  expect(result.warnings).toEqual([])
  expect(result.oldUnloaded).toMatch(/environment.*unloaded|Unknown module environment/i)
 }
 expect(result.first.stopped).toBe(mode==='unmounted'?true:undefined)
 expect(result.sibling.stopped).not.toBe(true)
 expect(result.hooks).toBe('hooks alive')
})
for(const mode of ['render-resolved','render-rejected']) test(`actual Worker ${mode} fails synchronously rather than await tree`,async()=>{
 const result=await probe(mode)
 expect(result.mountError.phase).toBe('render')
 expect(result.faults).toEqual([])
 expect(result.hooks).toBe('hooks alive')
 if(mode==='render-rejected') expect(result.warnings).toEqual(['Client: a promise an instance since unmounted returned was rejected: returned render failed'])
})


test('actual Worker retires an unresponsive rejection turn within its original watchdog deadline',async()=>{
 const started=performance.now()
 const result=await probe('render-budget')
 expect(result.closed[0]).toBe(true)
 expect(result.mountError.phase).toBe('render')
 expect(result.faults).toEqual([])
 expect(result.hooks).toBe('hooks alive')
 expect(performance.now()-started).toBeLessThan(2500)
})

for(const mode of ['render-budget-dispose','render-budget-unload']) test(`actual Worker ${mode} immediately isolates a retired turn without awaiting ACK`,async()=>{
 const result=await probe(mode)
 expect(result.mountError.phase).toBe('render')
 expect(result.closed[0]).toBe(true)
 expect(result.faults).toEqual([])
 expect(result.hooks).toBe('hooks alive')
})

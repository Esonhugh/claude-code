import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function runOwnedChild(args:string[],timeoutMs=18_000) {
 const child=Bun.spawn([process.execPath,...args],{cwd:process.cwd(),stdout:'pipe',stderr:'pipe'})
 let timedOut=false
 const deadline=setTimeout(()=>{
  if(child.exitCode===null){timedOut=true;child.kill('SIGKILL')}
 },timeoutMs)
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  return {stdout,stderr,code,timedOut,killed:child.killed,signal:child.signalCode}
 }finally{
  clearTimeout(deadline)
  if(child.exitCode===null)child.kill('SIGKILL')
  await child.exited
 }
}

for(const mode of ['pane','above','props','key-order','region','columns','rows','conversationColumns','repeat','sibling','layout']) test(mode==='layout'?'actual FullscreenLayout propagates global dimensions across all five terminal regions':`actual Ink ${mode} owns a terminal throw and caches equal input`, async () => {
 const {stdout,stderr,code,timedOut}=await runOwnedChild([fileURLToPath(new URL('./fixtures/terminalClientCacheProbe.tsx',import.meta.url)),mode])
 const evidence=process.env.MODS_TERMINAL_CACHE_EVIDENCE_DIR
 if(evidence) {
  await Bun.write(join(evidence,`consumer-${mode}.stdout.txt`),stdout)
  await Bun.write(join(evidence,`consumer-${mode}.stderr.txt`),stderr)
 }
 if(code!==0) console.error(stdout,stderr)
 expect(timedOut).toBe(false)
 expect(code).toBe(0)
 expect(stdout).toContain('"status":"passed"')
},20_000)

test('owned Ink probe child exits normally before its hard deadline',async()=>{
 const result=await runOwnedChild(['-e',"console.log('child finished')"],1_000)
 expect(result.code).toBe(0);expect(result.stdout).toContain('child finished');expect(result.timedOut).toBe(false);expect(result.signal).toBeNull()
})

test('owned Ink probe child failure is reported without hiding its stderr',async()=>{
 const result=await runOwnedChild(['-e',"throw Error('owned child failure')"],1_000)
 expect(result.code).not.toBe(0);expect(result.stderr).toContain('owned child failure');expect(result.timedOut).toBe(false)
})

test('owned Ink probe hard deadline kills and reaps only its spawned child',async()=>{
 const result=await runOwnedChild(['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},10);setTimeout(()=>process.exit(0),500)"],50)
 expect(result.timedOut).toBe(true);expect(result.killed).toBe(true);expect(result.signal).toBe('SIGKILL');expect(result.code).not.toBe(0)
})

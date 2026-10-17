import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModsRuntime } from './runtime.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let root: string
let runtime: ReturnType<typeof createModsRuntime> | undefined
const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_COWORK_PLUGINS']
let saved: (string | undefined)[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-spawn-'))
  saved = keys.map(key => process.env[key])
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(root, 'config', 'plugins')
  process.env.ANTHROPIC_API_KEY = 'test-api-key'
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  resetSettingsCache()
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  resetSettingsCache()
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  await rm(root, {recursive:true, force:true})
})

async function plugin(name: string, source: string) {
  const pluginRoot = join(root, name)
  await mkdir(pluginRoot)
  const entry = join(pluginRoot, 'register.ts')
  await writeFile(entry, source)
  return {name, storageId:name + '@test', pluginRoot, entrypoints:[entry]}
}

async function begin(inputs: Awaited<ReturnType<typeof plugin>>[]) {
  const diagnostics: unknown[] = []
  runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  await runtime.bind({cwd:root,sessionId:'spawn-session',surface:'terminal',isInteractive:true})
  await runtime.reconcile(inputs)
  expect(diagnostics).toEqual([])
  return diagnostics
}

async function gone(pid: number) {
  const deadline = Date.now() + 5000
  for (;;) {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
    if (Date.now() >= deadline) throw new Error(`Owned child ${pid} did not exit`)
    await delay(10)
  }
}

async function childPid() {
  const deadline = Date.now() + 5000
  for (;;) {
    const pid = await readFile(join(root, 'child.pid'), 'utf8').then(Number, () => undefined)
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) return pid
    if (Date.now() >= deadline) throw new Error('Owned child did not start')
    await delay(10)
  }
}

const trigger = () => runtime!.dispatch('tool.call', {tool:'Read',tool_use_id:'spawn-test'}, async () => ({result:'unexpected core'}))

test.each([false,true])('a streaming hook timeout stops its opened real child and catch has a fresh lifetime: catch=%s', async catching => {
  const child=join(root,'timeout-child.mjs')
  await writeFile(child, `import {writeFileSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));process.stdout.write('ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(99),25000);`)
  const author=await plugin('timeout-stream-author',`export function register(on){
    on('turn.step',async function*($,e){
      const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});await flow.next();
      for(let i=0;i<40;i++){const end=Date.now()+350;while(Date.now()<end){}await $.clock.sleep(1)}
      return {...e,answer:'must time out',toolUses:[],stopReason:'end_turn',usage:null};
    })${catching ? `.catch(async function*($,e){
      const child=$.process.spawn({argv:${JSON.stringify([process.execPath,'-e', "import {writeFileSync} from 'node:fs';writeFileSync('fresh.pid',String(process.pid));process.stdout.write('fresh');process.exitCode=8;"])}});
      let text='';for await(const c of child)text+=c.text;
      const receipt=await child.result;
      return {...e,answer:'catch:'+receipt.code+':'+text,toolUses:[],stopReason:'end_turn',usage:null};
    })` : ''};
  }`)
  const diagnostics=await begin([author])
  let coreCalls=0
  // eslint-disable-next-line require-yield -- This fallback returns a terminal receipt without chunks.
  const turn=runtime!.stream('turn.step',{turnId:'timeout-turn',index:0,messageCount:1,model:'fake'},async function*(){coreCalls++;return {turnId:'timeout-turn',index:0,answer:'fallback',toolUses:[],stopReason:'end_turn',usage:null}})
  try {
    expect((await turn.next()).done).toBe(true)
    expect(await turn.result).toMatchObject({answer:catching ? 'catch:8:fresh' : 'fallback'})
    expect(coreCalls).toBe(catching ? 0 : 1)
    const pid=await childPid()
    await gone(pid)
    if(catching){const fresh=Number(await readFile(join(root,'fresh.pid'),'utf8'));expect(fresh).not.toBe(pid);await gone(fresh)}
    expect(diagnostics).toEqual([expect.objectContaining({plugin:'timeout-stream-author',stage:'turn.step',message:expect.stringContaining('timed out')})])
  } finally {await turn.return(undefined);await runtime!.reconcile([])}
},30000)

test('official process middleware passes a value receipt without imposing extra code or signal checks', async () => {
  const observer = await plugin('receipt-observer', `export function register(on) {
    on('process.spawn',async function*(){return {value:{code:'bad-code',signal:12}}});
  }`)
  const author = await plugin('receipt-author', `export function register(on) {
    on('tool.call',async $=>{const flow=$.process.spawn({argv:['must-not-start']});const chunks=[];for await(const c of flow)chunks.push(c);return {result:{chunks,receipt:await flow.result}}});
  }`)
  const diagnostics = await begin([observer,author])
  expect(await trigger()).toEqual({result:{chunks:[],receipt:{code:'bad-code',signal:12}}})
  expect(diagnostics).toEqual([])
})

test('real Worker process.spawn synchronously returns a stream and reaches owned child pipes and raw receipt', async () => {
  const child = join(root, 'child.mjs')
  await writeFile(child, `import {writeFileSync} from 'node:fs';
writeFileSync('child.pid', String(process.pid));
let input = ''; for await (const part of process.stdin) input += part;
process.stdout.write(JSON.stringify({input,cwd:process.cwd(),env:process.env.MODS_SPAWN_MARKER}));
process.stderr.write('stderr-漢字-é'); process.exitCode = 7;`)
  const author = await plugin('spawn-author', `export function register(on) {
    on('tool.call', async $ => {
      const flow = $.process.spawn({argv:${JSON.stringify([process.execPath, child])}, input:'stdin-é-漢字', env:{MODS_SPAWN_MARKER:'owned-env'}});
      const immediate = typeof flow.next === 'function' && !('then' in flow);
      const chunks = []; for await (const chunk of flow) chunks.push(chunk);
      return {result:{immediate,chunks,exit:await flow.result}};
    });
  }`)
  const diagnostics: unknown[] = []
  runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  await runtime.bind({cwd:root,sessionId:'spawn-session',surface:'terminal',isInteractive:true})
  await runtime.reconcile([author])
  expect(diagnostics).toEqual([])
  const output = await runtime.dispatch('tool.call', {tool:'Read',tool_use_id:'spawn-test'}, async () => ({result:'unexpected core'})) as {
    result: {immediate:boolean; chunks:{stream:string;text:string}[]; exit:unknown}
  }
  expect(output.result.immediate).toBe(true)
  expect(output.result.chunks.length).toBeGreaterThan(0)
  for (const chunk of output.result.chunks) {
    expect(['stdout','stderr']).toContain(chunk.stream)
    expect(chunk.text.length).toBeGreaterThan(0)
  }
  const stdout = output.result.chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('')
  const stderr = output.result.chunks.filter(c => c.stream === 'stderr').map(c => c.text).join('')
  expect(JSON.parse(stdout)).toEqual({input:'stdin-é-漢字',cwd:root,env:'owned-env'})
  expect(stderr).toBe('stderr-漢字-é')
  expect(output.result.exit).toEqual({code:7,signal:null})
  const pid = Number(await readFile(join(root, 'child.pid'), 'utf8'))
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  expect(() => process.kill(pid, 0)).toThrow()
  expect(diagnostics).toEqual([])
}, 15000)

test('real process.spawn middleware rewrites child env/chunks, receives wrapped result, preserves host origin', async () => {
  const child = join(root, 'child.mjs')
  await writeFile(child, `process.stdout.write(process.env.MODS_SPAWN_MARKER); process.exitCode = 7;`)
  const observer = await plugin('spawn-observer', `export function register(on) {
    on('process.spawn', async function* ($, e, next) {
      const below = next({...e,env:{MODS_SPAWN_MARKER:'rewritten'}});
      for await (const chunk of below) yield {...chunk,text:JSON.stringify({text:chunk.text,origin:next.origin})};
      const receipt = await below.result;
      return {value:{...receipt.value,code:receipt.value.code+1}};
    });
  }`)
  const author = await plugin('spawn-author', `export function register(on) {
    on('tool.call', async $ => {
      const flow = $.process.spawn({argv:${JSON.stringify([process.execPath,child])}, env:{MODS_SPAWN_MARKER:'before'},plugin:'forged',signal:'forged',timeoutMs:1});
      const chunks = []; for await (const chunk of flow) chunks.push(chunk);
      return {result:{chunks,exit:await flow.result}};
    });
  }`)
  const diagnostics = await begin([observer,author])
  const output = await trigger() as {result:{chunks:{text:string}[];exit:unknown}}
  expect(output.result.chunks.map(c => JSON.parse(c.text))).toEqual([{text:'rewritten',origin:{plugin:'spawn-author',tier:'user'}}])
  expect(output.result.exit).toEqual({code:8,signal:null})
  expect(diagnostics).toEqual([])
})

test('two real next streams start distinct children and preserve both outputs', async () => {
  const argv = [process.execPath, '-e', 'process.stdout.write(String(process.pid)+"\\n")']
  const observer = await plugin('twice', `export function register(on) {
    on('process.spawn', async function* ($, e, next) {
      let receipt;
      for (let index=0;index<2;index++) { const child=next(e); for await (const chunk of child) yield chunk; receipt=await child.result; }
      return receipt;
    });
  }`)
  const author = await plugin('twice-author', `export function register(on) {
    on('tool.call', async $ => { const flow=$.process.spawn({argv:${JSON.stringify(argv)}}); let text=''; for await (const c of flow) text+=c.text; return {result:{text,exit:await flow.result}}; });
  }`)
  const diagnostics = await begin([observer,author])
  const {result} = await trigger() as {result:{text:string;exit:unknown}}
  const pids = result.text.trim().split('\n').map(Number)
  expect(pids.length).toBe(2)
  expect(pids.every(pid => Number.isInteger(pid) && pid > 0)).toBe(true)
  expect(new Set(pids).size).toBe(2)
  for (const pid of pids) await gone(pid)
  expect(result.exit).toEqual({code:0,signal:null})
  expect(diagnostics).toEqual([])
})

test('invalid argv/env/cwd/input and missing executable reject first pull and result without breaking the author', async () => {
  const author = await plugin('invalid-author', `export function register(on) {
    on('tool.call', async $ => {
      const failures=[];
      for (const request of [{argv:[]},{argv:['']},{argv:[1]},{argv:['unused'],env:{bad:1}},{argv:['unused'],cwd:''},{argv:['unused'],input:1},{argv:[${JSON.stringify(join(root,'nonexistent-owned-executable'))}]}]) {
        const flow=$.process.spawn(request); const immediate=typeof flow.next==='function';
        let pull,receipt; try {await flow.next()} catch (error) {pull=error.message}
        try {await flow.result} catch (error) {receipt=error.message}
        failures.push({immediate,pull,receipt});
      }
      return {result:failures};
    });
  }`)
  const diagnostics = await begin([author])
  const {result} = await trigger() as {result:{immediate:boolean;pull:string;receipt:string}[]}
  expect(result.length).toBe(7)
  for (const failure of result) {
    expect(failure.immediate).toBe(true)
    expect(failure.pull.length).toBeGreaterThan(0)
    expect(failure.receipt).toBe(failure.pull)
  }
  expect(diagnostics).toEqual([])
})

test('breaking a real process stream terminates the owned child and rejects its unfinished receipt', async () => {
  const child = join(root,'child.mjs')
  await writeFile(child, `process.stdout.write(String(process.pid)); setInterval(()=>{},1000); setTimeout(()=>process.exit(99),20000);`)
  const author = await plugin('break-author', `export function register(on) {
    on('tool.call', async $ => {
      const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}}); let pid;
      for await (const chunk of flow) {pid=Number(chunk.text);break;}
      let failure; try {await flow.result} catch(error) {failure={name:error.name,message:error.message}}
      return {result:{pid,failure}};
    });
  }`)
  const diagnostics = await begin([author])
  const {result} = await trigger() as {result:{pid:number;failure:{name:string;message:string}}}
  expect(result.pid).toBeGreaterThan(0)
  expect(result.failure).toEqual({name:'HooksError',message:'the stream was closed before its result'})
  await gone(result.pid)
  expect(diagnostics).toEqual([])
},15000)

test('process.spawn catch resumes the retained real child after one chunk without a second spawn', async () => {
  const child=join(root,'recover-child.mjs')
  await writeFile(child, `import {appendFileSync,existsSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';appendFileSync('child.pid',String(process.pid)+'\\n');process.stdout.write('first');while(!existsSync('release-recovery'))await setTimeout(1);process.stdout.write('second');`)
  const observer=await plugin('recover-observer',`export function register(on){
    on('process.spawn',async function*($,e,next){const flow=next(e);yield (await flow.next()).value;throw Error('controlled transform failure')})
    .catch(async function*($,e,next){await $.fs.write('release-recovery','release');return yield* next(e)});
  }`)
  const author=await plugin('recover-author',`export function register(on){on('tool.call',async $=>{const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});let text='';for await(const c of flow)text+=c.text;return {result:{text,exit:await flow.result}}})}`)
  const diagnostics=await begin([observer,author])
  expect(await trigger()).toEqual({result:{text:'firstsecond',exit:{code:0,signal:null}}})
  const pids=(await readFile(join(root,'child.pid'),'utf8')).trim().split('\n').map(Number)
  expect(pids.length).toBe(1)
  await gone(pids[0]!)
  expect(diagnostics).toEqual([expect.objectContaining({plugin:'recover-observer',stage:'process.spawn',message:'controlled transform failure'})])
},15000)

test('process.spawn catch has one total grace budget across its pieces and then starts the real fallback once', async () => {
  const child=join(root,'catch-child.mjs')
  await writeFile(child, `import {appendFileSync} from 'node:fs';appendFileSync('child.pid',String(process.pid)+'\\n');process.stdout.write('fallback-child');`)
  const observer=await plugin('catch-budget',`export function register(on){
    on('process.spawn',async function*($,e,next){throw Error('controlled entry failure')})
    .catch(async function*($,e,next){for(let index=0;index<4;index++){const end=Date.now()+350;while(Date.now()<end){};yield {stream:'stdout',text:'catch-'+index}};return {value:{code:9,signal:null}}});
  }`)
  const author=await plugin('catch-author',`export function register(on){on('tool.call',async $=>{const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});let text='';for await(const c of flow)text+=c.text;return {result:{text,exit:await flow.result}}})}`)
  const diagnostics=await begin([observer,author])
  expect(await trigger()).toEqual({result:{text:'catch-0catch-1fallback-child',exit:{code:0,signal:null}}})
  const pids=(await readFile(join(root,'child.pid'),'utf8')).trim().split('\n').map(Number)
  expect(pids.length).toBe(1)
  await gone(pids[0]!)
  expect(diagnostics).toEqual([
    expect.objectContaining({plugin:'catch-budget',stage:'process.spawn',message:'controlled entry failure'}),
    expect.objectContaining({plugin:'catch-budget',stage:'process.spawn',message:'Mod catch-budget timed out for process.spawn'}),
  ])
},15000)

test('a denied process stream distinguishes refusal before starting from withholding a real completed child result', async () => {
  const child=join(root,'denied-child.mjs')
  await writeFile(child, `import {writeFileSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));process.stdout.write('child ran before denial');`)
  const observer=await plugin('deny-observer',`export function register(on){on('process.spawn',async function*($,e,next){
    if(e.env.MODE==='before')return{deny:'held spawn'};
    const flow=next(e);for await(const c of flow)yield c;await flow.result;return{deny:'held after child'};
  })}`)
  const author=await plugin('deny-author',`export function register(on){on('tool.call',async($,e)=>{
    const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])},env:{MODE:e.mode}});let text='',failure,receipt;
    try{for await(const c of flow)text+=c.text}catch(error){failure={name:error.name,message:error.message}}
    try{await flow.result}catch(error){receipt={name:error.name,message:error.message}}
    return {result:{text,failure,receipt}};
  })}`)
  const diagnostics=await begin([observer,author])
  const run=(mode:string)=>runtime!.dispatch('tool.call',{tool:'Read',tool_use_id:'denied-spawn',mode},async()=>({result:'unexpected core'}))
  const before={name:'HooksError',message:'deny-author: $.process.spawn: held spawn'}
  expect(await run('before')).toEqual({result:{text:'',failure:before,receipt:before}})
  expect(await readFile(join(root,'child.pid'),'utf8').then(()=>true,()=>false)).toBe(false)
  const after={name:'HooksError',message:'deny-author: $.process.spawn ran, and a plugin withheld its result: held after child'}
  expect(await run('after')).toEqual({result:{text:'child ran before denial',failure:after,receipt:after}})
  await gone(await childPid())
  expect(diagnostics).toEqual([])
})

test('process.spawn resets own budget for each downstream piece when its hook filters pieces', async () => {
  const child=join(root,'budget-child.mjs')
  await writeFile(child, `import {existsSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';
for(let index=0;index<3;index++) {process.stdout.write(String(index));while(!existsSync('ack-'+index))await setTimeout(1);}`)
  const observer=await plugin('budget-filter',`export function register(on){on('process.spawn',async function*($,e,next){
    const flow=next(e);const budgets=[];let index=0;
    for await(const c of flow) {budgets.push(next.budget.remainingMs);const end=Date.now()+200;while(Date.now()<end){};await $.fs.write('ack-'+index++,'ack');}
    yield {stream:'stdout',text:JSON.stringify({budgets,total:next.budget.ms})};return await flow.result;
  })}`)
  const author=await plugin('budget-author',`export function register(on){on('tool.call',async $=>{
    const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});let text='';for await(const c of flow)text+=c.text;return {result:{...JSON.parse(text),exit:await flow.result}};
  })}`)
  const diagnostics=await begin([observer,author])
  const {result}=await trigger() as {result:{budgets:number[];total:number;exit:unknown}}
  expect(result.budgets.length).toBe(3)
  expect(result.total).toBe(10000)
  for(const remaining of result.budgets) expect(remaining).toBeGreaterThan(result.total-100)
  expect(result.exit).toEqual({code:0,signal:null})
  expect(diagnostics).toEqual([])
},15000)

test('closing a process stream kills its owned descendant after that descendant starts a new process group', async () => {
  const grand=join(root,'grand.mjs'),child=join(root,'tree-child.mjs')
  await writeFile(grand, `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync('grand.pid',String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),20000);`)
  await writeFile(child, `import {spawn} from 'node:child_process';import {readFileSync,existsSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';
spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(grand)}],{detached:true,stdio:'ignore'});while(!existsSync('grand.pid'))await setTimeout(1);process.stdout.write(JSON.stringify({pid:process.pid,grand:Number(readFileSync('grand.pid','utf8'))}));setInterval(()=>{},1000);`)
  const author=await plugin('tree-author',`export function register(on){on('tool.call',async $=>{
    const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});const pids=JSON.parse((await flow.next()).value.text);await flow.return();try{await flow.result}catch(error){};return {result:pids};
  })}`)
  const diagnostics=await begin([author])
  const {result}=await trigger() as {result:{pid:number;grand:number}}
  expect(result.pid).toBeGreaterThan(0)
  expect(result.grand).toBeGreaterThan(0)
  let cleanupError: unknown
  try {await gone(result.pid);await gone(result.grand)}
  finally {
    try {process.kill(-result.grand,'SIGKILL')} catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')cleanupError=error}
    await gone(result.grand)
  }
  if (cleanupError) throw cleanupError
  expect(diagnostics).toEqual([])
},15000)

test('parent cancellation stops a real child and retains its specific reason with no core replay', async () => {
  const child = join(root,'child.mjs')
  await writeFile(child, `import {writeFileSync} from 'node:fs'; writeFileSync('child.pid',String(process.pid)); setInterval(()=>{},1000);setTimeout(()=>process.exit(99),20000);`)
  const author = await plugin('cancel-author', `export function register(on) {
    on('tool.call', async $ => { const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}}); for await (const chunk of flow) {} return {result:'unexpected'}; });
  }`)
  await begin([author])
  const controller = new AbortController()
  let calls = 0
  const pending = runtime!.dispatch('tool.call', {tool:'Read',tool_use_id:'cancel'}, async () => {calls++;return {result:'core'}}, {signal:controller.signal}).then(value => value, error => error)
  try {
    const pid = await childPid()
    const reason = new Error('specific process spawn parent cancellation')
    controller.abort(reason)
    expect(await pending).toBe(reason)
    await gone(pid)
    expect(calls).toBe(0)
  } finally {controller.abort(); await pending}
},15000)

test('a detached author loop continues after its hook returns and module unload stops its child', async () => {
  const child = join(root,'child.mjs')
  await writeFile(child, `import {writeFileSync,existsSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));
const timer=setInterval(()=>{if(existsSync('release-child')) {process.stdout.write('after-hook');clearInterval(timer)}},10);setTimeout(()=>process.exit(99),20000);`)
  const author = await plugin('detached-author', `let flow, pieces=[],failure;
    export function register(on) {
      on('session.start', async ($, e, next) => {
        const started=await next(e);
        void (async()=>{try {flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});for await (const c of flow) pieces.push(c.text);} catch(error) {failure=error.message}})();
        return started;
      });
      on('tool.call', ()=>({result:{pieces,failure}}));
    }`)
  const diagnostics = await begin([author])
  const pid = await childPid()
  await writeFile(join(root,'release-child'),'release after session.start completed')
  const deadline = Date.now()+5000
  for (;;) {
    const {result} = await trigger() as {result:{pieces:string[];failure?:string}}
    if (result.pieces.join('') === 'after-hook') {expect(result.failure).toBeUndefined(); break}
    if (Date.now() >= deadline) throw new Error(`Detached stream failed: ${JSON.stringify(result)}`)
    await delay(10)
  }
  await runtime!.reconcile([])
  await gone(pid)
  expect(diagnostics).toEqual([])
},15000)

test('real pipe decoding preserves split Unicode and streams more than the process.run cap without truncation', async () => {
  const child=join(root,'child.mjs')
  await writeFile(child, `import {writeSync} from 'node:fs'; const value=Buffer.from('漢字-é');for (const byte of value) writeSync(1,Buffer.from([byte]));
for(let index=0;index<96;index++) {writeSync(1,Buffer.alloc(65536,65));writeSync(2,Buffer.alloc(65536,66));}`)
  const author=await plugin('large-author',`export function register(on) {on('tool.call',async $=> {
    const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}}); let out='',err='',empty=false;
    for await(const c of flow) {if(!c.text) empty=true;if(c.stream==='stdout') out+=c.text;else err+=c.text;}
    return {result:{prefix:out.slice(0,5),outLength:out.length,errLength:err.length,bad:out.includes('�'),empty,exit:await flow.result}};
  })}`)
  const diagnostics=await begin([author])
  expect(await trigger()).toEqual({result:{prefix:'漢字-éA',outLength:96*65536+4,errLength:96*65536,bad:false,empty:false,exit:{code:0,signal:null}}})
  expect(diagnostics).toEqual([])
},20000)

test('a child started inside a turn.step generator survives that generator normal return', async () => {
  const child=join(root,'child.mjs')
  await writeFile(child, `import {writeFileSync,existsSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));
const timer=setInterval(()=>{if(existsSync('release-child')) {process.stdout.write('after-stream-hook');clearInterval(timer)}},10);setTimeout(()=>process.exit(99),20000);`)
  const author=await plugin('stream-detached', `let pieces=[],failure;
    export function register(on) {
      on('turn.step',async function* ($,e,next) {
        void(async()=>{try {const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});for await(const c of flow) pieces.push(c.text);}catch(error){failure=error.message}})();
        while(!await $.fs.exists('child.pid')) await $.clock.sleep(10);
        return {...e,answer:'completed turn hook',toolUses:[],stopReason:'end_turn',usage:null};
      });
      on('tool.call',()=>({result:{pieces,failure}}));
    }`)
  const diagnostics=await begin([author])
  // eslint-disable-next-line require-yield -- This fallback returns a terminal receipt without chunks.
  const turn=runtime!.stream('turn.step',{turnId:'owned-turn',index:0,messageCount:1,model:'fake'},async function*(){return {turnId:'owned-turn',index:0,answer:'unused core',toolUses:[],stopReason:'end_turn',usage:null}})
  expect((await turn.next()).done).toBe(true)
  expect(await turn.result).toMatchObject({answer:'completed turn hook'})
  const pid=await childPid()
  await writeFile(join(root,'release-child'),'after turn hook completed')
  const deadline=Date.now()+5000
  for(;;) {
    const {result}=await trigger() as {result:{pieces:string[];failure?:string}}
    if(result.pieces.join('')==='after-stream-hook') {expect(result.failure).toBeUndefined();break}
    if(result.failure || Date.now()>=deadline) throw new Error(`Stream-hook child did not survive: ${JSON.stringify(result)}`)
    await delay(10)
  }
  await runtime!.reconcile([])
  await gone(pid)
  expect(diagnostics).toEqual([])
},15000)

test('a held hook cannot start a new child after its owner has retired', async () => {
  const child=join(root,'child.mjs')
  await writeFile(child, `import {writeFileSync} from 'node:fs';writeFileSync('child.pid',String(process.pid));process.stdout.write('incorrect late admission');`)
  const author=await plugin('retired-author', `export function register(on) {
    on('tool.call',async $=> {
      await $.fs.write('hook-entered','entered');
      while(!await $.fs.exists('release-after-retire')) await $.clock.sleep(10);
      let failure;
      try {const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});for await(const c of flow){};await flow.result;}catch(error){failure=error.message}
      return {result:{failure}};
    });
  }`)
  await begin([author])
  const pending=trigger()
  const deadline=Date.now()+5000
  while(!await readFile(join(root,'hook-entered'),'utf8').then(()=>true,()=>false)) {if(Date.now()>=deadline)throw new Error('Hook did not enter');await delay(10)}
  await runtime!.reconcile([])
  await writeFile(join(root,'release-after-retire'),'retirement complete')
  const result=await pending
  expect(result).toEqual({result:{failure:'Module environment unloaded'}})
  expect(await readFile(join(root,'child.pid'),'utf8').then(()=>true,()=>false)).toBe(false)
},15000)

test('official process stream return before first pull leaves result pending and does not start a child', async () => {
  const author=await plugin('before-first',`export function register(on){on('tool.call',async $=>{
    const flow=$.process.spawn({argv:[${JSON.stringify(join(root,'nonexistent-executable'))}]});let state='pending';
    flow.result.then(()=>{state='fulfilled'},()=>{state='rejected'});
    const returned=await flow.return();await Promise.resolve();return {result:{returned,state}};
  })}`)
  const diagnostics=await begin([author])
  expect(await trigger()).toEqual({result:{returned:{done:true,value:undefined},state:'pending'}})
  expect(diagnostics).toEqual([])
})

test('official process stream return during pending read settles that read and result without a replacement AbortError', async () => {
  const child=join(root,'child.mjs')
  await writeFile(child, `process.stdout.write(String(process.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),20000);`)
  const author=await plugin('pending-read',`export function register(on){on('tool.call',async $=>{
    const flow=$.process.spawn({argv:${JSON.stringify([process.execPath,child])}});const pid=Number((await flow.next()).value.text);
    const pending=flow.next();const closed=await flow.return();const next=await pending;const receipt=await flow.result;
    return {result:{pid,closed,next,receipt}};
  })}`)
  const diagnostics=await begin([author])
  const {result}=await trigger() as {result:{pid:number;closed:unknown;next:unknown;receipt:unknown}}
  expect(diagnostics).toEqual([])
  expect(result.pid).toBeGreaterThan(0)
  expect(result.closed).toEqual({done:true,value:undefined})
  expect(result.next).toEqual({done:true,value:undefined})
  expect(result.receipt).toBeUndefined()
  await gone(result.pid)
  expect(diagnostics).toEqual([])
},15000)

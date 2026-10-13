import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dir, '../../../..')
const runner = join(import.meta.dir, 'runner.ts')

async function author(source: string) {
  await mkdir(join(repository, '.claude-test-evidence'), { recursive: true })
  const root = await mkdtemp(join(repository, '.claude-test-evidence/author-contract-'))
  await mkdir(join(root, '.claude-plugin')); await mkdir(join(root, 'hooks')); await mkdir(join(root, 'home'))
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'author-contract', version: '1.0.0' }))
  await writeFile(join(root, 'hooks/hooks.json'), JSON.stringify({ modules: ['../register.ts'] }))
  await writeFile(join(root, 'register.ts'), 'export function register(on) {}')
  const file = join(root, 'contract.test.ts')
  await writeFile(file, `import {test,expect} from 'claude-code/testing';\n${source}`)
  const child = Bun.spawn([process.execPath, runner, '--child', root, file], {
    cwd: repository,
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'home/config'), TMPDIR: root,
      ANTHROPIC_API_KEY: 'mods-test-unused', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(), 15000)
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    await writeFile(join(root, 'stdout.log'), stdout); await writeFile(join(root, 'stderr.log'), stderr)
    const line = stdout.split('\n').find(line => line.startsWith('__CLAUDE_PLUGIN_TEST_RESULT__'))
    expect(line, stderr || stdout).toBeDefined()
    return { root, status, stderr, result: JSON.parse(line!.slice('__CLAUDE_PLUGIN_TEST_RESULT__'.length)) as { tests: { name: string; failure?: string }[]; loadFailure?: string } }
  } finally { clearTimeout(watchdog) }
}
async function passes(source: string) {
  const response = await author(source)
  expect(response.stderr).toBe('')
  expect(response.status, JSON.stringify(response.result)).toBe(0)
  expect(response.result.loadFailure).toBeUndefined()
  expect(response.result.tests).toHaveLength(1)
  expect(response.result.tests[0]!.failure).toBeUndefined()
}

test('author on remains open across ordinary awaits and engine method property reads', async () => {
  await passes(`test('late preparation',async($,on)=>{
    const noun=$.env, get=noun.get;
    await Promise.resolve(); await new Promise(resolve=>queueMicrotask(resolve)); await new Promise(resolve=>setTimeout(resolve,1));
    on('env.get',(_$,e)=>({value:e.name}));
    expect(await get({name:'prepared'})).toEqual({value:'prepared'});
  });`)
}, 20000)
test('a generic engine call closes on immediately even when its Promise is not awaited', async () => {
  await passes(`test('generic call',async($,on)=>{
    on('env.get',()=>({value:'ready'}));
    const pending=$.env.get({name:'first'});
    expect(()=>on('clock.now',()=>({value:1}))).toThrow();
    expect(await pending).toEqual({value:'ready'});
  });`)
}, 20000)
test('constructing and reading a stream factory does not close author on before first next', async () => {
  await passes(`test('lazy stream',async($,on)=>{
    const stream=$.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
    const pull=stream.next; expect(typeof pull).toBe('function'); await Promise.resolve();
    on('turn.step',async function*(){yield {kind:'text',index:0,text:'ready'};return {turnId:'turn',index:0,answer:'done',toolUses:[],stopReason:'end_turn',usage:null};});
    const first=stream.next();
    expect(()=>on('clock.now',()=>({value:1}))).toThrow();
    expect(await first).toEqual({done:false,value:{kind:'text',index:0,text:'ready'}});
    expect((await stream.next()).done).toBe(true);
  });`)
}, 20000)
test.each(['return', 'throw'] as const)('stream first %s keeps on open and does not initialize the stream body', async method => {
  await passes(`test('empty stream',async($,on)=>{
    const stream=$.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
    ${method === 'return' ? "expect(await stream.return('closed')).toEqual({done:true,value:'closed'});" : "await expect(stream.throw(new Error('unused stream'))).rejects.toThrow('unused stream');"}
    on('env.get',()=>({value:'still open'}));
    expect(await $.env.get({name:'after close'})).toEqual({value:'still open'});
  });`)
}, 20000)
test('author Registration is frozen and catch returns undefined while a thrown hook really recovers', async () => {
  await passes(`test('recover',async($,on)=>{
    const registration=on('env.get',()=>{throw new Error('recover this')});
    expect(Object.isFrozen(registration)).toBe(true);
    const attach=registration.catch; await Promise.resolve();
    expect(attach((_$,e,next)=>{
      expect(next.error).toEqual({kind:'throw',message:'recover this',budget:1000});
      expect(Object.isFrozen(next.error)).toBe(true); expect(next.called).toBe(false);
      return {value:'recovered'};
    })).toBeUndefined();
    expect(await $.env.get({name:'failure'})).toEqual({value:'recovered'});
  });`)
}, 20000)
test('catch replays the actual last next result and does not repeat the bottom hook', async () => {
  await passes(`test('replay',async($,on)=>{
    let bottom=0;
    on('env.get',{name:'first'},async(_$,e,next)=>{await next(e);throw new Error('after next')}).catch(async(_$,e,next)=>{
      expect(next.called).toBe(true);expect(next.error.kind).toBe('throw');
      const first=await next({name:'ignored'}), second=await next.to({name:'also ignored'},'core');
      expect(first).toEqual(second);return first;
    });
    on('env.get',{},()=>{bottom++;return {value:'bottom'}});
    expect(await $.env.get({name:'first'})).toEqual({value:'bottom'});expect(bottom).toBe(1);
  });`)
}, 20000)
test('catch undefined leaves the actual hook absent and falls through once', async () => {
  await passes(`test('undefined catch',async($,on)=>{
    let bottom=0;
    on('env.get',{name:'skip'},()=>{throw new Error('skip')}).catch(()=>undefined);
    on('env.get',{},()=>{bottom++;return {value:'fallback'}});
    expect(await $.env.get({name:'skip'})).toEqual({value:'fallback'});expect(bottom).toBe(1);
  });`)
}, 20000)
test('the testing kit stores the last catch before replay instead of rejecting a second attachment', async () => {
  await passes(`test('replace catch',async($,on)=>{
    const registration=on('env.get',()=>{throw new Error('caught')});
    let first=0,second=0;
    registration.catch(()=>{first++;return {value:'first'}});
    registration.catch(()=>{second++;return {value:'second'}});
    expect(await $.env.get({name:'caught'})).toEqual({value:'second'});expect(first).toBe(0);expect(second).toBe(1);
  });`)
}, 20000)
test('a matched test registration runs neither its hook nor its catch outside the matcher', async () => {
  await passes(`test('matcher',async($,on)=>{
    let hook=0,caught=0;
    on('env.get',{name:'chosen'},()=>{hook++;throw new Error('chosen')}).catch(()=>{caught++;return {value:'caught'}});
    on('env.get',{},()=>({value:'fallback'}));
    expect(await $.env.get({name:'other'})).toEqual({value:'fallback'});expect(hook).toBe(0);expect(caught).toBe(0);
    expect(await $.env.get({name:'chosen'})).toEqual({value:'caught'});expect(hook).toBe(1);expect(caught).toBe(1);
  });`)
}, 20000)
test('catch undefined is omitted at replay while a non-function is rejected by the production registrar', async () => {
  await passes(`test('catch validation',async($,on)=>{
    const registration=on('env.get',()=>({value:'plain'}));registration.catch(undefined);
    expect(await $.env.get({name:'ordinary'})).toEqual({value:'plain'});
  });`)
  const response = await author(`test('bad catch',async($,on)=>{
    let returned=false;const registration=on('env.get',()=>({value:'plain'}));
    registration.catch(42);returned=true;expect(returned).toBe(true);await $.env.get({name:'trigger replay'});
  });`)
  expect(response.status).toBe(1)
  expect(response.result.tests[0]!.failure).toContain('catch')
  expect(response.result.tests[0]!.failure).not.toContain('undefined is not an object')
}, 20000)
test.each(['engine.create', 'plain generator', 'stream plain'] as const)('catch %s validation happens at actual replay', async kind => {
  const event = kind === 'stream plain' ? 'turn.step' : kind === 'engine.create' ? 'engine.create' : 'env.get'
  const hook = event === 'turn.step' ? 'async function*(){return {turnId:"turn",index:0,answer:"done",toolUses:[],stopReason:"end_turn",usage:null}}' : '()=>({value:"plain"})'
  const catcher = kind === 'plain generator' ? 'async function*(){return {value:"invalid"}}' : '()=>({value:"invalid"})'
  const response = await author(`test('invalid replay',async($,on)=>{
    const registration=on('${event}',${hook});registration.catch(${catcher});await $.env.get({name:'load'});
  });`)
  expect(response.status).toBe(1)
  expect(response.result.tests[0]!.failure).toContain('catch')
  expect(response.result.tests[0]!.failure).not.toContain('undefined is not an object')
}, 20000)
test('changing stored catch after replay leaves the actual attached callback unchanged', async () => {
  await passes(`test('post replay catch',async($,on)=>{
    const registration=on('env.get',()=>{throw new Error('repeat')});
    registration.catch(()=>({value:'original'}));expect(await $.env.get({name:'first'})).toEqual({value:'original'});
    expect(registration.catch(()=>({value:'too late'}))).toBeUndefined();
    expect(await $.env.get({name:'second'})).toEqual({value:'original'});
  });`)
}, 20000)
test('a true author rejection still fails and carries observed engine diagnostics', async () => {
  const response = await author(`test('real failure',async($,on)=>{
    on('env.get',()=>{throw new Error('engine-side failure')});on('env.get',{},()=>({value:'fallback'}));
    expect(await $.env.get({name:'probe'})).toEqual({value:'fallback'});throw new TypeError('actual author rejection');
  });`)
  expect(response.status).toBe(1)
  expect(response.result.tests[0]!.failure).toContain('actual author rejection')
  expect(response.result.tests[0]!.failure).toContain('engine-side failure')
}, 20000)

test('a real streaming catch continues yielded chunks and settles its generator result', async () => {
  await passes(`test('stream recover',async($,on)=>{
    on('turn.step',async function*(){yield {kind:'text',index:0,text:'before'};throw new Error('stream failed')}).catch(async function*(_$,e,next){
      expect(next.error).toEqual({kind:'throw',message:'stream failed',budget:1000});expect(next.called).toBe(false);
      expect(Object.isFrozen(next.error)).toBe(true);expect(Object.isFrozen(next)).toBe(true);
      yield {kind:'text',index:0,text:'recovered'};return {turnId:'turn',index:0,answer:'done',toolUses:[],stopReason:'end_turn',usage:null};
    });
    const stream=$.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
    expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'before'}});
    expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'recovered'}});
    expect((await stream.next()).value.answer).toBe('done');expect((await stream.result).answer).toBe('done');
  });`)
}, 20000)
test('a failed actual catch falls through once without turning a fulfilled author case into a diagnostic failure', async () => {
  await passes(`test('failed catch',async($,on)=>{
    let bottom=0;
    on('env.get',{name:'failed'},()=>{throw new Error('original hook')}).catch(()=>{throw new Error('failed handler')});
    on('env.get',{},()=>{bottom++;return {value:'fallback'}});
    expect(await $.env.get({name:'failed'})).toEqual({value:'fallback'});expect(bottom).toBe(1);
  });`)
}, 20000)
test('an intentionally asserted engine rejection leaves an otherwise fulfilled author case successful', async () => {
  await passes(`test('expected rejection',async($,on)=>{
    on('env.get',()=>{throw new Error('reported hook')});
    await expect($.env.get({name:'probe'})).rejects.toThrow('Unhandled plugin test event');
  });`)
}, 20000)
test('an actual timed out host hook enters the catch grace with timeout metadata', async () => {
  await passes(`test('timeout recovery',{timeoutMs:13000},async($,on)=>{
    on('env.get',()=>new Promise(()=>{})).catch((_$,e,next)=>{
      expect(next.error).toEqual({kind:'timeout',budget:1000});expect(next.called).toBe(false);return {value:'timed recovery'};
    });
    expect(await $.env.get({name:'timeout'})).toEqual({value:'timed recovery'});
  });`)
}, 20000)

test('stream catch undefined resumes the real lower generator instead of synthesizing an empty completion', async () => {
  await passes(`test('stream absent catch',async($,on)=>{
    let bottom=0;
    on('turn.step',{turnId:'turn'},async function*(){throw new Error('failed source')}).catch(async function*(){yield {kind:'text',index:0,text:'caught'};return undefined});
    on('turn.step',{},async function*(){bottom++;yield {kind:'text',index:0,text:'below'};return {turnId:'turn',index:0,answer:'lower result',toolUses:[],stopReason:'end_turn',usage:null}});
    const stream=$.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
    expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'caught'}});
    expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'below'}});
    expect((await stream.next()).value.answer).toBe('lower result');expect(bottom).toBe(1);
  });`)
}, 20000)
test('kit held wrapping lets a synchronous generator reach result validation and recover through its actual catch', async () => {
  await passes(`test('held synchronous generator',async($,on)=>{
    on('env.get',function*(){return {value:'unusable iterator'}}).catch((_$,e,next)=>{
      expect(next.error.kind).toBe('throw');expect(next.called).toBe(false);return {value:'validated failure'};
    });
    expect(await $.env.get({name:'probe'})).toEqual({value:'validated failure'});
  });`)
}, 20000)

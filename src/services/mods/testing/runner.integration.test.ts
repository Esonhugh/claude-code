import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HOOK_EVENTS } from '../../../entrypoints/sdk/coreTypes.js'

const repository = resolve(import.meta.dir, '../../../..')
const runner = join(import.meta.dir, 'runner.ts')

function passed(result: { tests: Array<{ failure?: string }> }): number {
  return result.tests.filter(test => test.failure === undefined).length
}

function failures(result: { file: string; tests: Array<{ name: string; failure?: string }>; loadFailure?: string }) {
  return [
    ...result.tests.flatMap(test => test.failure === undefined ? [] : [{ name: test.name, message: test.failure }]),
    ...(result.loadFailure === undefined ? [] : [{ name: result.file, message: result.loadFailure }]),
  ]
}

async function scenario(source: string, register?: string, manifest: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(repository, '.claude-test-evidence/runner-integration-'))
  await mkdir(join(root, 'hooks'))
  await mkdir(join(root, '.claude-plugin'))
  await mkdir(join(root, 'home'))
  await writeFile(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'runner-probe', version: '1.0.0', ...manifest }))
  await writeFile(join(root, 'hooks/hooks.json'), JSON.stringify({ modules: ['../register.tsx'] }))
  await writeFile(join(root, 'register.tsx'), register ?? `export function register(on) {
    let started;
    on('session.start', async ($, e, next) => { started = await $.clock.now(); return next(e) });
    on('tool.call', {name: 'probe'}, async ($) => {
      const env = await $.env.get('PROBE');
      await $.store.set('key', env);
      return {result: {started, env, stored: await $.store.get('key'), now: await $.clock.now()}};
    });
  }`)
  await writeFile(join(root, 'probe.test.ts'), source)
  const child = Bun.spawn([process.execPath, runner, '--child', root, join(root, 'probe.test.ts')], {
    cwd: repository,
    env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'home/config'), TMPDIR: root },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const watchdog = setTimeout(() => child.kill(), 15000)
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    await writeFile(join(root, 'stdout.log'), stdout)
    await writeFile(join(root, 'stderr.log'), stderr)
    const line = stdout.split('\n').find(line => line.startsWith('__CLAUDE_PLUGIN_TEST_RESULT__'))
    expect(line, stderr || stdout).toBeDefined()
    return { result: JSON.parse(line!.slice('__CLAUDE_PLUGIN_TEST_RESULT__'.length)), status, stderr }
  } finally { clearTimeout(watchdog) }
}

test('normal completion settles fire-and-forget UI invalidation before disposal', async () => {
  const { result, status, stderr } = await scenario(`import {test} from 'claude-code/testing';
    for (let i = 0; i < 8; i++) test('invalidation ' + i, async ($) => {
      const ui = await $.ui.mount({surface:'terminal',component:'AbovePrompt',props:{}});
      await $.command.run({command:'invalidate',args:''});
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => $.ui.resolve(e).Text({children:'ready'}));
      on('command.run', ($) => {
        $.ui.invalidate('ui.render');
        return {text:'done'};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(8)
  expect(status).toBe(0)
  expect(stderr).toBe('')
}, 20000)

test('fire-and-forget invalidation publishes the new drawing after its hook returns', async () => {
  const { result, status, stderr } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('published invalidation', async ($) => {
      const ui = await $.ui.mount({surface:'terminal',component:'AbovePrompt',props:{}});
      expect(await ui.find({text:'before'})).toBeDefined();
      await $.command.run({command:'invalidate',args:''});
      expect(await ui.find({text:'after'})).toBeDefined();
      expect(await ui.find({text:'before'})).toBeUndefined();
      await ui.unmount();
    });`, `export function register(on) {
      let text = 'before';
      on('ui.render', ($, e) => $.ui.resolve(e).Text({children:text}));
      on('command.run', ($) => {
        text = 'after';
        $.ui.invalidate('ui.render');
        return {text:'done'};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
  expect(stderr).toBe('')
})

test('drawn polling allows pending worker capabilities to reach host stubs', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('worker progress', async ($, on) => {
      let reached = false, release;
      let cwdCalls = 0;
      on('session.cwd', () => (++cwdCalls % 8 === 0 ? {deny:'expected refusal'} : {value:'/work'}));
      on('process.run', () => { reached = true; return new Promise(resolve => {release = () => resolve({value:{stdout:'done',stderr:'',exitCode:0}})}) });
      const ui = await $.ui.mount({surface:'terminal',component:'AbovePrompt',props:{}});
      await ui.drawn(); // No pending work must not block.
      for (let round = 0; round < 2; round++) {
        reached = false;
        const pending = $.command.run({command:'probe',args:''});
        await ui.drawn(); // Settle multiple capability round trips, but not the held stub.
        expect(reached).toBe(true);
        await ui.drawn(); // A stable hold must remain observable.
        if (round === 0) await ui.press({key:'cancel'});
        release();
        expect(await pending).toEqual({text:round === 0 ? 'cancelled' : 'done'});
        await ui.drawn();
      }
      await ui.unmount();
    });`, `export function register(on) {
      let cancelled = false;
      on('ui.render', ($, e) => $.ui.resolve(e).Button({key:'cancel', label:'Cancel', onPress:() => {cancelled = true}}));
      on('command.run', async ($) => {
        cancelled = false;
        for (let i = 0; i < 8; i++) {
          try { await $.session.cwd() } catch (error) { if (error.message !== 'expected refusal') throw error }
        }
        const result = await $.process.run(['held']);
        return {text:cancelled ? 'cancelled' : result.stdout};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
})

test('host render stubs resolve component constructors synchronously', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('resolve', async ($, on) => {
      on('ui.render', ($, e) => {
        const components = $.ui.resolve(e);
        expect(typeof components.Box).toBe('function');
        return components.Box({children:components.Text({children:'host drawing'})});
      });
      const ui = await $.ui.mount({surface:'terminal', component:'AbovePrompt', props:{}});
      expect(await ui.find({type:'Text',text:'host drawing'})).toBeDefined();
      await ui.unmount();
    });`, `export function register(on) { on('ui.render', (_$, e, next) => next(e)); }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
})

test('plugin pane capabilities use test stubs without an interactive host', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('placement stubs', async ($, on) => {
      const calls = [];
      on('ui.open', (_$, e) => {calls.push(['open', e.id]); return {value:{isPlaced:false,reason:'too narrow'}}});
      on('ui.close', (_$, e) => {calls.push(['close', e.id]); return {value:undefined}});
      expect(await $.command.run({command:'panel',args:''})).toEqual({text:'too narrow'});
      expect(calls).toEqual([['open','panel'],['close','panel']]);
    });`, `export function register(on) {
      on('command.run', async ($) => {
        const placed = await $.ui.open({id:'panel', title:'Panel'});
        await $.ui.close({id:'panel'});
        return {text:placed.reason};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
})

test('state updates from engine calls settle dependent drawings before find', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('reactive state', async ($, on) => {
      on('turn.complete', () => ({text:''}));
      const ui = await $.ui.mount({surface:'terminal', component:'AbovePrompt', props:{}});
      expect(await ui.find({type:'Text', text:'before'})).toBeDefined();
      await $.turn.complete({reason:'answer', answer:'ok', durationMs:1});
      expect(await ui.find({type:'Text', text:'after'})).toBeDefined();
      await ui.unmount();
    });`, `const ref = {plugin:'runner-probe', key:'label'};
    export function register(on) {
      on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        await $.state.set(ref, 'after');
        return result;
      });
      on('ui.render', {component:'AbovePrompt'}, async ($, e) => {
        const {value = 'before'} = await $.state.get(ref);
        const {Text} = $.ui.resolve(e);
        return Text({children:value});
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
})

test('classic entry stamps defaults, permits overrides and excludes PreToolUse', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('classic envelope', async ($, on) => {
      let session;
      on('session.start', (_$, e) => {session = e; return {cwd:e.cwd}});
      on('classic.SessionStart', (_$, e, next) => {
        expect(next.origin).toEqual({plugin:'engine',tier:'core'});
        expect(e).toEqual({hook_event_name:'SessionStart',session_id:expect.any(String),transcript_path:'',cwd:session.cwd,source:'clear'});
        return {additionalContext:['mock']};
      });
      on('classic.Stop', (_$, e) => {
        expect(e).toEqual({hook_event_name:'Stop',session_id:'override',transcript_path:'transcript',cwd:'/override',stop_hook_active:false});
        return {block:'stop'};
      });
      expect($.classic.PreToolUse).toBeUndefined();
      expect($.classic.UnknownEvent).toBeUndefined();
      for (const event of ${JSON.stringify(HOOK_EVENTS.filter(event => event !== 'PreToolUse'))})
        expect(typeof $.classic[event]).toBe('function');
      expect(await $.classic.SessionStart({source:'clear'})).toEqual({additionalContext:['mock','plugin']});
      expect(await $.classic.Stop({hook_event_name:'forged',session_id:'override',transcript_path:'transcript',cwd:'/override',stop_hook_active:false})).toEqual({block:'stop'});
      expect(await $.classic.SessionEnd({reason:'other'})).toEqual({});
    });`, `export function register(on) {
      on('classic.SessionStart', async (_$, e, next) => {const result = await next(e); return {...result,additionalContext:[...result.additionalContext,'plugin']}});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('classic PreToolUse runs below all plugin tool hooks and denies before test mocks', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('pre chain', {plugins:[{name:'inner',tier:'builtin',register(on) {
      on('tool.call', async ($, e, next) => {await $.env.get('inner'); return next({...e,command:'rewritten'})});
    }}]}, async ($, on) => {
      const order = [];
      on('env.get', (_$, e) => {order.push(e.name); return {value:e.name}});
      on('classic.PreToolUse', (_$, e) => {
        order.push('pre-mock');
        expect(e).toEqual({tool:'Bash',tool_use_id:'call',command:'rewritten'});
        return e.tool_use_id === 'call' ? {deny:'blocked precisely'} : {};
      });
      on('tool.call', () => {order.push('tool-mock'); return {result:'mock'}});
      const result = await $.tool.call({tool:'Bash',tool_use_id:'call',command:'original'});
      expect(result.isError).toBe(true);
      expect(result.text).toBe('blocked precisely');
      expect(result.deny).toBeUndefined();
      expect(order).toEqual(['outer','inner','pre-plugin','pre-mock','outer-return']);
      order.length = 0;
      expect(await $.env.get({name:'nested-deny'})).toEqual({value:'blocked precisely'});
      expect(order).toEqual(['outer','inner','pre-plugin','pre-mock','outer-return']);
    });`, `export function register(on) {
      on('env.get', {name:'nested-deny'}, async $ => {
        const result = await $.tool.call({tool:'Bash',tool_use_id:'call',command:'original'});
        if (result.isError !== true) throw new Error('nested denial was not errored');
        return {value:result.text};
      });
      on('tool.call', async ($, e, next) => {await $.env.get('outer'); const result = await next(e); await $.env.get('outer-return'); return result});
      on('classic.PreToolUse', async ($, e, next) => {await $.env.get('pre-plugin'); return next(e)});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('classic PreToolUse replaces mock arguments while preserving call identity', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('replacement', async ($, on) => {
      on('classic.PreToolUse', () => ({ask:'test does not prompt',updatedInput:{command:'new'},additionalContext:['not forwarded']}));
      on('tool.call', (_$, e) => {
        expect(e).toEqual({tool:'Bash',tool_use_id:'call',command:'new',agentId:'agent'});
        return {result:'mock'};
      });
      expect(await $.tool.call({tool:'Bash',tool_use_id:'call',command:'old',obsolete:true,agentId:'agent'})).toEqual({result:'mock'});
    });`, 'export function register(on) {}')
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('classic updatedInput shadows reserved arguments and accepts an empty replacement', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('reserved', async ($, on) => {
      const rewritten = {tool:'argument-tool',tool_use_id:'argument-id',agentId:'argument-agent',consent:'argument-consent',$shadowed:{nested:true},command:'new'};
      on('classic.PreToolUse', (_$, e) => ({updatedInput:e.tool_use_id === 'empty' ? {} : rewritten}));
      on('tool.call', (_$, e) => {
        if (e.tool_use_id === 'empty') expect(e).toEqual({tool:'Bash',tool_use_id:'empty'});
        else expect(e).toEqual({tool:'Bash',tool_use_id:'call',agentId:'agent',consent:'original',command:'new',$shadowed:{tool:'argument-tool',tool_use_id:'argument-id',agentId:'argument-agent',consent:'argument-consent',$shadowed:{nested:true}}});
        return {result:'mock'};
      });
      await $.tool.call({tool:'Bash',tool_use_id:'call',command:'old',agentId:'agent',consent:'original'});
      await $.tool.call({tool:'Bash',tool_use_id:'empty',command:'old'});
    });`, 'export function register(on) {}')
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('classic PreToolUse allows mocked and nested calls without running real tools', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('allow and empty', async ($, on) => {
      const seen = [];
      on('classic.PreToolUse', {tool:'Bash'}, (_$, e, next) => {
        seen.push(e.command);
        return e.command === 'allowed' ? {allow:true} : next(e);
      });
      on('tool.call', (_$, e) => ({result:e.command}));
      expect(await $.tool.call({tool:'Bash',command:'allowed'})).toEqual({result:'allowed'});
      expect(await $.tool.call({tool:'Bash',command:'empty'})).toEqual({result:'empty'});
      expect(await $.env.get({name:'nested'})).toEqual({value:'nested'});
      expect(await $.tool.call({tool:'intercepted'})).toEqual({result:'short circuit'});
      expect(seen).toEqual(['allowed','empty','nested']);
    });`, `export function register(on) {
      on('env.get', {name:'nested'}, async $ => ({value:(await $.tool.call({tool:'Bash',command:'nested'})).result}));
      on('tool.call', {tool:'intercepted'}, () => ({result:'short circuit'}));
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('real runtime intercepts nested capabilities and startup after synchronous registration', async () => {
  const { result, status } = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('nested', {timeoutMs: 3000}, async ($, on) => {
      mock.env(on, {PROBE: 'mocked'}); mock.store(on); mock.clock(on, {now: 123});
      let starts = 0;
      on('session.start', async ($, e) => { starts++; expect(await $.clock.now()).toBe(123); return {cwd: e.cwd} });
      const response = await $.tool.call({name: 'probe'});
      expect(response.result).toEqual({started: 123, env: 'mocked', stored: 'mocked', now: 123});
      expect(starts).toBe(1);
    });`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

test('on callbacks use plugin positional arguments and unwrapped results', async () => {
  const {result} = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('hook facade', async ($, on) => {
      mock.store(on);
      on('env.get', async ($, e) => {
        await $.store.set('key', e.name);
        return {value: await $.store.get('key')};
      });
      expect(await $.env.get({name:'PROBE'})).toEqual({value:'PROBE'});
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('core hooks preserve matchers, wildcard events, next metadata and continuation', async () => {
  const { result } = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('hooks', async ($, on) => {
      mock.env(on, {PROBE: 'mocked'}); mock.store(on);
      on('clock.*', {unused: true}, () => {throw new Error('matcher should exclude this')});
      const events = [];
      on('clock.*', async (_$, e, next) => {
        events.push(next.event);
        expect(next.origin.plugin).toBe('runner-probe');
        expect(next.signal.aborted).toBe(false);
        return next(e);
      });
      on('clock.now', () => ({value: 456}));
      const response = await $.tool.call({name: 'probe'});
      expect(response.result.started).toBe(456);
      expect(response.result.now).toBe(456);
      expect(events).toEqual(['clock.now', 'clock.now']);
    });`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('on rejects registration after an await or the first engine call', async () => {
  for (const body of [
    `await Promise.resolve(); on('clock.now', () => ({value: 1}))`,
    `const pending = $.session.usage(); on('clock.now', () => ({value: 1})); await pending`,
  ]) {
    const { result } = await scenario(`import {test} from 'claude-code/testing'; test('late', async ($, on) => {${body}})`)
    expect(passed(result)).toBe(0)
    expect(failures(result).some((failure: {message: string}) => failure.message.includes('on() must be called synchronously'))).toBe(true)
  }
}, 20000)

test('test exit fences unawaited initialization and attributes its rejection before the next test', async () => {
  const {result, status, stderr} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('late', async ($, on) => {
      const pending = $.session.usage();
      on('clock.now', () => ({value:1}));
      await pending;
    });
    test('next', async ($, on) => {
      on('env.get', () => ({value:'next'}));
      expect(await $.env.get({name:'next'})).toEqual({value:'next'});
    });`, 'export function register(on) {}')
  expect(status).toBe(1)
  expect(stderr).toBe('')
  expect(passed(result)).toBe(1)
  expect(failures(result).every((entry: {name:string}) => entry.name === 'late')).toBe(true)
  expect(failures(result).some((entry: {message:string}) => entry.message.includes('on() must be called synchronously'))).toBe(true)
}, 20000)

test('test exit cancels a held host operation without waiting forever or failing the next test', async () => {
  const {result, status, stderr} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('held', {timeoutMs:1000}, async ($, on) => {
      let reached;
      const entered = new Promise(resolve => {reached = resolve});
      on('env.get', () => {reached(); return new Promise(() => {})});
      $.env.get({name:'held'});
      await entered;
      throw new Error('body-failed-with-held-operation');
    });
    test('next', async ($, on) => {
      on('env.get', () => ({value:'next'}));
      expect(await $.env.get({name:'next'})).toEqual({value:'next'});
    });`, 'export function register(on) {}')
  expect(status).toBe(1)
  expect(stderr).toBe('')
  expect(passed(result)).toBe(1)
  expect(failures(result).every((entry: {name:string}) => entry.name === 'held')).toBe(true)
  expect(failures(result).some((entry: {message:string}) => entry.message.includes('body-failed-with-held-operation'))).toBe(true)
}, 20000)

test('test VM links the actual state library', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    import {atom, memberOf} from 'claude-code';
    test('state', () => {const a = atom({plugin:'probe',key:'value'}, 1); expect(memberOf(a, {requestId:'request'}).ref.id).toBe('request')});`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('inline plugins load in their own realm and options use manifest defaults and validation', async () => {
  const { result } = await scenario(`import {test, expect} from 'claude-code/testing';
    test('options', {options: {greeting: 'hi', ignored: true}, plugins: [{name: 'inline', tier: 'append', register(on) {
      on('env.get', {name: 'INLINE'}, () => ({value: 'inline'}));
    }}]}, async ($, on) => {
      expect(await $.env.get({name: 'GREETING'})).toEqual({value: 'hi!'});
      expect(await $.env.get({name: 'INLINE'})).toEqual({value: 'inline'});
    });
    test('defaults', async $ => expect(await $.env.get({name:'GREETING'})).toEqual({value:'hello!'}));`,
    `export function register(on, options) {
      if ('ignored' in options) throw new Error('unlisted option leaked');
      on('env.get', {name:'GREETING'}, () => ({value: options.greeting + options.suffix}));
    }`, {userConfig: {
      greeting: {type:'string', title:'Greeting', description:'Greeting', default:'hello'},
      suffix: {type:'string', title:'Suffix', description:'Suffix', default:'!'},
    }})
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(2)
  const invalid = await scenario(`import {test} from 'claude-code/testing'; test('required', async $ => {await $.env.get({name:'X'})});`,
    `export function register(on) {}`, {userConfig:{required:{type:'string',title:'Required',description:'Required',required:true}}})
  expect(passed(invalid.result)).toBe(0)
  expect(failures(invalid.result)[0].message).toContain('required')
}, 20000)

test('unhandled engine events throw naming their event', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('bottom', async $ => {await expect($.env.get({name:'MISSING'})).rejects.toThrow('env.get')});`,
    `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('official unmodified turn-band mounts and Hide updates through real state and clock hooks', async () => {
  const source = await readFile(join(import.meta.dir, '../fixtures/official287-turn-band.tsx.fixture'), 'utf8')
  const {result} = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('turn-band', async ($, on) => {
      const clock = mock.clock(on, {now:1000});
      on('prompt.submit', (_$, e) => e);
      on('turn.complete', () => ({text:'done'}));
      on('ui.render', () => ({type:'Box',props:{},children:[]}));
      expect(await $.clock.now({})).toEqual({value:1000});
      await $.prompt.submit({text:'hello'});
      await clock.advance(4000);
      await $.turn.complete({});
      const ui = await $.ui.mount({surface:'terminal',component:'AbovePrompt',props:{hasSurvey:false}});
      expect((await ui.drawn()).children[0].children.join('')).toBe('Last turn: 4s, 0 tool calls ');
      expect((await ui.find({key:'hide'})).props.label).toBe('Hide');
      await ui.press({key:'hide'});
      expect(JSON.stringify(await ui.drawn())).not.toContain('Last turn:');
      await ui.unmount();
    });`, source, {name:'turn-band'})
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted input dispatches full rewritten envelopes without inventing redraws', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('input', async ($, on) => {
      const received = [];
      on('tool.call', (_$, e) => {received.push(e.input); return {result:''}});
      on('ui.input', (_$, e, next) => {
        expect(e).toEqual({surface:'terminal',component:'AbovePrompt',requestId:'form',plugin:'runner-probe',element:'title',value:'raw',kind:received.length ? 'change' : 'submit'});
        return next({...e,value:'rewritten'});
      });
      const ui = await $.ui.mount({plugin:'runner-probe',surface:'terminal',component:'AbovePrompt',requestId:'form',props:{}});
      expect(await ui.input({key:'title',text:'raw'})).toEqual({element:'title',value:'rewritten'});
      expect(await ui.input({key:'title',text:'raw',kind:'change'})).toEqual({element:'title',value:'rewritten'});
      expect(received).toEqual(['submit','change'].map(kind => ({value:'rewritten',event:{surface:'terminal',component:'AbovePrompt',requestId:'form',plugin:'runner-probe',element:'title',value:'rewritten',kind}})));
      expect((await ui.find({type:'Text'})).text).toBe('1');
      await ui.unmount();
    });`, `export function register(on) {
      let renders = 0;
      on('ui.render', ($, e) => {
        const {Box,Text,Input} = $.ui.resolve(e);
        const report = (value,event) => $.tool.call({tool:'report',input:{value,event}});
        return Box({children:[Text({children:String(++renders)}),Input({key:'title',value:'',onInput:report,onSubmit:report})]});
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted select rewrites values and waits for real invalidation', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('select', async ($, on) => {
      const received = [];
      on('tool.call', (_$, e) => {received.push(e.input); return {result:''}});
      on('ui.select', (_$, e, next) => {
        expect(e).toEqual({surface:'terminal',component:'AbovePrompt',requestId:'pick',plugin:'runner-probe',element:'sort',value:'date'});
        return next({...e,value:'name'});
      });
      const ui = await $.ui.mount({plugin:'runner-probe',surface:'terminal',component:'AbovePrompt',requestId:'pick',props:{}});
      expect(await ui.select({key:'sort',value:'date'})).toEqual({element:'sort',value:'name'});
      expect(received).toEqual([{value:'name',event:{surface:'terminal',component:'AbovePrompt',requestId:'pick',plugin:'runner-probe',element:'sort',value:'name'}}]);
      expect((await ui.find({type:'Text'})).text).toBe('1:initial');
      await ui.press({key:'refresh'});
      expect((await ui.find({type:'Text'})).text).toBe('2:name');
      await ui.unmount();
    });`, `export function register(on) {
      let renders = 0, selected = 'initial';
      on('ui.render', ($, e) => {
        const {Box,Text,Select,Button} = $.ui.resolve(e);
        return Box({children:[Text({children:String(++renders)+':'+selected}),
          Select({key:'sort',options:[{label:'Date',value:'date'},{label:'Name',value:'name'}],onSelect:async (value,event) => {
            selected = value; await $.tool.call({tool:'report',input:{value,event}});
          }}),Button({key:'refresh',label:'Refresh',onPress:async () => {await $.ui.invalidate('ui.render')}})]});
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted acts respect default plugin, element types and Markdown links', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('targets', {plugins:[{name:'other',tier:'prepend',register(on) {
      on('ui.render', async ($, e, next) => {
        const {Box,Button,Input,Select} = $.ui.resolve(e);
        const report = () => $.tool.call({tool:'report',input:'other'});
        return Box({children:[Button({key:'shared',label:'Other',onPress:report}),Input({key:'title',onSubmit:report}),Select({key:'sort',options:[{label:'X',value:'x'}],onSelect:report}),await next(e)]});
      });
    }}]}, async ($, on) => {
      const received = [];
      on('tool.call', (_$, e) => {received.push(e.input); return {result:''}});
      on('ui.press', (_$, e, next) => {
        if (e.link) {
          expect(e).toEqual({surface:'terminal',component:'AbovePrompt',requestId:'links',plugin:'runner-probe',element:'docs',link:{href:'https://example.com'}});
          return next({...e,link:{href:'https://rewritten.example'}});
        }
        return next(e);
      });
      const ui = await $.ui.mount({plugin:'runner-probe',surface:'terminal',component:'AbovePrompt',requestId:'links',props:{}});
      await ui.press({key:'shared'});
      await ui.input({key:'title',text:'text'});
      await ui.select({key:'sort',value:'x'});
      await ui.press({key:'shared',plugin:'other'});
      await ui.input({key:'title',text:'text',plugin:'other'});
      await ui.select({key:'sort',value:'x',plugin:'other'});
      expect(await ui.press({key:'docs',link:{href:'https://example.com'}})).toEqual({element:'docs'});
      expect(received).toEqual(['own','own','own','other','other','other',{href:'https://rewritten.example'}]);
      expect((await ui.find({type:'Text'})).text).toBe('1');
      for (const action of [() => ui.press({key:'title'}),() => ui.input({key:'shared',text:'x'}),() => ui.select({key:'title',value:'x'}),() => ui.press({key:'shared',plugin:'missing'}),() => ui.press({key:'shared',link:{href:'x'}})]) await expect(action()).rejects.toThrow('not found');
      await expect(ui.input({key:'title',text:'x',kind:'bad'})).rejects.toThrow('kind');
      await expect(ui.input({key:'title',text:1})).rejects.toThrow('string');
      await expect(ui.select({key:'sort',value:1})).rejects.toThrow('string');
      await ui.unmount();
      await expect(ui.press({key:'shared'})).rejects.toThrow('unmounted');
      await expect(ui.input({key:'title',text:'x'})).rejects.toThrow('unmounted');
      await expect(ui.select({key:'sort',value:'x'})).rejects.toThrow('unmounted');
      await ui.unmount();
    });`, `export function register(on) {
      let renders = 0;
      on('ui.render', ($, e) => {
        const {Box,Text,Button,Input,Select,Markdown} = $.ui.resolve(e);
        const report = () => $.tool.call({tool:'report',input:'own'});
        return Box({children:[Text({children:String(++renders)}),Button({key:'shared',label:'Own',onPress:report}),Input({key:'title',onSubmit:report}),Select({key:'sort',options:[{label:'X',value:'x'}],onSelect:report}),Markdown({key:'docs',text:'[Docs](https://example.com)',onLinkPress:link => $.tool.call({tool:'report',input:link})})]});
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted Client exposes its first frame, local actions and retained state across props updates', async () => {
  const {result, status} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('client lifecycle', async $ => {
      const ui = await $.ui.mount({surface:'terminal',component:'AbovePrompt',props:{label:'first'}});
      expect((await ui.drawn()).type).toBe('Client');
      expect((await ui.drawn({in:'counter'})).type).toBe('Box');
      const copy = await ui.drawn({in:'counter'});
      copy.children[0].children[0] = 'mutated';
      expect((await ui.find({in:'counter',type:'Text'})).text).toBe('first:0');
      expect(await ui.find({type:'Text'})).toBeUndefined();
      await ui.press({key:'increment'});
      expect((await ui.find({in:'counter',type:'Text'})).text).toBe('first:1');
      await ui.input({key:'edit',text:'7',kind:'change'});
      expect((await ui.find({in:'counter',type:'Text'})).text).toBe('first:7');
      await ui.select({key:'pick',value:'9'});
      expect((await ui.find({in:'counter',type:'Text'})).text).toBe('first:9');
      await ui.redraw({label:'second'});
      await ui.redraw({label:'second'});
      expect((await ui.findAll({in:'counter',type:'Text'})).map(e => e.text)).toEqual(['second:9']);
      await expect(ui.drawn({in:'missing'})).rejects.toThrow('not found');
      await ui.unmount();
      await expect(ui.drawn({in:'counter'})).rejects.toThrow('unmounted');
      await expect(ui.press({key:'increment'})).rejects.toThrow('unmounted');
    });`, `export function register(on) {
      on('ui.render', ($, e) => $.ui.resolve(e).Client({key:'counter',module:'./register.tsx',props:e.props}));
    }
    export default function Counter(props, s) {
      const {Box,Text,Button,Input,Select} = s.elements;
      return Box({children:[Text({children:props.label+':'+(s.state ?? 0)}),
        Button({key:'increment',label:'Increment',onPress:() => s.setState((s.state ?? 0)+1)}),
        Input({key:'edit',value:'',onInput:value => s.setState(Number(value)),onSubmit:value => s.setState(Number(value))}),
        Select({key:'pick',options:[{label:'Nine',value:'9'}],onSelect:value => s.setState(Number(value))})]});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

test('mounted Client callbacks stay distinct from outer drawing handles and other Clients', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('callback ownership', async ($, on) => {
      const calls = [];
      on('tool.call', (_$, e) => {calls.push(e.input); return {result:''}});
      const ui = await $.ui.mount('AbovePrompt');
      await ui.press({key:'outer'});
      await ui.press({key:'left'});
      expect(calls).toEqual(['outer']);
      expect((await ui.find({in:'left',type:'Button'})).props.label).toBe('left:1');
      expect((await ui.find({in:'right',type:'Button'})).props.label).toBe('right:0');
      await ui.press({key:'right'});
      expect((await ui.find({in:'right',type:'Button'})).props.label).toBe('right:1');
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => {
        const {Box,Button,Client} = $.ui.resolve(e);
        return Box({children:[Button({key:'outer',label:'Outer',onPress:() => $.tool.call({tool:'report',input:'outer'})}),
          ...['left','right'].map(key => Client({key,module:'./register.tsx',props:{key}}))]});
      });
    }
    export default function Counter(props, s) {
      return s.elements.Button({key:props.key,label:props.key+':'+(s.state ?? 0),onPress:() => s.setState((s.state ?? 0)+1)});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

const controlledClient = `import {atom,read,update} from 'claude-code';
const messages = atom({plugin:'runner-probe',key:'messages'}, 0);
export function register(on) {
  const labels = {};
  on('ui.render', async ($, e) => {
    const count = await read($, messages);
    const {Box,Client,Text} = $.ui.resolve(e);
    return Box({children:[Text({children:'messages:'+count}),...(e.props.keys ?? ['left']).map(key =>
      Client({key,module:'./register.tsx',props:{label:labels[key] ?? key}}))]});
  });
  on('ui.message', async ($, e) => {
    labels[e.element] = e.data.label;
    await update($, messages, count => count + 1);
    return {props:{label:e.data.label}};
  });
}
export default function Controlled(props, s) {
  if (s.state === undefined) {
    s.setState({keys:[],pointers:[],ticks:[]});
    s.every(10, () => s.setState({...s.state,ticks:[...s.state.ticks,'ten']}));
    s.every(15, () => s.setState({...s.state,ticks:[...s.state.ticks,'fifteen']}));
  }
  s.onKey(event => { if (event.key === 'fail') throw new Error('key-control-failed'); s.setState({...s.state,keys:[...s.state.keys,event]}) });
  s.onPointer(event => s.setState({...s.state,pointers:[...s.state.pointers,event]}));
  return s.elements.Text({children:JSON.stringify({label:props.label,...s.state,columns:s.columns,rows:s.rows})});
}`

test('mounted controls use real Client events, dimensions, posts and every deadlines', async () => {
  const {result, status} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('controls', async $ => {
      const ui = await $.ui.mount('AbovePrompt');
      const read = async () => JSON.parse((await ui.find({in:'left',type:'Text'})).text);
      await ui.key({key:'k',ctrl:true,shift:true,meta:true});
      expect((await read()).keys).toEqual([{key:'k',ctrl:true,shift:true,meta:true}]);
      await ui.pointer({type:'down',x:2,y:3,fine:{x:0.5,y:0.25},button:'left',alt:true});
      expect((await read()).pointers).toEqual([{type:'down',x:2,y:3,fine:{x:0.5,y:0.25},button:'left',alt:true}]);
      await ui.resize({columns:80,rows:24});
      expect((await read()).columns).toBe(80);
      expect((await read()).rows).toBe(24);
      await ui.advance(35);
      expect((await read()).ticks).toEqual(['ten','fifteen','ten','ten','fifteen']);
      await ui.advance(5);
      expect((await read()).ticks).toEqual(['ten','fifteen','ten','ten','fifteen','ten']);
      await ui.post({label:'reply'});
      expect((await read()).label).toBe('reply');
      expect((await ui.find({type:'Text'})).text).toBe('messages:1');
      expect((await ui.drawn()).type).toBe('Box');
      await ui.unmount();
      for (const act of [() => ui.key({key:'k'}),() => ui.pointer({type:'move',x:0,y:0}),
        () => ui.resize({columns:1,rows:1}),() => ui.post({}),() => ui.advance(1)])
        await expect(act()).rejects.toThrow('unmounted');
    });`, controlledClient)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

test('mounted controls scope multiple Clients and reject ambiguous or missing targets', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('scopes', async $ => {
      const ui = await $.ui.mount('AbovePrompt', {keys:['left','right']});
      const read = async key => JSON.parse((await ui.find({in:key,type:'Text'})).text);
      for (const scope of [undefined,'missing']) {
        const message = scope === undefined ? 'ambiguous' : 'not mounted';
        for (const act of [() => ui.key({key:'k',in:scope}),() => ui.pointer({type:'move',x:0,y:0,in:scope}),
          () => ui.resize({columns:1,rows:1,in:scope}),() => ui.post({}, {in:scope})])
          await expect(act()).rejects.toThrow(message);
      }
      await ui.key({key:'r',in:'right'});
      await ui.pointer({type:'up',x:4,y:5,in:'right'});
      await ui.resize({columns:40,rows:12,in:'right'});
      await ui.post({label:'right reply'}, {in:'right'});
      expect((await read('left')).keys).toEqual([]);
      expect((await read('left')).pointers).toEqual([]);
      expect((await read('left')).columns).toBe(0);
      expect((await read('left')).label).toBe('left');
      expect((await read('right')).keys).toEqual([{key:'r'}]);
      expect((await read('right')).pointers).toEqual([{type:'up',x:4,y:5}]);
      expect((await read('right')).columns).toBe(40);
      expect((await read('right')).label).toBe('right reply');
      await expect(ui.advance(-1)).rejects.toThrow('Invalid');
      await ui.advance(30);
      for (const key of ['left','right']) expect((await read(key)).ticks).toEqual(['ten','fifteen','ten','ten','fifteen']);
      await ui.redraw({keys:['left']});
      await expect(ui.key({key:'r',in:'right'})).rejects.toThrow('not mounted');
      await ui.unmount();
    });`, controlledClient)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted controls propagate Client callback errors', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('error', async $ => {
      const ui = await $.ui.mount('AbovePrompt');
      await expect(ui.key({key:'fail'})).rejects.toThrow('key-control-failed');
      await ui.unmount();
    });`, controlledClient)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted Client local post waits for its ui.message props reply', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('client post', async $ => {
      const ui = await $.ui.mount('AbovePrompt');
      await ui.press({key:'send'});
      expect((await ui.find({in:'sender',type:'Button'})).props.label).toBe('replied');
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => $.ui.resolve(e).Client({key:'sender',module:'./register.tsx',props:{label:'initial'}}));
      on('ui.message', (_$, e) => {
        if (e.component !== 'AbovePrompt' || e.surface !== 'terminal') throw new Error('wrong message site');
        return {props:{label:e.data}};
      });
    }
    export default function Sender(props, s) {
      return s.elements.Button({key:'send',label:props.label,onPress:() => s.post('replied')});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted Client removal disposes its state before the same key returns', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('replacement', async $ => {
      const ui = await $.ui.mount('AbovePrompt', {show:true});
      await ui.press({key:'increment'});
      expect((await ui.find({in:'counter',type:'Button'})).props.label).toBe('1');
      await ui.redraw({show:false});
      await expect(ui.find({in:'counter'})).rejects.toThrow('not found');
      await expect(ui.press({key:'increment'})).rejects.toThrow('not found');
      await ui.redraw({show:true});
      expect((await ui.find({in:'counter',type:'Button'})).props.label).toBe('0');
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => {
        const {Box,Client} = $.ui.resolve(e);
        return e.props.show ? Client({key:'counter',module:'./register.tsx'}) : Box({children:[]});
      });
    }
    export default function Counter(_props, s) {
      return s.elements.Button({key:'increment',label:String(s.state ?? 0),onPress:() => s.setState((s.state ?? 0)+1)});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted Client faults are reported rather than exposing an inert Client placeholder', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('client fault', async $ => {
      await expect($.ui.mount('AbovePrompt')).rejects.toThrow('client-first-frame-failed');
    });`, `export function register(on) {
      on('ui.render', ($, e) => $.ui.resolve(e).Client({key:'broken',module:'./register.tsx'}));
    }
    export default function Broken() { throw new Error('client-first-frame-failed'); }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted redraw of identical props resolves without waiting for a nonexistent drawing', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('unchanged props', {timeoutMs:500}, async $ => {
      const ui = await $.ui.mount('AbovePrompt', {label:'same'});
      await ui.redraw({label:'same'});
      expect((await ui.find({type:'Text'})).text).toBe('same');
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => $.ui.resolve(e).Text({children:e.props.label}));
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted UI rejects redraw after unmount without leaving a pending draw', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('disposed', {timeoutMs:200}, async ($, on) => {
      on('ui.render', () => ({type:'Text', props:{}, children:['ready']}));
      const ui = await $.ui.mount('AbovePrompt');
      await ui.unmount();
      await expect(ui.redraw()).rejects.toThrow('unmounted');
      await expect(ui.drawn()).rejects.toThrow('unmounted');
      await expect(ui.find({type:'Text'})).rejects.toThrow('unmounted');
      await expect(ui.findAll({})).rejects.toThrow('unmounted');
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('inline plugins cannot capture test locals and invalid tiers are rejected', async () => {
  const closure = await scenario(`import {test} from 'claude-code/testing';
    const secret = 'outside';
    test('closure', {plugins:[{name:'inline', register(on) {on('env.get', () => ({value:secret}))}}]},
      async $ => {await $.env.get({name:'X'})});`, `export function register(on) {}`)
  expect(passed(closure.result)).toBe(0)
  expect(failures(closure.result).some((entry: {message:string}) => entry.message.includes('secret'))).toBe(true)
  const tier = await scenario(`import {test} from 'claude-code/testing';
    test('tier', {plugins:[{name:'inline',tier:'core',register(on){}}]}, () => {});`, `export function register(on) {}`)
  expect(passed(tier.result)).toBe(0)
  expect(failures(tier.result)[0].message).toContain('non-core tier')
}, 20000)

test.each([false, true])('nested unhandled capability fails instead of invoking production core: continuation=%s', async continuation => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('nested bottom', async ($, on) => {
      ${continuation ? `on('clock.now', (_$, e, next) => next(e));` : ''}
      await $.tool.call({name:'probe'});
    });`, `export function register(on) {
      on('tool.call', {name:'probe'}, async $ => ({result: await $.clock.now()}));
    }`)
  expect(passed(result)).toBe(0)
  expect(failures(result).some((entry: {message:string}) => entry.message.includes('Unhandled plugin test event: clock.now'))).toBe(true)
}, 20000)

test('nested mocked capabilities do not require production services', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('usage', async ($, on) => {
      on('session.usage', () => ({value:{context:{window:123},rateLimits:[]}}));
      expect(await $.tool.call({name:'probe'})).toEqual({result:{context:{window:123},rateLimits:[]}});
    });`, `export function register(on) {
      on('tool.call', {name:'probe'}, async $ => ({result: await $.session.usage()}));
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('engine calls preserve event envelopes and identify the engine as origin', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('engine', async ($, on) => {
      on('env.get', (_$, e, next) => {
        expect(e).toEqual({name:'PROBE'});
        expect(next.origin).toEqual({plugin:'engine',tier:'core'});
        return {value:'answer'};
      });
      expect(await $.env.get({name:'PROBE'})).toEqual({value:'answer'});
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing turn.step streams in pull order and preserves its result and engine origin', async () => {
  const {result, status} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('stream', async ($, on) => {
      const seen = [];
      on('env.get', (_$, e) => {seen.push(e.name); return {value:e.name}});
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect(stream.then).toBeUndefined();
      expect(stream[Symbol.asyncIterator]()).toBe(stream);
      let settled = false;
      stream.result.then(() => {settled = true});
      expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'first'}});
      expect(seen).toEqual(['engine:core']);
      expect(settled).toBe(false);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).toEqual([{kind:'text',index:0,text:'second'}]);
      expect(seen).toEqual(['engine:core','after-first']);
      expect(await stream.result).toEqual({turnId:'turn',index:0,answer:'final',toolUses:[],stopReason:'end_turn',usage:null});
      expect(await $.env.get({name:'envelope'})).toEqual({value:'envelope'});
    });`, `export function register(on) {
      on('turn.step', async function* ($, e, next) {
        if (next.origin.plugin !== 'engine' || next.origin.tier !== 'core') throw new Error('wrong origin');
        await $.env.get('engine:core');
        yield {kind:'text',index:0,text:'first'};
        await $.env.get('after-first');
        yield {kind:'text',index:0,text:'second'};
        return {turnId:e.turnId,index:e.index,answer:'final',toolUses:[],stopReason:'end_turn',usage:null};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

test('testing on turn.step streams lazily through next with host callback capabilities', async () => {
  const {result, status} = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('host stream', async ($, on) => {
      const seen = [];
      let saved, signal;
      mock.clock(on, {now:123});
      on('turn.step', {model:'fake'}, async function* (engine, e, next) {
        saved = engine; signal = next.signal;
        expect(next.origin).toEqual({plugin:'engine',tier:'core'});
        expect(next.event).toBe('turn.step');
        expect(signal.aborted).toBe(false);
        expect(await engine.clock.now()).toBe(123);
        expect(engine.plugin.name).toBe('claude-code/testing');
        expect(await engine.state.set({plugin:'claude-code/testing',key:'stream'}, 7)).toEqual({isSet:true,version:1});
        seen.push('first');
        yield {kind:'text',index:0,text:'first'};
        expect(await engine.clock.now()).toBe(123);
        expect(await engine.state.get({plugin:'claude-code/testing',key:'stream'})).toEqual({value:7,version:1});
        return yield* next({...e, model:'forwarded'});
      });
      on('turn.step', {model:'forwarded'}, async function* (engine, e) {
        seen.push(e.model);
        expect(await engine.clock.now()).toBe(123);
        yield {kind:'text',index:0,text:'second'};
        return {turnId:e.turnId,index:e.index,answer:'final',toolUses:[],stopReason:'end_turn',usage:null};
      });
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect(stream.then).toBeUndefined();
      expect(seen).toEqual([]);
      expect((await stream.next()).value.text).toBe('first');
      expect(seen).toEqual(['first']);
      expect((await stream.next()).value.text).toBe('second');
      expect(seen).toEqual(['first','forwarded']);
      expect((await stream.next()).done).toBe(true);
      expect((await stream.result).answer).toBe('final');
      await expect(saved.clock.now()).rejects.toThrow('Host callback invocation ended');
      await expect(saved.state.get({plugin:'claude-code/testing',key:'stream'})).rejects.toThrow('Host callback invocation ended');
      expect(await $.clock.now({})).toEqual({value:123});
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

test.each(['error', 'return', 'break'])('testing on turn.step closes callback scope on %s', async mode => {
  const {result} = await scenario(`import {test, expect, mock} from 'claude-code/testing';
    test('close', async ($, on) => {
      let saved, signal, finalized = false, overpulled = false;
      mock.clock(on, {now:7});
      on('turn.step', async function* (engine, e, next) {
        saved = engine; signal = next.signal;
        try {
          expect(await engine.clock.now()).toBe(7);
          yield {kind:'text',index:0,text:'first'};
          ${mode === 'error' ? `throw new Error('mock-stream-error');` : `overpulled = true; yield {kind:'text',index:0,text:'unexpected'};`}
        } finally { finalized = true; }
      });
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      ${mode === 'break' ? `for await (const chunk of stream) {expect(chunk.text).toBe('first'); break}` : `expect((await stream.next()).value.text).toBe('first');`}
      ${mode === 'error' ? `await expect(stream.next()).rejects.toThrow('Unhandled plugin test event: turn.step');
      await expect(stream.result).rejects.toThrow('Unhandled plugin test event: turn.step');` : `expect((await stream.return(undefined)).done).toBe(true);
      await expect(stream.result).rejects.toThrow('closed');
      expect(signal.aborted).toBe(true);`}
      expect(finalized).toBe(true);
      expect(overpulled).toBe(false);
      await expect(saved.clock.now()).rejects.toThrow('Host callback invocation ended');
      await expect(saved.state.get({plugin:'claude-code/testing',key:'stream'})).rejects.toThrow('Host callback invocation ended');
    });`, `export function register(on) {}`)
  if (mode === 'error') {
    expect(failures(result)).toEqual([{name:'close', message:'claude-code/testing turn.step: mock-stream-error'}])
    expect(passed(result)).toBe(0)
  } else {
    expect(failures(result)).toEqual([])
    expect(passed(result)).toBe(1)
  }
}, 20000)

test('testing on turn.step forwards consumer throw into the mock generator', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('throw into mock', async ($, on) => {
      const injected = new Error('consumer-stop');
      on('turn.step', async function* (_$, e) {
        try { yield {kind:'text',index:0,text:'first'} }
        catch (error) { expect(error).toBe(injected); yield {kind:'text',index:0,text:'recovered'} }
        return {turnId:e.turnId,index:e.index,answer:'done',toolUses:[],stopReason:'end_turn',usage:null};
      });
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect((await stream.next()).value.text).toBe('first');
      expect((await stream.throw(injected)).value.text).toBe('recovered');
      expect((await stream.next()).done).toBe(true);
      expect((await stream.result).answer).toBe('done');
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing on turn.step returns before the first pull without entering the mock', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('unstarted mock', async ($, on) => {
      let entered = false;
      on('turn.step', async function* () {entered = true; yield {kind:'text',index:0,text:'unexpected'}});
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect((await stream.return(undefined)).done).toBe(true);
      await expect(stream.result).rejects.toThrow('closed');
      expect((await stream.next()).done).toBe(true);
      expect(entered).toBe(false);
    });`, `export function register(on) {}`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing turn.step rejects pulls and result at the unhandled terminal', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('terminal', async $ => {
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect(await stream.next()).toEqual({done:false,value:{kind:'text',index:0,text:'before-error'}});
      await expect(stream.next()).rejects.toThrow('Unhandled plugin test event: turn.step');
      await expect(stream.result).rejects.toThrow('Unhandled plugin test event: turn.step');
    });`, `export function register(on) {
      on('turn.step', async function* ($, e, next) {
        yield {kind:'text',index:0,text:'before-error'};
        return yield* next(e);
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test.each(['return', 'break'])('testing turn.step forwards %s and cancels without over-pulling', async method => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('cancel', async ($, on) => {
      const seen = [];
      on('env.get', (_$, e) => {seen.push(e.name); return {value:e.name}});
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      ${method === 'break' ? `for await (const chunk of stream) {expect(chunk.text).toBe('first'); break}` : `
      expect((await stream.next()).value.text).toBe('first');
      expect((await stream.return(undefined)).done).toBe(true);`}
      await expect(stream.result).rejects.toThrow('closed');
      expect((await stream.next()).done).toBe(true);
      expect(seen).toEqual([]);
      expect(await $.env.get({name:'signal'})).toEqual({value:'aborted'});
    });`, `export function register(on) {
      let signal;
      on('env.get', {name:'signal'}, () => ({value:signal.aborted ? 'aborted' : 'active'}));
      on('turn.step', async function* ($, e, next) {
        signal = next.signal;
        yield {kind:'text',index:0,text:'first'};
        await $.env.get('over-pulled');
        yield {kind:'text',index:0,text:'second'};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing turn.step closes before the first pull without entering the plugin hook', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('early return', async ($, on) => {
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect(() => on('clock.now', () => ({value:1}))).toThrow('on() must be called synchronously');
      expect((await stream.return(undefined)).done).toBe(true);
      await expect(stream.result).rejects.toThrow('closed');
      expect((await stream.next()).done).toBe(true);
      expect(await $.env.get({name:'entered'})).toEqual({value:'false'});
    });`, `export function register(on) {
      let entered = false;
      on('env.get', {name:'entered'}, () => ({value:String(entered)}));
      on('turn.step', async function* () {entered = true; yield {kind:'text',index:0,text:'unexpected'};});
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing turn.step exposes initialization failures through pulls and result', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('initialization', async $ => {
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect(stream.then).toBeUndefined();
      await expect(stream.next()).rejects.toThrow('required');
      await expect(stream.result).rejects.toThrow('required');
    });`, `export function register(on) {}`,
    {userConfig:{required:{type:'string',title:'Required',description:'Required',required:true}}})
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('testing turn.step forwards throw to the suspended generator', async () => {
  const {result} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('throw', async $ => {
      const stream = $.turn.step({turnId:'turn',index:0,model:'fake',messageCount:1});
      expect((await stream.next()).value.text).toBe('first');
      expect(await stream.throw(new Error('consumer-stop'))).toEqual({done:false,value:{kind:'text',index:0,text:'consumer-stop'}});
      expect((await stream.next()).done).toBe(true);
      expect((await stream.result).answer).toBe('recovered');
    });`, `export function register(on) {
      on('turn.step', async function* ($, e) {
        try { yield {kind:'text',index:0,text:'first'}; }
        catch (error) { yield {kind:'text',index:0,text:error.message}; }
        return {turnId:e.turnId,index:e.index,answer:'recovered',toolUses:[],stopReason:'end_turn',usage:null};
      });
    }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
}, 20000)

test('mounted queries match whole text and all fields in document order without exposing handlers or tree references', async () => {
  const {result, status} = await scenario(`import {test, expect} from 'claude-code/testing';
    test('queries', async $ => {
      const ui = await $.ui.mount('AbovePrompt');
      const original = JSON.stringify(await ui.drawn());
      const pending = ui.find({type:'Text', text:'hello world'});
      expect(typeof pending.then).toBe('function');
      expect(await pending).toEqual({type:'Text', key:undefined, props:{},
        text:'hello world', children:['hello ', {type:'Text',props:{},children:['world']}]});
      expect(await ui.find({key:'one', type:'Text'})).toBeUndefined();
      expect((await ui.find({type:'Button',key:'two',text:'Action'})).key).toBe('two');
      expect(await ui.find({key:'one', text:'absent'})).toBeUndefined();
      expect(await ui.find({key:'absent'})).toBeUndefined();
      expect(await ui.findAll({key:'absent'})).toEqual([]);
      expect(await ui.findAll({key:'fake'})).toEqual([]);
      expect((await ui.findAll({})).map(n => n.key)).toEqual(['root',undefined,undefined,'one','two',undefined,undefined,'input',undefined,undefined,undefined,'client']);
      const pattern = /action/gi;
      pattern.lastIndex = 2;
      expect((await ui.findAll({type:'Button', text:pattern})).map(n => n.key)).toEqual(['one','two']);
      expect((await ui.findAll({type:'Button', text:pattern})).map(n => n.key)).toEqual(['one','two']);
      expect(pattern.lastIndex).toBe(2);
      expect((await ui.find({text:/^hello worldAction oneAction twoformattedsourceenteredDocsVisit now$/})).key).toBe('root');
      for (const [type, text] of [['Markdown','formatted'], ['Code','source'], ['Input','entered']])
        expect((await ui.find({type})).text).toBe(text);
      expect((await ui.findAll({type:'Link'})).map(n => n.text)).toEqual(['Docs','Visit now']);
      const button = await ui.find({key:'one'});
      expect(Object.keys(button).sort()).toEqual(['children','key','props','text','type']);
      expect(button.props.onPress).toBeUndefined();
      const root = await ui.find({key:'root'});
      expect(JSON.stringify(root)).not.toContain('callbackId');
      expect(root.children[1].press).toBeUndefined();
      root.children[0].props.key = 'changed';
      root.props.key = 'changed';
      root.children.push('changed');
      button.props.label = 'changed';
      expect(JSON.stringify(await ui.drawn())).toBe(original);
      await expect(ui.find({in:'board'})).rejects.toThrow('not found');
      await expect(ui.findAll({in:'board'})).rejects.toThrow('not found');
      await ui.unmount();
    });`, `export function register(on) {
      on('ui.render', ($, e) => {
        const {Box, Text, Button, Markdown, Code, Input, Client, Link} = $.ui.resolve(e);
        return Box({key:'root', children:[
          Text({children:['hello ', Text({children:'world'})]}),
          Button({key:'one', label:'Action one', onPress:() => {}}),
          Button({key:'two', label:'Action two', onPress:() => {}}),
          Markdown({text:'formatted'}), Code({source:'source'}),
          Input({key:'input',value:'entered',onSubmit:() => {}}),
          Link({href:'https://example.com/',label:'Docs'}),
          Link({href:'https://example.com/',label:'fallback',children:['Visit ',Text({children:'now'})]}),
          Client({key:'client',module:'./register.tsx',props:{fake:{type:'Text',props:{key:'fake'},children:['fake']}}})
        ]});
      });
    }
    export default function Empty(_props, surface) { return surface.elements.Box({children:[]}); }`)
  expect(failures(result)).toEqual([])
  expect(passed(result)).toBe(1)
  expect(status).toBe(0)
}, 20000)

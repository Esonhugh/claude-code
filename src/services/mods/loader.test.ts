import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadModDeclaration, validateModRegistrations } from './loader'

const officialModsRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function plugin(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'mods-loader-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return {
    name: 'example', storageId: 'example@local', pluginRoot: root,
    entrypoints: [join(root, 'main.ts')],
  }
}

test.each(['session.attach', 'session.detach'])('statically admits %s and records its Worker registration', async event => {
  const input = await plugin({
    'main.ts': `export function register(on) { on('${event}', ($, e, next) => next(e)); }`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.events).toEqual([event])
  expect(validateModRegistrations(declaration, [{id:1,event,hasCatch:false}])).toEqual([
    {id:1,event,hasCatch:false},
  ])
})

test('statically admits session.measure and records its Worker registration', async () => {
  const input = await plugin({
    'main.ts': `export function register(on) { on('session.measure', ($, e, next) => next(e)); }`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.events).toEqual(['session.measure'])
  expect(validateModRegistrations(declaration, [{id:1,event:'session.measure',hasCatch:false}])).toEqual([
    {id:1,event:'session.measure',hasCatch:false},
  ])
})

test('loads Client surface graphs from literal call and JSX modules relative to each declaring file', async () => {
  const input = await plugin({
    'main.ts': `import { render } from './hooks/render.tsx'; export function register(on) {
      on('ui.render', ($, e) => render($.ui.resolve(e)));
      on('ui.message', ($, e) => ({props:{label:e.data}}));
    }`,
    'hooks/render.tsx': `export const render = ({Client}: any) => [
      <Client key="jsx" module="../clients/jsx.ts" props={{label:'jsx'}} />,
      Client({key:'call', module:'../clients/call.ts'}),
    ];`,
    'clients/jsx.ts': `import { label } from './shared.ts'; export default function View() { return label }`,
    'clients/call.ts': `export { default } from './jsx.ts'`,
    'clients/shared.ts': `export const label = 'surface'`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.events).toEqual(['ui.render', 'ui.message'])
  expect(declaration.clients).toEqual([
    { path: join(input.pluginRoot, 'clients/jsx.ts'), module: 'clients/jsx.ts' },
    { path: join(input.pluginRoot, 'clients/call.ts'), module: 'clients/call.ts' },
  ])
  expect(declaration.modules.map(module => module.path).sort()).toEqual([
    input.entrypoints[0], join(input.pluginRoot, 'hooks/render.tsx'),
    join(input.pluginRoot, 'clients/jsx.ts'), join(input.pluginRoot, 'clients/call.ts'),
    join(input.pluginRoot, 'clients/shared.ts'),
  ].sort())
  const render = declaration.modules.find(module => module.path.endsWith('render.tsx'))!.source
  expect(render).toContain('module: "clients/call.ts"')
  expect(render).toContain('module: "clients/jsx.ts"')
})

test('includes loaded Client surface sources in the declaration fingerprint', async () => {
  const input = await plugin({
    'main.ts': `export function register(on) { on('ui.render', ($, e) => $.ui.resolve(e).Client({module:'./counter.ts'})); }`,
    'counter.ts': `import './nested.ts'; export default function Counter() { return 'first' }`,
    'nested.ts': `export const nested = 1`,
  })
  const original = await loadModDeclaration(input)
  await writeFile(join(input.pluginRoot, 'nested.ts'), `export const nested = 2`)
  expect((await loadModDeclaration(input)).fingerprint).not.toBe(original.fingerprint)
})

test.each([
  [`const module = './counter.ts'; Client({module})`, /Client module.*literal/],
  ["Client({module:`./${name}.ts`})", /Client module.*literal/],
  [`Client({module:'../../outside.ts'})`, /Client module.*outside plugin root/],
  [`Client({module:'./missing.ts'})`, /cannot resolve Client module/],
  [`<Client module={module} />`, /Client module.*literal/],
])('rejects unsupported Client module declarations: %s', async (render, diagnostic) => {
  const input = await plugin({
    'main.tsx': `export function register(on) { on('ui.render', ($, e) => { const {Client} = $.ui.resolve(e); ${render}; }); }`,
    'counter.ts': `export default function Counter() {}`,
  })
  await expect(loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'main.tsx')] })).rejects.toThrow(diagnostic)
})

test('loads static relative imports, cycles, and the empty claude-code namespace without running code', async () => {
  const input = await plugin({
    'main.ts': `import type { Register } from 'claude-code'
      import * as api from 'claude-code'
      import { calculate } from './lib/calc'
      throw new Error('must not execute')
      const install: Register = (listen) => {
        listen('session.start', async (host, event, resume) => {
          return resume({ value: calculate(2) })
        })
      }
      export { install as register }`,
    'lib/calc.ts': `import './cycle.js'; export const calculate = (n: number) => n * 2`,
    'lib/cycle.js': `import './calc.ts'; export const label = 'cycle'`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.events).toEqual(['session.start'])
  expect(declaration.calls).toEqual([])
  expect(declaration.modules.map(module => module.path).sort()).toEqual([
    input.entrypoints[0]!, join(input.pluginRoot, 'lib/calc.ts'), join(input.pluginRoot, 'lib/cycle.js'),
  ].sort())
  expect(declaration.links).toContainEqual({ from: input.entrypoints[0], specifier: 'claude-code', to: 'claude-code' })
  expect(declaration.links).toContainEqual({ from: input.entrypoints[0], specifier: './lib/calc', to: join(input.pluginRoot, 'lib/calc.ts') })
})

test.each(['call', 'check', 'register'])('admits the author-side tool.%s capability without admitting unknown tool methods', async method => {
  const input = await plugin({
    'main.ts': `export function register(on) {
      on('session.start', async ($, e, next) => { await $.tool.${method}({tool:'Offline'}); return next(e); });
    }`,
  })
  expect((await loadModDeclaration(input)).calls).toEqual([`tool.${method}`])
})

test('admits async generators only on exact turn.step and scans the streaming capability', async () => {
  const input = await plugin({'main.ts': `export function register(on) {
    on('turn.step', async function* ($, e, next) { return yield* next(e); })
      .catch(async function* ($, e, next) { return yield* next.to(e, 'core'); });
    on('tool.call', async ($, e) => { const stream = $.turn.step(e); for await (const chunk of stream) {} return await stream.result; });
  }`})
  const spec = await loadModDeclaration(input)
  expect(spec.events).toEqual(['turn.step', 'tool.call'])
  expect(spec.calls).toEqual(['turn.step'])
  expect(spec.nextTiers).toEqual(['core'])
})

test.each([
  `on('turn.step', ($, e, next) => next(e))`,
  `on('turn.step', async ($, e, next) => next(e))`,
  `on('turn.step', function* () { yield 1 })`,
  `on('tool.call', async function* () { yield 1 })`,
  `on('turn.*', async function* () { yield 1 })`,
  `on('!turn.step', async function* () { yield 1 })`,
  `on('turn.step', async function* () {}).catch(() => ({}))`,
  `on('tool.call', () => ({})).catch(async function* () {})`,
])('rejects a non-streaming hook shape or generator outside exact turn.step: %s', async source => {
  const input = await plugin({'main.ts': `export function register(on) { ${source}; }`})
  await expect(loadModDeclaration(input)).rejects.toThrow(/generator/)
})

test('records literal environment reads and writes across entrypoints and imported helpers', async () => {
  const input = await plugin({
    'main.ts': `import { read } from './read'; export function register(on) {
      on('tool.call', async ($) => {
        await read($);
        await $.env.set('MODS_CONTRACT_VALUE', 'changed');
        return {result:await $.env.get('MODS_CONTRACT_VALUE')};
      });
    }`,
    'read.ts': `export async function read($) { return $.env.get('MODS_CONTRACT_HELPER'); }`,
  })
  const declaration = await loadModDeclaration(input)
  expect(declaration.calls).toEqual(['env.get', 'env.set'])
  expect(declaration.env).toEqual({
    reads: ['MODS_CONTRACT_HELPER', 'MODS_CONTRACT_VALUE'],
    writes: ['MODS_CONTRACT_VALUE'],
  })
})

test.each([
  `$.env.get(e.name)`,
  `$.env.set(e.name, 'value')`,
  `$.env.get('')`,
  `$.env.get('BAD=NAME')`,
  `$.env.set('BAD\\0NAME', 'value')`,
])('refuses environment names that cannot be admitted literally: %s', async expression => {
  const input = await plugin({
    'main.ts': `export function register(on) { on('tool.call', async ($, e) => ({result:await ${expression}})); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/environment.*literal|environment.*name/)
})

test('refuses dynamic environment names in imported helpers', async () => {
  const input = await plugin({
    'main.ts': `import { read } from './read'; export function register(on) { on('tool.call', ($, e) => read($, e.name)); }`,
    'read.ts': `export function read($, name) { return $.env.get(name); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/environment.*literal/)
})

test('rejects top-level await in imported files, including files also used as entrypoints', async () => {
  const input = await plugin({
    'main.ts': `import './helper.ts'; export function register(on) {}`,
    'helper.ts': `await Promise.resolve(); export function register(on) {}`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('top-level await')
  await expect(loadModDeclaration({ ...input, entrypoints: [...input.entrypoints, join(input.pluginRoot, 'helper.ts')] })).rejects.toThrow('top-level await')
})

test('admits active prompt.submit while rejecting unknown prompt capabilities', async () => {
  const result = await loadModDeclaration(await plugin({'main.ts': `export function register(on) {
    on('tool.call', async $ => ({result:{
      box:await $.prompt.read(),
      filled:await $.prompt.fill({text:'x'}),
      submitted:await $.prompt.submit({text:'queued'}),
    }}));
  }`}))
  expect(result.events).toEqual(['tool.call'])
  expect(result.calls).toEqual(['prompt.fill', 'prompt.read', 'prompt.submit'])
  await expect(loadModDeclaration(await plugin({'main.ts': `export function register(on) {
    on('tool.call', async $ => ({result:await $.prompt.unknown({text:'x'})}));
  }` }))).rejects.toThrow('unsupported core capability prompt.unknown')
})

test('admits positional MCP calls and records the capability', async () => {
  const result = await loadModDeclaration(await plugin({'main.ts': `export function register(on) {
    on('session.start', async ($, e, next) => {
      await $.mcp.call('claude.ai Gmail', 'create_draft', {subject:'Release notes'});
      return next(e);
    });
  }`}))
  expect(result.calls).toEqual(['mcp.call'])
})

test('admits hooks that observe and rewrite positional MCP calls', async () => {
  const result = await loadModDeclaration(await plugin({'main.ts': `export function register(on) {
    on('mcp.call', ($, e, next) => next({...e, tool:'rewritten'}));
  }`}))
  expect(result.events).toEqual(['mcp.call'])
})

test('tracks local helper arguments and const capability aliases by lexical binding', async () => {
  const input = await plugin({
    'main.ts': `function read(api, input, proceed) {
      const host = api;
      const resume = proceed;
      host.env.get('LOCAL_READ');
      host.env.set('LOCAL_WRITE', 'value');
      host.fs.ancestors({path:'.'});
      return resume.to(input, 'append');
    }
    export function register(on) {
      on('session.end', ($, e, next) => {
        const helper = read;
        return helper($, e, next);
      });
    }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['session.end'])
  expect(result.calls).toEqual(['env.get', 'env.set', 'fs.ancestors'])
  expect(result.env).toEqual({ reads: ['LOCAL_READ'], writes: ['LOCAL_WRITE'] })
  expect(result.nextTiers).toEqual(['append'])
})

test('scans module-local stable engine capture and frozen identity observation', async () => {
  const input = await plugin({ 'main.ts': `let first, captured;
    export function register(on) {
      on('session.start', ($, e, next) => {
        first = $; captured = () => $.source.read(); return next(e);
      });
      on('tool.call', async ($) => ({result:{
        same:first === $, frozen:Object.isFrozen($), value:await captured(),
      }}));
    }` })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['session.start', 'tool.call'])
  expect(result.calls).toEqual(['source.read'])
  expect(result.env).toBeUndefined()
  expect(result.nextTiers).toEqual([])
})

test('tracks local let initializers and homogeneous reassignment before reading captures', async () => {
  const input = await plugin({ 'main.ts': `let first;
    export function register(on) {
      on('tool.call', ($, e, next) => {
        first.env.get('CAPTURE_READ');
        let local = $; local = first; local.env.set('CAPTURE_WRITE', 'value');
        let resume = next; resume = next; return resume.to(e, 'append');
      });
      on('session.start', ($) => { first = $; first = $; });
      on('session.end', ($) => first !== $);
    }` })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get', 'env.set'])
  expect(result.env).toEqual({ reads: ['CAPTURE_READ'], writes: ['CAPTURE_WRITE'] })
  expect(result.nextTiers).toEqual(['append'])
})

test.each([
  `first = external`,
  `first = e`,
  `first = next`,
  `first = $.env`,
  `first = $.clock.now`,
  `first = () => $.clock.now()`,
  `first = e.flag ? $ : e`,
  `first ||= $`,
  `first++`,
  `[first] = e.values`,
  `({value:first} = e)`,
  `for (first of e.values) {}`,
  `unknown(first)`,
  `first(e)`,
  `return first`,
  `first.env.get(e.name)`,
  `first.env.set(e.name, 'value')`,
  `first.tool.unknown(e)`,
  `first['clock'].now()`,
  `first.clock?.now()`,
])('rejects unknown writes, mixed roles and unsafe uses of a let capture: %s', async body => {
  const input = await plugin({ 'main.ts': `let first;
    export function register(on) {
      on('tool.call', ($, e, next) => { ${body} });
      on('session.start', ($) => { first = $; });
    }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|literal|escape|assignment/)
})

test.each([
  `captured = external; captured($)`,
  `captured = e.callback; captured($)`,
  `captured = () => $.env.get('OTHER'); captured($)`,
])('rejects unknown or distinct helper reassignment of a let capture: %s', async body => {
  const input = await plugin({ 'main.ts': `let captured;
    export function register(on) {
      on('tool.call', ($, e) => { ${body} });
      on('session.start', ($) => { captured = api => api.clock.now(); });
    }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/assignment/)
})

test('specializes a captured helper used before its assignment', async () => {
  const input = await plugin({ 'main.ts': `let captured;
    export function register(on) {
      on('tool.call', ($, e, next) => captured($, e, next));
      on('session.start', ($) => {
        captured = (api, input, resume) => {
          api.env.get('CAPTURED_HELPER'); return resume.to(input, 'core');
        };
      });
    }` })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get'])
  expect(result.env).toEqual({ reads: ['CAPTURED_HELPER'], writes: [] })
  expect(result.nextTiers).toEqual(['core'])
})

test.each([
  `return api.env.get(input.name)`,
  `return resume.to(input, input.tier)`,
  `return unknown(api)`,
  `return api.tool.unknown(input)`,
])('retains env, tiers and callee admission in captured helpers: %s', async body => {
  const input = await plugin({ 'main.ts': `let captured;
    export function register(on) {
      on('tool.call', ($, e, next) => captured($, e, next));
      on('session.start', ($) => { captured = (api, input, resume) => { ${body} }; });
    }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|literal|escape/)
})

test('keeps capture bindings separate across lexical shadows and same-name modules', async () => {
  const input = await plugin({
    'main.ts': `import { read } from './selected'; import './decoy'; let first;
      export function register(on) {
        on('tool.call', ($, e) => {
          function ordinary(first) { return unknown(first); }
          { let first = e; ordinary(first); }
          first.env.get('MODULE_CAPTURE'); return read($);
        });
        on('session.start', ($) => { first = $; });
      }`,
    'selected.ts': `export function read(api) { let first = api; return first.env.get('LOCAL_CAPTURE'); }`,
    'decoy.ts': `let first = external; first = other; unknown(first);`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get'])
  expect(result.env).toEqual({ reads: ['LOCAL_CAPTURE', 'MODULE_CAPTURE'], writes: [] })
})

test.each([
  `const Object = {isFrozen:unknown}; Object.isFrozen($)`,
  `function observe(Object) { return Object.isFrozen($); }; observe(external)`,
  `Object.isFrozen($); let Object = external`,
  `Object.isFrozen = unknown; Object.isFrozen($)`,
  `Object = external; Object.isFrozen($)`,
  `Object['isFrozen']($)`,
  `Object.isFrozen?.($)`,
  `Object.isFrozen($, e)`,
  `const frozen = Object.isFrozen; frozen($)`,
  `unknown($ === $, $)`,
  `$ == $`,
  `$ !== unknown($)`,
  `Object.isFrozen($.env)`,
])('does not give an unknown callee capability via identity observation: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e) => { ${body} });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|escape/)
})

test('treats for-of initialization as an unknown write to a local capture', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e) => {
      for (let first of e.values) { if (e.capture) first = $; first.clock.now(); }
    });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/assignment/)
})

test('does not admit a replaced isFrozen through an alias of the builtin Object', async () => {
  const input = await plugin({ 'main.ts': `const Builtin = Object;
    Builtin.isFrozen = unknown;
    export function register(on) { on('tool.call', ($) => Object.isFrozen($)); }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('does not confuse destructuring property keys with capture writes', async () => {
  const input = await plugin({ 'main.ts': `let first;
    export function register(on) {
      on('session.start', ($) => { first = $; });
      on('tool.call', ($, e) => { let value; ({first:value} = e); return first.clock.now(); });
    }` })
  expect((await loadModDeclaration(input)).calls).toEqual(['clock.now'])
})

test.each([
  `delete Object.isFrozen`,
  `Object.__defineGetter__('isFrozen', () => unknown)`,
])('rejects identity observation after builtin mutation: %s', async mutation => {
  const input = await plugin({ 'main.ts': `${mutation};
    export function register(on) { on('tool.call', ($) => Object.isFrozen($)); }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test.each([
  `resume.to(e, e.tier)`,
  `resume.to(e, 'unknown')`,
  `unknown(resume)`,
  `resume['to'](e, 'core')`,
])('retains Next restrictions through a module let capture: %s', async expression => {
  const input = await plugin({ 'main.ts': `let resume;
    export function register(on) {
      on('tool.call', ($, e) => ${expression});
      on('session.start', ($, e, next) => { resume = next; });
    }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|literal|escape/)
})

test.each([
  `api.env.get('HIDDEN_HELPER_ENV')`,
  `resume.to(input, 'core')`,
  `unknown(api)`,
])('scans captured helper calls nested inside ordinary callbacks: %s', async body => {
  const input = await plugin({ 'main.ts': `let captured;
    function apply(fn) { return fn(); }
    export function register(on) {
      on('session.start', ($, e, next) => { captured = (api, input, resume) => { ${body} }; });
      on('tool.call', ($, e, next) => apply(() => captured($, e, next)));
    }` })
  if (body.startsWith('unknown')) await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
  else {
    const result = await loadModDeclaration(input)
    expect(result.calls).toEqual(body.startsWith('api.') ? ['env.get'] : [])
    expect(result.nextTiers).toEqual(body.startsWith('resume.') ? ['core'] : [])
  }
})

test('tracks a module capture exported from a later imported module', async () => {
  const input = await plugin({
    'main.ts': `import { first } from './other'; export function register(on) {
      on('tool.call', () => first.env.get('IMPORTED_CAPTURE'));
    }`,
    'other.ts': `export let first; export function register(on) {
      on('session.start', ($) => { first = $; });
    }`,
  })
  const result = await loadModDeclaration({ ...input, entrypoints: [...input.entrypoints, join(input.pluginRoot, 'other.ts')] })
  expect(result.calls).toEqual(['env.get'])
  expect(result.env).toEqual({ reads: ['IMPORTED_CAPTURE'], writes: [] })
})

test.each([
  `let first = external; first = $; first.clock.now()`,
  `let first = e; first = $; unknown(first)`,
  `let first; let alias = first; unknown(alias); first = $`,
  `let first; let alias = first; alias = external; first = $; alias.clock.now()`,
  `let first; first = $; sink(first = $)`,
])('validates every assignment source and transitive capture read: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e) => { ${body} });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|escape|assignment/)
})

test.each([
  `let first = $; const firstLater = () => first.env.get('LOCAL_CLOSURE'); firstLater()`,
  `let first = $; { let first = e; unknown(first); } first.env.get('LOCAL_CLOSURE')`,
])('preserves local capture closures without confusing ordinary shadows: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e) => { ${body} });
  }` })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get'])
  expect(result.env).toEqual({ reads: ['LOCAL_CLOSURE'], writes: [] })
})

test.each([
  `let Object = external; Object.isFrozen($)`,
  `try { throw e; } catch (Object) { Object.isFrozen($); }`,
  `for (const Object of e.values) { Object.isFrozen($); }`,
  `const C = class Object { method() { return Object.isFrozen($); } };`,
])('respects additional lexical Object shadows: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e) => { ${body} });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('rejects a same-name imported Object instead of assuming the builtin', async () => {
  const input = await plugin({
    'main.ts': `import { Object } from './object'; export function register(on) {
      on('tool.call', ($) => Object.isFrozen($));
    }`,
    'object.ts': `export const Object = {isFrozen:unknown};`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('tracks captured method aliases and a single stable helper target', async () => {
  const input = await plugin({ 'main.ts': `let read, write, to, captured;
    function helper(api) { return api.clock.now(); }
    export function register(on) {
      on('tool.call', ($, e) => {
        read('METHOD_READ'); write('METHOD_WRITE', 'value'); captured($); return to(e, 'core');
      });
      on('session.start', ($, e, next) => {
        read = $.env.get; write = $.env.set; to = next.to; captured = helper; captured = helper;
      });
    }` })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['clock.now', 'env.get', 'env.set'])
  expect(result.env).toEqual({ reads: ['METHOD_READ'], writes: ['METHOD_WRITE'] })
  expect(result.nextTiers).toEqual(['core'])
})

test.each([
  `let value = $.env.get; value = $.env.set; value('MIXED')`,
  `let value = $.clock.now; value = next; value(e)`,
  `let value = next.to; value = next.is; value(e, 'core')`,
])('rejects heterogeneous capture member assignments: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($, e, next) => { ${body} });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/mixed.*assignments/)
})

test('allows supported capabilities through stable local aliases and helper returns', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', async ($, e) => {
      let first; first = $; const alias = first;
      function fetch(api, input) { return api.http.fetch(input); }
      await alias.http.fetch(e);
      return fetch($, e);
    });
  }` })
  expect((await loadModDeclaration(input)).calls).toEqual(['http.fetch'])
})

test('follows renamed imports, re-exports and method aliases without guessing parameter names', async () => {
  const input = await plugin({
    'main.ts': `import { forwarded as invoke } from './barrel';
      export function register(on) { on('tool.call', ($, e, next) => invoke($, e, next)); }`,
    'barrel.ts': `export { work as forwarded } from './helper';`,
    'helper.ts': `export function work(value, input, continuation) {
      const api = value; const env = api.env; const read = env.get;
      const write = api.env.set; const resume = continuation; const to = resume.to;
      read('IMPORTED_READ'); write('IMPORTED_WRITE', 'value');
      return to({...input, budget:resume.budget}, 'core');
    }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get', 'env.set'])
  expect(result.env).toEqual({ reads: ['IMPORTED_READ'], writes: ['IMPORTED_WRITE'] })
  expect(result.nextTiers).toEqual(['core'])
})

test.each([
  `function helper(api) { api.clock.now() }; helper = external; helper($)`,
  `function helper(api) { api.clock.now() }; const invoke = helper; helper = external; invoke($)`,
])('rejects mutable helper targets rather than scanning stale bindings: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) { on('tool.call', ($, e, next) => { ${body} }); }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/mutable|assignment/)
})

test('does not treat a helper return as an engine.create handler return', async () => {
  const input = await plugin({
    'main.ts': `function reveal(api, input, continuation) { return continuation(input) }
      export function register(on) { on('engine.create', async ($, e, next) => {
        return (await reveal($, e, next)).tool.register(e);
      }); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test.each([
  `unknown($)`,
  `let alias = $; alias = external; alias.clock.now()`,
  `const alias = e.flag ? $ : e; alias.clock.now()`,
  `const alias = [$]; unknown(alias)`,
  `function helper(api) { unknown(api) }; helper($)`,
  `function helper(api) { return api }; helper($).clock.now()`,
  `function helper(api) { const read = api.env.get; return read(e.name) }; helper($)`,
  `function helper(resume) { const to = resume.to; return to(e, e.tier) }; helper(next)`,
  `function helper(api) { api.clock.now() }; { const helper = external; helper($) }`,
  `function helper(api) { api.clock.now() }; function wrapper(helper) { helper($) }; wrapper(external)`,
])('rejects untrackable or inadmissible helper capability flow: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) { on('tool.call', ($, e, next) => { ${body} }); }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|literal|escape/)
})

test('follows the selected module and lexical binding, not same-name or conventional parameters', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './selected'; import './unrelated';
      export function register(on) { on('tool.call', ($, e, next) => {
        helper($, e, next);
        { const helper = (api) => api.fs.read({path:'x'}); helper($); }
      }); }`,
    'selected.ts': `export function helper(value, input, resume) {
      value.env.get('SELECTED'); return resume.to(input, 'append');
    }`,
    'unrelated.ts': `export function helper($, input, next) {
      $.http.fetch(input); $.env.get('NOT_SELECTED'); return next.to(input, 'core');
    }
    function ordinary($) { return $.env.get('NOT_A_CAPABILITY') }
    ordinary({env:{get(value){return value}}});`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get', 'fs.read'])
  expect(result.env).toEqual({ reads: ['SELECTED'], writes: [] })
  expect(result.nextTiers).toEqual(['append'])
})

test('allows direct engine noun forwarding only at the engine.create return boundary', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async ($, e, next) => {
      const below = await next(e); const clock = below.clock;
      await clock.now(); return { ...below, clock };
    });
  }` })
  expect((await loadModDeclaration(input)).calls).toEqual(['clock.now'])
})

test('rejects renaming env into store in an engine provider return', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async ($, e, next) => { const below = await next(e); return {...below, store:below.env}; });
    on('tool.call', ($) => $.store.get('HIDDEN_ENV_NAME'));
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/noun.*alias|alias.*noun/)
})

test('rejects renaming a core noun into a custom provider to bypass call admission', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async ($, e, next) => { const below = await next(e); return {...below, safe:below.tool}; });
    on('session.start', ($, e) => $.safe.register(e));
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/noun.*alias|alias.*noun/)
})

test('rejects engine nouns hidden in ordinary objects inside engine.create', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async ($, e, next) => {
      const below = await next(e); const hidden = { clock: below.clock };
      hidden.clock.now(); return below;
    });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('rejects an engine returned by recursively calling an inline named handler as a helper', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async function create($, e, next) {
      if (e.stop) return next(e);
      const hidden = await create($, {...e, stop:true}, next);
      return hidden.tool.register(e);
    });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('rejects a hidden engine returned through a Next method alias', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('engine.create', async ($, e, next) => { const to = next.to; return (await to(e, 'core')).tool.register(e); });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/escape/)
})

test('rejects unresolved higher-order helper targets even with a known capability argument', async () => {
  const input = await plugin({
    'main.ts': `function apply(fn, api) { return fn(api); }
      export function register(on) { on('tool.call', ($) => apply(external, $)); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unknown\/dynamic helpers/)
})

test('rejects capability member growth in recursive helpers', async () => {
  const input = await plugin({
    'main.ts': `function descend(api) { return descend(api.more); }
      export function register(on) { on('tool.call', ($) => descend($)); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/static.*capability|capabilit.*static/)
})

test('builds module bindings before inspecting imported top-level initializer calls', async () => {
  const input = await plugin({
    'main.ts': `import { valueOf } from './helper'; const value = valueOf();
      export function register(on) { on('tool.call', ($, e, next) => next({...e, value})); }`,
    'helper.ts': `export const valueOf = () => 1;`,
  })
  expect((await loadModDeclaration(input)).calls).toEqual([])
})

test('records two specializations of one helper without mixing capabilities and Next', async () => {
  const input = await plugin({
    'main.ts': `function invoke(fn, value) { return fn(value); }
      export function register(on) { on('tool.call', ($, e, next) => {
        invoke($.clock.now, e); return invoke(next, e);
      }); }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['clock.now'])
  expect(result.nextTiers).toEqual([])
})

test('rejects spread arguments that obscure helper capability parameter positions', async () => {
  const input = await plugin({
    'main.ts': `function helper(api, other) { return api.clock.now(); }
      export function register(on) { on('tool.call', ($) => helper(...[], $)); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/spread|dynamic helpers/)
})

test('rejects capability aliases hidden in catch destructuring defaults', async () => {
  const input = await plugin({
    'main.ts': `function helper(api) {
      try { throw 1; } catch ({value = api}) { value.env.get('HIDDEN'); }
    }
    export function register(on) { on('tool.call', ($) => helper($)); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow(/alias\/escape/)
})

test('rejects reassignment of a helper through a loop target', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('tool.call', ($) => { function helper(api) { api.clock.now() }; for (helper of [external]) helper($); });
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/assignment/)
})

test('preserves direct method aliases and local closure helpers with precise calls', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    on('session.start', ($, e, next) => {
      const invoke = $.clock.now;
      const helper = api => api.clock.sleep(e);
      const alias = next;
      invoke(e); helper($); return alias(e);
    });
  }` })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['clock.now', 'clock.sleep'])
  expect(result.nextTiers).toEqual([])
})

test('resolves the official self-namespace default re-export helper pattern', async () => {
  const input = await plugin({
    'main.ts': `import Gate from './gate'; export function register(on) {
      on('tool.call', ($, e, next) => Gate.served(e, next));
    }`,
    'gate/index.ts': `export * from './served'; export * as default from '.';`,
    'gate/served.ts': `export const served = (e, resume) => resume.called ? resume(e) : resume.to(e, 'append');`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual([])
  expect(result.nextTiers).toEqual(['append'])
})

test('follows a named default-exported helper through a renamed re-export', async () => {
  const input = await plugin({
    'main.ts': `import { run as helper } from './barrel'; export function register(on) {
      on('tool.call', ($) => helper($));
    }`,
    'barrel.ts': `export { default as run } from './helper';`,
    'helper.ts': `export default function work(value) { return value.clock.now(); }`,
  })
  expect((await loadModDeclaration(input)).calls).toEqual(['clock.now'])
})

test('honors an explicit helper export over ambiguous star exports', async () => {
  const input = await plugin({
    'main.ts': `import { work } from './barrel'; export function register(on) { on('tool.call', ($) => work($)); }`,
    'barrel.ts': `export * from './a'; export * from './b'; export { work } from './selected';`,
    'a.ts': `export function work(api) { api.env.get('NOT_SELECTED_A'); }`,
    'b.ts': `export function work(api) { api.env.get('NOT_SELECTED_B'); }`,
    'selected.ts': `export function work(api) { api.clock.now(); }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['clock.now'])
  expect(result.env).toBeUndefined()
})

test('rejects genuinely ambiguous helper star exports', async () => {
  const input = await plugin({
    'main.ts': `import { work } from './barrel'; export function register(on) { on('tool.call', ($) => work($)); }`,
    'barrel.ts': `export * from './a'; export * from './b';`,
    'a.ts': `export function work(api) { api.clock.now(); }`,
    'b.ts': `export function work(api) { api.env.get('OTHER'); }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('ambiguous helper export')
})

test('tracks namespace and star re-export helpers, multi-hop calls, and recursive bindings', async () => {
  const input = await plugin({
    'main.ts': `import * as helpers from './barrel'; export function register(on) {
      on('tool.call', ($, e, next) => helpers.work($, e, next));
    }`,
    'barrel.ts': `export * from './helper';`,
    'helper.ts': `import { leaf as finish } from './leaf';
      export const work = (api, input, resume) => {
        if (input.again) return work(api, {...input, again:false}, resume);
        return finish(api, input, resume);
      };`,
    'leaf.ts': `export function leaf(value, input, continuation) {
      function nested() { value.env.get('MULTIHOP'); }
      nested(); return continuation.to(input, 'core');
    }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual(['env.get'])
  expect(result.env).toEqual({ reads: ['MULTIHOP'], writes: [] })
  expect(result.nextTiers).toEqual(['core'])
})

test('tracks renamed capabilities, closures, provider function parameters, and catch handlers lexically', async () => {
  const input = await plugin({
    'main.ts': `export function register(listen) {
      listen('engine.create', async (host, input, resume) => {
        const beneath = await resume(input)
        function calculate(host) { return host + 1 }
        return { ...beneath, arithmetic: {
          add: async (left, right, third) => ({ value: calculate(left.value) + right }),
          time: async (input) => beneath.clock.now(input),
        } }
      })
      listen('session.start', async (host, input, resume) => {
        const calculate = (host, resume) => host + resume
        { const host = { tool: { register() {} } }; host.tool.register() }
        for (const host of [1]) calculate(host, 2)
        try { calculate(1, 2) } catch (host) { String(host) }
        const captured = () => host.arithmetic.add({ value: 2 })
        await captured()
        return resume(input)
      }).catch(async (capabilities, input, continuation) => {
        await capabilities.clock.sleep({ ms: 1 })
        return continuation(input)
      })
      listen('arithmetic.add', (host, input, resume) => resume(input))
    }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['engine.create', 'session.start', 'arithmetic.add'])
  expect(result.calls).toEqual(['arithmetic.add', 'clock.now', 'clock.sleep'])
})

test('rejects registration handle escape that would hide catch-handler capabilities', async () => {
  const input = await plugin({ 'main.ts': `export function register(on) {
    const handle = on('tool.call', (host, event, next) => next(event))
    handle.catch((host, event, next) => host.tool.register(event))
  }` })
  await expect(loadModDeclaration(input)).rejects.toThrow('registration')
})

test.each([
  `on('engine.create', async (host, e, next) => { const engine = await next.to(e, 'core'); return engine.tool.unknown(e) })`,
  `on('engine.create', async (host, e, next) => (await next(e)).tool.call(e))`,
  `on('engine.create', async (host, e, next) => { const reveal = () => below; const below = await next(e); return reveal().tool.call(e) })`,
  `on('engine.create', async (host, e, next) => { const below = await next(e); function reveal() { return below }; return reveal().tool.call(e) })`,
  `on('engine.create', async (host, e, next) => { const below = await next(e); const reveal = () => ({ ...below }); return reveal().tool.call(e) })`,
  `on('tool.call', function(host, e, next) { return arguments[0].tool.register(e) })`,
  `const extra = register; extra((name, callback) => callback({}, {}, () => ({})))`,
])('rejects untracked capability escape: %s', async body => {
  const input = await plugin({ 'main.ts': `export function register(on) { ${body} }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(/unsupported|alias|escape/)
})

test.each([
  [`on(['tool.call'], () => {})`, /literal/],
  [`const event = 'tool.call'; on(event, () => {})`, /literal/],
  [`on('tool.call', (e) => true, () => {})`, /matcher/],
  [`on('tool.call', handler)`, /inline/],
  [`on?.('tool.call', () => {})`, /optional/],
  [`on('turn.step', () => {})`, /async generators/],
  [`const alias = on; alias('tool.call', () => {})`, /alias/],
  [`on('session.start', ($, e, next) => $.tool.unknown(e))`, /unsupported core capability/],
  [`on('session.start', ($, e, next) => $.tool['register'](e))`, /computed/],
  [`on('session.start', ($, e, next) => $['clock'].now(e))`, /computed/],
  [`on('session.start', ($, e, next) => $.clock['now'](e))`, /computed/],
  [`on('session.start', ($, e, next) => $.clock?.now(e))`, /optional/],
  [`on('session.start', ($, e, next) => $.clock.now?.(e))`, /optional/],
  [`on('session.start', ($, e, next) => { const { clock } = $; clock.now(e) })`, /alias/],
  [`on('session.start', ($, e, next) => next.to(e, e.tier))`, /literal/],
  [`on('session.start', ($, e, next) => next['to'](e, 'core'))`, /literal/],
  [`on('session.start', ($, e, next) => next.to(e, 'unknown'))`, /literal/],
  [`on('engine.create', ($, e, next) => next(e)).catch(() => {})`, /engine.create catch/],
  [`on('session.start', ({ clock }, e, next) => clock.now(e))`, /parameters/],
  [`on('session.start', ($, ...args) => args[1].to(args[0], 'core'))`, /parameters/],
  [`var alias = on`, /var/],
])('rejects unsupported author syntax: %s', async (body, diagnostic) => {
  const input = await plugin({ 'main.ts': `export function register(on) { ${body} }` })
  await expect(loadModDeclaration(input)).rejects.toThrow(diagnostic)
})

test.each([
  [`import fs from 'node:fs'; export function register(on) {}`, /bare/],
  [`import 'some-package'; export function register(on) {}`, /bare/],
  [`import '/absolute.js'; export function register(on) {}`, /bare/],
  [`import { on } from 'claude-code'; export function register(listen) {}`, /empty runtime/],
  [`export default function register(on) {}`, /named register/],
  [`export { register } from './helper.ts'`, /re-exported register/],
  [`import { register } from './helper.ts'; export { register }`, /re-exported register/],
  [`export function register(on) { import('./helper.ts') }`, /dynamic import/],
  [`export function register(on) { if (false) import('./helper.ts') }`, /dynamic import/],
  [`export function register(on) { require('./helper.ts') }`, /unsupported/],
  [`export function register(on) { eval('1') }`, /unsupported/],
  [`export function register(on) { new Function('return 1') }`, /unsupported/],
  [`export function register(on) { return import.meta.url }`, /unsupported/],
])('rejects unsupported module syntax: %s', async (source, diagnostic) => {
  const input = await plugin({ 'main.ts': source, 'helper.ts': 'export function register(on) {}' })
  await expect(loadModDeclaration(input)).rejects.toThrow(diagnostic)
})

test.each([
  `export function register(on) { const matcher = getMatcher(); on('tool.call', { tool: matcher }, () => ({})) }`,
  `export function register(on) { let matcher = 'Bash'; on('tool.call', { tool: matcher }, () => ({})) }`,
  `export function register(on) { const matchers = getMatchers(); on('tool.call', { tool: [...matchers] }, () => ({})) }`,
])('rejects dynamic identifiers and spreads in matcher data: %s', async source => {
  const input = await plugin({ 'main.ts': source })
  await expect(loadModDeclaration(input)).rejects.toThrow(/matcher.*constant|static matcher/i)
})

test('scans official matcher forms and pattern registrations without evaluating constants', async () => {
  const input = await plugin({
    'main.ts': `import { COMMAND, TOOLS } from './constants.js'
      export function register(on) {
        on('*', { tool: /Bash|Edit/, input: { command: /^git\\s/ } }, ($, e, next) => next(e))
        on('command.*', { command: COMMAND }, ($, e, next) => next(e))
        on('!tool.call', { command: ['clear', 'resume'] }, ($, e, next) => next(e))
        on('tool.call', { tool: [...TOOLS] }, ($, e, next) => next(e))
      }`,
    'constants.ts': `export const COMMAND = 'diff'; export const TOOLS = ['Edit', 'Write'] as const`,
  })

  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['*', 'command.*', '!tool.call', 'tool.call'])
  expect(result.modules.map(module => module.path)).toContain(join(input.pluginRoot, 'constants.ts'))
})

test('loads a direct .cjs ESM entrypoint', async () => {
  const input = await plugin({
    'main.cjs': `export function register(on) { on('tool.call', () => ({ result: 'cjs' })) }`,
  })
  const entrypoint = join(input.pluginRoot, 'main.cjs')
  const declaration = await loadModDeclaration({ ...input, entrypoints: [entrypoint] })

  expect(declaration.events).toEqual(['tool.call'])
  expect(declaration.modules).toEqual([{ path: entrypoint, source: expect.stringContaining('export function register(on)') }])
})

test('loads a direct .cts ESM entrypoint', async () => {
  const input = await plugin({
    'main.cts': `export function register(on: (event: string, handler: Function) => void) { on('tool.call', () => ({ result: 'cts' })) }`,
  })
  const entrypoint = join(input.pluginRoot, 'main.cts')
  const declaration = await loadModDeclaration({ ...input, entrypoints: [entrypoint] })

  expect(declaration.events).toEqual(['tool.call'])
  expect(declaration.modules[0]).toMatchObject({ path: entrypoint })
  expect(declaration.modules[0]?.source).not.toContain('event: string')
})

test('resolves an extensionless import to a .cjs ESM module and snapshots its source', async () => {
  const input = await plugin({
    'main.ts': `import { value } from './helper'; export function register(on) { on('tool.call', () => ({ result: value })) }`,
    'helper.cjs': `export const value = 'first'`,
  })
  const helper = join(input.pluginRoot, 'helper.cjs')
  const original = await loadModDeclaration(input)

  expect(original.links).toContainEqual({ from: input.entrypoints[0], specifier: './helper', to: helper })
  expect(original.modules).toContainEqual({ path: helper, source: expect.stringContaining('value = "first"') })
  await writeFile(helper, `export const value = 'second'`)
  expect((await loadModDeclaration(input)).fingerprint).not.toBe(original.fingerprint)
})

test('resolves a directory import to an index.cts ESM module', async () => {
  const input = await plugin({
    'main.ts': `import { value } from './hooks'; export function register(on) { on('tool.call', () => ({ result: value })) }`,
    'hooks/index.cts': `export const value: string = 'directory-cts'`,
  })
  const index = join(input.pluginRoot, 'hooks/index.cts')
  const declaration = await loadModDeclaration(input)

  expect(declaration.links).toContainEqual({ from: input.entrypoints[0], specifier: './hooks', to: index })
  expect(declaration.modules).toContainEqual({ path: index, source: expect.stringContaining('value = "directory-cts"') })
})

test('resolves directories, remaps emitted extensions, and transpiles TSX through h and Fragment', async () => {
  const input = await plugin({
    'main.ts': `import { view } from './view/index.js'; import './helper.jsx'; export function register(on) { on('ui.render', ($, e, next) => next(e)); void view }`,
    'view/index.ts': `export { view } from './view.js'`,
    'view/view.tsx': `export const view = (Box: any) => <><Box>ok</Box></>`,
    'helper.tsx': `export const helper = <Text>ok</Text>`,
  })

  const result = await loadModDeclaration(input)
  expect(result.modules.map(module => module.path).sort()).toEqual([
    input.entrypoints[0], join(input.pluginRoot, 'view/index.ts'),
    join(input.pluginRoot, 'view/view.tsx'), join(input.pluginRoot, 'helper.tsx'),
  ].sort())
  expect(result.links).toContainEqual({ from: input.entrypoints[0], specifier: './view/index.js', to: join(input.pluginRoot, 'view/index.ts') })
  expect(result.links).toContainEqual({ from: join(input.pluginRoot, 'view/index.ts'), specifier: './view.js', to: join(input.pluginRoot, 'view/view.tsx') })
  expect(result.modules.find(module => module.path.endsWith('view.tsx'))?.source).toContain('h(Fragment')
  expect(result.modules.find(module => module.path.endsWith('helper.tsx'))?.source).toContain('h(Text')
})

test.skipIf(!officialModsRoot)(
  'loads the complete official diff graph with exact declarations',
  async () => {
    const diffRoot = join(officialModsRoot!, 'diff/hooks')
    const diff = await loadModDeclaration({
      name: 'diff', storageId: 'diff@official', pluginRoot: diffRoot,
      entrypoints: [join(diffRoot, 'register.ts')],
    })
    expect(diff.modules).toHaveLength(506)
    expect(new Set(diff.modules.map(module => module.path)).size).toBe(506)
    expect(diff.links).toContainEqual({
      from: join(diffRoot, 'register.ts'), specifier: './is-checkpointing',
      to: join(diffRoot, 'is-checkpointing/index.ts'),
    })
    expect(diff.links).toContainEqual({
      from: join(diffRoot, 'is-checkpointing/index.ts'), specifier: './is-checkpointing.js',
      to: join(diffRoot, 'is-checkpointing/is-checkpointing.ts'),
    })
    expect(diff.events).toEqual([
      'session.start', 'ui.render', 'command.run', 'ui.close', 'ui.focus',
      'ui.scroll', 'tool.call', 'prompt.submit',
    ])
    expect(diff.calls).toEqual([
      'clock.after', 'clock.every', 'clock.now', 'command.register', 'env.get', 'fs.list',
      'fs.read', 'fs.stat', 'process.run', 'session.id', 'session.messages', 'session.usage',
      'settings.read', 'store.get', 'store.set', 'telemetry.log', 'telemetry.mark', 'ui.close',
      'ui.invalidate', 'ui.log', 'ui.open', 'ui.resolve', 'ui.status',
    ])
    expect(diff.env).toEqual({ reads: ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'], writes: [] })
    expect(diff.nextTiers).toEqual([])
  },
)

test.skipIf(!officialModsRoot)(
  'loads the complete official sec-default graph with exact declarations',
  async () => {
    const securityRoot = join(officialModsRoot!, 'sec-default/hooks')
    const security = await loadModDeclaration({
      name: 'sec-default', storageId: 'sec-default@official', pluginRoot: securityRoot,
      entrypoints: [join(securityRoot, 'register.ts')],
    })
    expect(security.modules).toHaveLength(21)
    expect(security.events).toEqual([
      'classic.*', 'prompt.section', 'prompt.context', 'skill.prompt',
      'attribution.text', 'settings.read', 'tool.describe', 'command.describe',
      'agent.offer', 'agent.spawn', 'tool.register', 'tool.list',
    ])
    expect(security.calls).toEqual(['settings.read'])
    expect(security.nextTiers).toEqual(['append'])
  },
)

test.skipIf(!officialModsRoot)(
  'loads the official agents-md local helpers with exact capability and environment declarations',
  async () => {
    const root = join(officialModsRoot!, 'agents-md/hooks')
    const result = await loadModDeclaration({
      name: 'agents-md', storageId: 'agents-md@official', pluginRoot: root,
      entrypoints: [join(root, 'register.ts')],
    })
    expect(result.modules).toHaveLength(50)
    expect(result.events).toEqual(['session.start', 'prompt.context', 'agent.spawn', 'tool.call'])
    expect(result.calls).toEqual([
      'env.get', 'fs.ancestors', 'session.cwd', 'session.root', 'telemetry.log', 'telemetry.mark', 'ui.log',
    ])
    expect(result.env).toEqual({
      reads: ['CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_SIMPLE', 'HOME', 'USERPROFILE'], writes: [],
    })
    expect(result.nextTiers).toEqual([])
  },
)

test('normalizes actual VM registrations and keeps scan consistency for every pattern', async () => {
  const input = await plugin({
    'main.ts': `export function register(on) {
      on('tool.*', { tool: /Bash/, input: { command: ['pwd', /^git/] } }, () => ({}))
    }`,
  })
  const declaration = await loadModDeclaration(input)
  const registrations = validateModRegistrations(declaration, [{
    id: 1,
    event: 'tool.*',
    matcher: { tool: /Bash/, input: { command: ['pwd', /^git/] } },
    hasCatch: false,
  }])

  expect(registrations[0]?.matcher).not.toBeUndefined()
  expect(() => validateModRegistrations(declaration, [{
    id: 1, event: 'session.*', hasCatch: false,
  }])).toThrow('absent from scan')
})

test('rejects an unsupported capability hidden in an imported helper', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './helper.js'; export function register(on) {
      on('session.start', (host, e, next) => helper(host))
    }`,
    'helper.js': `export function helper(value) { return value.tool.unknown({}) }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('unsupported core capability tool.unknown')
})

test('collects a renamed Next parameter from the selected module despite a same-name decoy', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './selected'; import './decoy'; export function register(on) {
      on('tool.describe', ($, e, next) => helper(e, next));
    }`,
    'selected.ts': `export function helper(e, value) { return value.to(e, 'append'); }`,
    'decoy.ts': `export function helper(next, e) { return next.to(e, 'core'); }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.calls).toEqual([])
  expect(result.nextTiers).toEqual(['append'])
})

test('does not approve an imported capability helper through an unrelated same-name function', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './unsafe.js'; import './safe.js'; export function register(on) {
      on('tool.describe', ($, e, next) => helper(e, next))
    }`,
    'unsafe.js': `export function helper(e, value) { return unknown(value) }`,
    'safe.js': `export function helper(next, e) { return next(e) }`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('helpers')
})

test('tracks passing the whole engine to an imported capability helper', async () => {
  const input = await plugin({
    'main.ts': `import { helper } from './helper.js'; export function register(on) {
      on('session.start', ($, e, next) => helper($))
    }`,
    'helper.js': `export function helper(host) { return host.clock.now() }`,
  })
  expect((await loadModDeclaration(input)).calls).toEqual(['clock.now'])
})

test('scans capabilities and tiers in imported helpers that receive next', async () => {
  const input = await plugin({
    'main.ts': `import { continuePastUsers } from './helper.js'; export function register(on) {
      on('tool.describe', ($, e, next) => continuePastUsers(e, next))
    }`,
    'helper.js': `export function continuePastUsers(e, next) { return e.pass ? next(e) : next.to(e, 'append') }`,
  })
  const result = await loadModDeclaration(input)
  expect(result.events).toEqual(['tool.describe'])
  expect(result.nextTiers).toEqual(['append'])
})

test('enforces lexical and realpath containment for entrypoints and relative imports', async () => {
  const outside = await plugin({ 'main.ts': 'export function register(on) {}' })
  const input = await plugin({
    'main.ts': `import './escape.ts'; export function register(on) {}`,
    'inside.ts': 'export function register(on) {}',
  })
  await symlink(outside.entrypoints[0]!, join(input.pluginRoot, 'escape.ts'))
  await symlink(join(input.pluginRoot, 'inside.ts'), join(input.pluginRoot, 'safe.ts'))
  await expect(loadModDeclaration(input)).rejects.toThrow('realpath is outside')
  await expect(loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'escape.ts')] })).rejects.toThrow('realpath is outside')
  await expect(loadModDeclaration({ ...input, entrypoints: outside.entrypoints })).rejects.toThrow('outside plugin root')
  await expect(loadModDeclaration({ ...input, entrypoints: ['inside.ts'] })).rejects.toThrow('absolute')
  expect((await loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'safe.ts')] })).modules).toHaveLength(1)
  await writeFile(input.entrypoints[0]!, `import '../${outside.pluginRoot.split('/').at(-1)}/main.ts'; export function register(on) {}`)
  await expect(loadModDeclaration(input)).rejects.toThrow('outside plugin root')
  await mkdir(join(input.pluginRoot, 'directory.ts'))
  await expect(loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'directory.ts')] })).rejects.toThrow('regular file')
})

test('enforces 1 MiB per file, 512 modules, and 8 MiB per graph', async () => {
  const source = 'export function register(on) {}'
  const oversized = await plugin({ 'main.ts': source + ' '.repeat(1024 * 1024) })
  await expect(loadModDeclaration(oversized)).rejects.toThrow('1 MiB')
  await writeFile(oversized.entrypoints[0]!, source.padEnd(1024 * 1024, ' '))
  expect((await loadModDeclaration(oversized)).modules).toHaveLength(1)

  const files: Record<string, string> = { 'main.ts': source }
  for (let i = 0; i < 512; i++) {
    files['main.ts'] += `;import './module-${i}.js'`
    files[`module-${i}.js`] = 'export const value = 1'
  }
  const count = await plugin(files)
  await expect(loadModDeclaration(count)).rejects.toThrow('512 files')
  await writeFile(count.entrypoints[0]!, files['main.ts']!.replace(";import './module-511.js'", ''))
  expect((await loadModDeclaration(count)).modules).toHaveLength(512)

  const large = await plugin({
    'main.ts': source + Array.from({ length: 8 }, (_, i) => `;import './large-${i}.js'`).join(''),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`large-${i}.js`, 'export {};'.padEnd(1024 * 1024, ' ')])),
  })
  await expect(loadModDeclaration(large)).rejects.toThrow('8 MiB')
}, 20_000)

test('fingerprint follows snapshot content, relative graph paths, options and tier, not installation identity', async () => {
  const files = {
    'main.ts': `import { value } from './helper.js'; export function register(on) { on('session.start', ($, e, next) => next({ value })) }`,
    'helper.js': 'export const value = 1',
  }
  const first = await plugin(files)
  const second = await plugin(files)
  const options = { a: 1, nested: { b: 2, a: 3 } }
  const original = await loadModDeclaration({ ...first, options })
  const moved = await loadModDeclaration({ ...second, name: 'renamed', storageId: 'elsewhere', options: { nested: { a: 3, b: 2 }, a: 1 } })
  expect(moved.fingerprint).toBe(original.fingerprint)
  options.nested.a = 9
  expect(original.options).toEqual({ a: 1, nested: { a: 3, b: 2 } })
  expect((await loadModDeclaration({ ...first, options })).fingerprint).not.toBe(original.fingerprint)
  expect((await loadModDeclaration({ ...first, options: original.options, tier: 'append' })).fingerprint).not.toBe(original.fingerprint)
  await writeFile(join(first.pluginRoot, 'helper.js'), 'export const value = 2')
  expect(original.modules.find(module => module.path.endsWith('helper.js'))?.source).toContain('value = 1')
  expect((await loadModDeclaration({ ...first, options: original.options })).fingerprint).not.toBe(original.fingerprint)
  await writeFile(join(second.pluginRoot, 'unused.js'), 'export const value = 99')
  expect((await loadModDeclaration({ ...second, options: original.options })).fingerprint).toBe(original.fingerprint)
})

test('fingerprint can exclude sensitive options while preserving runtime options', async () => {
  const input = await plugin({
    'main.ts': 'export function register(on, options) { on("tool.call", () => options.token) }',
  })
  const first = await loadModDeclaration({
    ...input,
    options: { mode: 'safe', token: 'offline-secret-one' },
    fingerprintOptions: { mode: 'safe' },
  })
  const second = await loadModDeclaration({
    ...input,
    options: { mode: 'safe', token: 'offline-secret-two' },
    fingerprintOptions: { mode: 'safe' },
  })

  expect(first.options).toEqual({ mode: 'safe', token: 'offline-secret-one' })
  expect(second.options).toEqual({ mode: 'safe', token: 'offline-secret-two' })
  expect(second.fingerprint).toBe(first.fingerprint)
})

test('supports all slice events, clock methods, multiple entrypoints and async ordinary helpers', async () => {
  const input = await plugin({
    'main.ts': `import { calculate } from './helper.mjs'
      export function register(on) {
        on('engine.create', ($, e, next) => next(e))
        on('plugin.register', ($, e, next) => next(e))
        on('session.start', async ($, e, next) => {
          await calculate()
          await $.clock.now(); await $.clock.sleep(1)
          await $.clock.after(1, () => {}); await $.clock.every(1, () => {})
          return next(e)
        })
        on('clock.now', ($, e, next) => next(e))
        on('clock.sleep', ($, e, next) => next(e))
        on('clock.after', ($, e, next) => next(e))
        on('clock.every', ($, e, next) => next(e))
      }`,
    'helper.mjs': 'export async function calculate() { await Promise.resolve(); return 1 }',
    'other.mts': `export const register = on => { on('tool.call', { enabled: true, count: -1, absent: null }, ($, e, next) => next(e)) }`,
  })
  const result = await loadModDeclaration({ ...input, entrypoints: [...input.entrypoints, join(input.pluginRoot, 'other.mts')] })
  expect(result.events).toEqual(['engine.create', 'plugin.register', 'session.start', 'clock.now', 'clock.sleep', 'clock.after', 'clock.every', 'tool.call'])
  expect(result.calls).toEqual(['clock.after', 'clock.every', 'clock.now', 'clock.sleep'])
  expect(result.modules).toHaveLength(3)
})

test('fingerprint is independent of erased TS annotations and comments, but preserves entrypoint order and graph paths', async () => {
  const input = await plugin({
    'main.ts': `export function register(on: Function) { on('tool.call', () => ({ result: 1 })) }`,
    'second.ts': 'export function register(on) {}',
  })
  const original = await loadModDeclaration(input)
  await writeFile(input.entrypoints[0]!, `// comment\nexport function register(on: any) { on('tool.call', () => ({ result: 1 })) }`)
  expect((await loadModDeclaration(input)).fingerprint).toBe(original.fingerprint)
  const entries = [...input.entrypoints, join(input.pluginRoot, 'second.ts')]
  expect((await loadModDeclaration({ ...input, entrypoints: entries })).fingerprint).not.toBe((await loadModDeclaration({ ...input, entrypoints: entries.toReversed() })).fingerprint)
  await writeFile(join(input.pluginRoot, 'renamed.ts'), `export function register(on: Function) { on('tool.call', () => ({ result: 1 })) }`)
  expect((await loadModDeclaration({ ...input, entrypoints: [join(input.pluginRoot, 'renamed.ts')] })).fingerprint).not.toBe(original.fingerprint)
})

test('rejects malformed options instead of silently changing their identity', async () => {
  const input = await plugin({ 'main.ts': 'export function register(on) {}' })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const options of [{ invalid: undefined }, { invalid: Infinity }, { invalid: 1n }, { invalid: new Date() }, cyclic]) {
    await expect(loadModDeclaration({ ...input, options })).rejects.toThrow('options')
  }
})

test('checks imported source for dynamic import and for-await, not just entrypoints', async () => {
  const input = await plugin({
    'main.ts': `import './helper.js'; export function register(on) {}`,
    'helper.js': `export const run = () => import('./other.js')`,
  })
  await expect(loadModDeclaration(input)).rejects.toThrow('dynamic import')
  await writeFile(join(input.pluginRoot, 'helper.js'), 'for await (const item of []) {}')
  await expect(loadModDeclaration(input)).rejects.toThrow('top-level await')
})

test('rejects escaping directory symlinks and unsupported relative module formats', async () => {
  const outside = await plugin({ 'helper.ts': 'export const value = 1' })
  const input = await plugin({ 'main.ts': `import './linked/helper.ts'; export function register(on) {}` })
  await symlink(outside.pluginRoot, join(input.pluginRoot, 'linked'))
  await expect(loadModDeclaration(input)).rejects.toThrow('realpath is outside')
  await writeFile(input.entrypoints[0]!, `import './data.json'; export function register(on) {}`)
  await writeFile(join(input.pluginRoot, 'data.json'), '{}')
  await expect(loadModDeclaration(input)).rejects.toThrow('TS/JS ESM')
  await writeFile(input.entrypoints[0]!, `import './missing.ts'; export function register(on) {}`)
  await expect(loadModDeclaration(input)).rejects.toThrow('cannot resolve relative import')
})

test('snapshots a TS entrypoint and collects literal registrations and capabilities', async () => {
  const input = await plugin({
    'main.ts': `export function register(subscribe: Function, options: object) {
      subscribe('tool.call', { tool: 'Bash' }, async (engine, input, proceed) => {
        await engine.clock.now({})
        return proceed.to(input, 'core')
      })
    }`,
  })
  const declaration = await loadModDeclaration({ ...input, tier: 'prepend', options: { enabled: true } })
  expect(declaration.events).toEqual(['tool.call'])
  expect(declaration.calls).toEqual(['clock.now'])
  expect(declaration.nextTiers).toEqual(['core'])
  expect(declaration.modules).toHaveLength(1)
  expect(declaration.modules[0]?.path).toBe(input.entrypoints[0])
  expect(declaration.modules[0]?.source).not.toContain(': Function')
  expect(declaration.options).toEqual({ enabled: true })
  expect(declaration.tier).toBe('prepend')
  expect(declaration.fingerprint).toMatch(/^[a-f0-9]{64}$/)
})

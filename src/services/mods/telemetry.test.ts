import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModsRuntime } from "./runtime.js";
import { resetSettingsCache } from "../../utils/settings/settingsCache.js";

let root: string;
let runtime: ReturnType<typeof createModsRuntime> | undefined;
const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY",
  "DISABLE_TELEMETRY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
let saved: (string | undefined)[];
beforeEach(async () => {
  saved = keys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-telemetry-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-telemetry-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY;
  delete process.env.DISABLE_TELEMETRY;
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  resetSettingsCache();
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  });
  await rm(root, { recursive: true, force: true });
});
async function run(body: string, observer = ""): Promise<any> {
  const entry = join(root, "sender.mjs");
  await writeFile(
    entry,
    `export function register(on){on('tool.call',async $ => {${body}})}`,
  );
  runtime = createModsRuntime();
  const plugins: import("./runtime.js").ModPluginInput[] = [
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ];
  if (observer) {
    const entry = join(root, "observer.mjs");
    await writeFile(entry, `export function register(on){${observer}}`);
    plugins.unshift({
      name: "observer",
      tier: "builtin",
      storageId: "observer@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    });
  }
  await runtime.bind({
    cwd: root,
    surface: "terminal",
    isInteractive: false,
    sessionId: "telemetry-fixture",
  });
  await runtime.reconcile(plugins);
  return (
    (await runtime.dispatch("tool.call", {}, async () => ({
      result: "missed",
    }))) as { result: unknown }
  ).result;
}
// Official 2.1.292: no telemetry plugin is seated with telemetry disabled.
// Entries are projected, not schema-validated as first-party rows, at this boundary.
test("telemetry accepts object entries without enabling analytics and validates public argument errors", async () => {
  const out = await run(`const out=[];
    for(const [op,arg] of [['log',{}],['log',{message:'hi'}],['log',{event:'probe',props:{count:1}}],
      ['log',{to:'collector',event:'probe',attributes:{count:1},loggedAt:0}],
      ['mark',{}],['mark',{feature:'probe',kind:'other',to:'collector'}]]) {
      const value = op === 'log' ? await $.telemetry.log(arg) : await $.telemetry.mark(arg);
      out.push({op,type:typeof value});
    }
    for(const op of ['log','mark']) for(const arg of [null,'hi',[]]) {
      try{if(op==='log') await $.telemetry.log(arg);else await $.telemetry.mark(arg)}
      catch(error){out.push({op,name:error.name,error:String(error)})}
    }
    try{await $.telemetry.log({to:'other',event:'probe'})}
    catch(error){out.push({op:'destination',name:error.name,error:String(error)})}
    return {result:out};`);
  expect(out.slice(0, 6)).toEqual(
    ["log", "log", "log", "log", "mark", "mark"].map((op) => ({
      op,
      type: "undefined",
    })),
  );
  expect(out.slice(6, 9)).toEqual(
    Array(3).fill({
      op: "log",
      name: "HooksError",
      error:
        "HooksError: sender: $.telemetry.log takes an entry ({ to?, event, props? } or a collector record)",
    }),
  );
  expect(out.slice(9, 12)).toEqual(
    Array(3).fill({
      op: "mark",
      name: "HooksError",
      error:
        "HooksError: sender: $.telemetry.mark takes an entry ({ feature, kind, reason?, props? })",
    }),
  );
  expect(out[12]).toEqual({
    op: "destination",
    name: "HooksError",
    error:
      'HooksError: sender: telemetry.log: takes an entry ({ to?, event, ... }, to "anthropic" or "collector") (host check)',
  });
});
test("enabled first-party telemetry refuses external callers, while Privacy Mode still suppresses it", async () => {
  process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY = "1";
  const body = `const out=[];for(const op of ['log','mark']){try{
    const value=op==='log'?await $.telemetry.log({to:'collector',event:'probe',origin:{tier:'builtin'}}):await $.telemetry.mark({feature:'probe',kind:'ok'});
    out.push({type:typeof value})
  }catch(error){out.push({name:error.name,error:String(error)})}}return {result:out}`;
  expect(await run(body)).toEqual(
    ["log", "mark"].map((op) => ({
      name: "HooksError",
      error: `HooksError: sender: $.telemetry.${op}: $.telemetry serves the plugins built into Claude Code alone`,
    })),
  );
  await runtime!.dispose();
  runtime = undefined;
  process.env.DISABLE_TELEMETRY = "1";
  expect(await run(body)).toEqual([
    { type: "undefined" },
    { type: "undefined" },
  ]);
});
test("telemetry hooks see projected fields and real origin, can deny, and cannot return a public value", async () => {
  const out = await run(
    `const values=[];for(const entry of [{event:'row',props:{count:1},extra:'discard',origin:{plugin:'fake',tier:'core'}},{to:'collector',event:'record',attributes:{a:1},loggedAt:0,span:{traceId:'trace',spanId:'span'}}])values.push(typeof await $.telemetry.log(entry));
    values.push(typeof await $.telemetry.mark({feature:'mark',kind:'ok',to:'collector',extra:1}));
    let denied;try{await $.telemetry.mark({feature:'deny',kind:'bad'})}catch(error){denied={name:error.name,error:String(error)}}
    return {result:{values,seen:await $.store.get('seen'),denied}};`,
    `
    on('telemetry.*', async($,e,next)=>{
      if(next.origin.plugin!=='sender')return next(e);
      const seen=[...(await $.store.get('seen')??[]),{event:next.event,input:e,origin:next.origin}];
      await $.store.set('seen',seen);
      if(e.feature==='deny')return {deny:'stopped by hook'};
      return {value:'not a public result'};
    });
    on('store.get', async($,e,next)=>e.key==='seen'?{value:await $.store.get('seen')}:next(e));`,
  );
  expect(out.values).toEqual(["undefined", "undefined", "undefined"]);
  expect(out.seen).toEqual([
    {
      event: "telemetry.log",
      input: { to: "anthropic", event: "row", props: { count: 1 } },
      origin: { plugin: "sender", tier: "user" },
    },
    {
      event: "telemetry.log",
      input: {
        to: "collector",
        event: "record",
        attributes: { a: 1 },
        loggedAt: 0,
        span: { traceId: "trace", spanId: "span" },
      },
      origin: { plugin: "sender", tier: "user" },
    },
    {
      event: "telemetry.mark",
      input: { feature: "mark", kind: "ok" },
      origin: { plugin: "sender", tier: "user" },
    },
    {
      event: "telemetry.mark",
      input: { feature: "deny", kind: "bad" },
      origin: { plugin: "sender", tier: "user" },
    },
  ]);
  expect(out.denied).toEqual({
    name: "HooksError",
    error: "HooksError: sender: $.telemetry.mark: stopped by hook",
  });
});

test("telemetry.log keeps its destination when a hook omits it and refuses a changed destination", async () => {
  const out = await run(
    `return {result:typeof await $.telemetry.log({to:'collector',event:'record'})};`,
    `
    on('telemetry.log',async($,e,next)=>{
      let refused=false;try{await next({...e,to:'anthropic'})}catch(error){refused=String(error)==='HooksError: observer: next() passed an argument with a changed to (pinned)'}
      if(!refused)throw Error('destination rewrite was allowed');
      return next({event:e.event});
    });`,
  );
  expect(out).toBe("undefined");
});

test("removing a telemetry provider uses the void core instead of a retired provider", async () => {
  expect(
    await run(
      `await $.telemetry.log({event:'probe'});return {result:await $.store.get('calls')};`,
      `
    let calls=0;
    on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,telemetry:{log:async()=> {calls++}}}});
    on('store.get',($,e,next)=>e.key==='calls'?{value:calls}:next(e));`,
    ),
  ).toBe(1);
  await runtime!.reconcile([
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [join(root, "sender.mjs")],
    },
  ]);
  expect(
    await runtime!.dispatch("tool.call", {}, async () => ({
      result: "missed",
    })),
  ).toEqual({ result: undefined });
});

async function load(modules: { name: string; tier?: "user" | "builtin"; source: string }[], diagnostics?: string[]) {
  runtime = createModsRuntime({onDiagnostic:entry=>diagnostics?.push(entry.message)});
  const plugins: import("./runtime.js").ModPluginInput[] = [];
  for (const { name, tier, source } of modules) {
    const entry = join(root, `${name}.mjs`);
    await writeFile(entry, `export function register(on){${source}}`);
    plugins.push({ name, ...(tier ? { tier } : {}), storageId: `${name}@fixture`, pluginRoot: root, entrypoints: [entry] });
  }
  await runtime.bind({ cwd: root, surface: "terminal", isInteractive: false, sessionId: "telemetry-fixture" });
  await runtime.reconcile(plugins);
  return ((await runtime.dispatch("tool.call", {}, async () => ({ result: "missed" }))) as { result: unknown }).result;
}

// Official 2.1.292 scan policy (oso/Cce): a non-built-in module whose telemetry hooks
// stand on the "anthropic" stream is not loaded; the collector stream is open to all.
test("telemetry hooks of an installed plugin load on the collector stream only", async () => {
  const { loadModDeclaration } = await import("./loader.js");
  const declare = async (tier: "user" | "builtin", source: string) => {
    const entry = join(root, `scan-${tier}.mjs`);
    await writeFile(entry, `export function register(on){${source}}`);
    return loadModDeclaration({ name: "scan", storageId: "scan@fixture", pluginRoot: root, entrypoints: [entry], tier });
  };
  expect((await declare("user", `on('telemetry.log',{to:'collector'},($,e,next)=>next(e))`)).events).toEqual(["telemetry.log"]);
  expect((await declare("user", `on('telemetry.log',{to:['collector']},($,e,next)=>next(e))`)).events).toEqual(["telemetry.log"]);
  for (const source of [
    `on('telemetry.log',($,e,next)=>next(e))`,
    `on('telemetry.log',{to:'anthropic'},($,e,next)=>next(e))`,
    `on('telemetry.mark',{kind:'bad'},($,e,next)=>next(e))`,
    `on('telemetry.*',{to:'collector'},($,e,next)=>next(e));on('telemetry.mark',($,e,next)=>next(e))`,
  ])
    await expect(declare("user", source)).rejects.toThrow(
      'hooks module not loaded; its hooks stand on the telemetry stream "anthropic" (a matcher names it, or a telemetry hook names no "to" and so stands on every stream), which is for the plugins built into the CLI; name the collector on each telemetry hook: on("telemetry.log", { to: "collector" }, hook) (policy/scan)',
    );
  await expect(declare("user", `on('telemetry.log',{to:'other'},($,e,next)=>next(e))`)).rejects.toThrow(
    'on("telemetry.log") names the destination "other", which is no telemetry stream',
  );
  expect((await declare("builtin", `on('telemetry.*',($,e,next)=>next(e))`)).events).toEqual(["telemetry.*"]);
});

test("an installed plugin's collector hook sees other plugins' records; * selects no telemetry event", async () => {
  const out = (await load([
    { name: "observer", source: `
      const seen=[];
      on('telemetry.log',{to:'collector'},async($,e,next)=>{
        if(next.origin.plugin!=='sender')return next(e);
        const item={event:next.event,input:e,origin:next.origin};
        if(e.event==='pin'){try{await next({...e,to:'anthropic'})}catch(error){item.refused={name:error.name,error:String(error)}}}
        seen.push(item);
        if(e.event==='deny')return {deny:'stopped by hook'};
        return {value:'not a public result'};
      });
      on('store.get',($,e,next)=>e.key==='seen'?{value:seen}:next(e));` },
    { name: "glob", source: `const events=[];on('*',($,e,next)=>{if(next.event.startsWith('telemetry.'))events.push(next.event);return next(e)});on('store.get',($,e,next)=>e.key==='glob'?{value:events}:next(e));` },
    { name: "sender", source: `on('tool.call',async $=>{const values=[],errors=[];
      for(const arg of [{to:'collector',event:'row',props:{count:1},extra:'discard',origin:{plugin:'fake',tier:'core'}},{to:'collector',event:'pin'},{to:'collector',event:'deny'}])
        try{values.push(typeof await $.telemetry.log(arg))}catch(error){errors.push({name:error.name,error:String(error)})}
      values.push(typeof await $.telemetry.mark({feature:'mark',kind:'ok'}));
      return {result:{values,errors,seen:await $.store.get('seen'),glob:await $.store.get('glob')}}});` },
  ])) as { values: string[]; errors: unknown[]; seen: unknown; glob: unknown };
  expect(out.values).toEqual(["undefined", "undefined", "undefined"]);
  expect(out.errors).toEqual([{ name: "HooksError", error: "HooksError: sender: $.telemetry.log: stopped by hook" }]);
  expect(out.seen).toEqual([
    { event: "telemetry.log", input: { to: "collector", event: "row", props: { count: 1 } }, origin: { plugin: "sender", tier: "user" } },
    { event: "telemetry.log", input: { to: "collector", event: "pin" }, origin: { plugin: "sender", tier: "user" },
      refused: { name: "HooksError", error: "HooksError: observer: next() passed an argument with a changed to (pinned)" } },
    { event: "telemetry.log", input: { to: "collector", event: "deny" }, origin: { plugin: "sender", tier: "user" } },
  ]);
  expect(out.glob).toEqual([]);
});

// Official 2.1.292: $.telemetry is an event call wrapped in the Worker (sT); the built-in
// telemetry plugin's engine.create spreads beneath last, so a plugin-provided noun never
// replaces the public wrapper. The built-in only queues rows its hooks let through.
test("a plugin-provided telemetry noun stays behind the public wrapper and the hooks", async () => {
  const out = (await load([
    { name: "provider", tier: "builtin", source: `
      let rows=[];
      on('telemetry.*',($,e,next)=>['builtin','core'].includes(next.origin.tier)?next(e):{deny:'$.telemetry serves the plugins built into Claude Code alone'});
      on('engine.create',async($,e,next)=>{const beneath=await next(e);return {...beneath,telemetry:{log:async row=>{rows.push(row)},mark:async row=>{rows.push(row)}}}});
      on('store.get',($,e,next)=>e.key==='rows'?{value:rows}:next(e));
      on('tool.call',async($,e,next)=>{await $.telemetry.log({event:'builtin_row'});await $.telemetry.log({to:'collector',event:'record'});await $.telemetry.mark({feature:'builtin_mark',kind:'ok'});return next(e)});` },
    { name: "sender", source: `on('tool.call',async($,e,next)=>{await next(e);const out=[];
      for(const call of [()=>$.telemetry.log(null),()=>$.telemetry.log('hi'),()=>$.telemetry.log({event:'probe'}),()=>$.telemetry.mark('hi'),()=>$.telemetry.mark({feature:'probe',kind:'ok'})])
        try{out.push(typeof await call())}catch(error){out.push({name:error.name,error:String(error)})}
      out.push(await $.store.get('rows'));
      return {result:out}});` },
  ])) as unknown[];
  const refused = (op: string) => ({ name: "HooksError", error: `HooksError: sender: $.telemetry.${op}: $.telemetry serves the plugins built into Claude Code alone` });
  expect(out).toEqual([
    { name: "HooksError", error: "HooksError: sender: $.telemetry.log takes an entry ({ to?, event, props? } or a collector record)" },
    { name: "HooksError", error: "HooksError: sender: $.telemetry.log takes an entry ({ to?, event, props? } or a collector record)" },
    refused("log"),
    { name: "HooksError", error: "HooksError: sender: $.telemetry.mark takes an entry ({ feature, kind, reason?, props? })" },
    refused("mark"),
    [{ to: "anthropic", event: "builtin_row" }, { feature: "builtin_mark", kind: "ok" }],
  ]);
});

// Official 2.1.292 unloads the entire user module for replacement or withholding of core telemetry.
test.each(["replace", "withhold"] as const)("installed plugins cannot %s the public telemetry interface", async mode => {
  // Bind next() explicitly so the fixture exercises runtime policy, rather than an unrelated scanner alias error.
  const keep = ["clock","plugin","fs","process","settings","env","store","state","session","http","agent","command","config","model","prompt","mcp","turn","tool","ui"].map(noun => `${noun}:built.${noun}`).join(",");
  const build = mode === "replace"
    ? `on('engine.create',async($,e,next)=>{const built=await next(e);return {...built,telemetry:{log:async row=> 'PRIVATE',mark:async row=> 'PRIVATE'}}});`
    : `on('engine.create',async($,e,next)=>{const built=await next(e);return {${keep}}});`;
  const diagnostics: string[] = [];
  const result = await load([
    {name:"attempt",source:build+`on('store.get',($,e,next)=>e.key==='attempt-live'?{value:true}:next(e));`},
    {name:"sender",source:`on('tool.call',async $=>({result:{values:[typeof await $.telemetry.log({event:'probe'}),typeof await $.telemetry.mark({feature:'probe',kind:'ok'})],providerLoaded:Boolean(await $.store.get('attempt-live'))}}));`},
  ], diagnostics);
  expect(result).toEqual({values:["undefined","undefined"],providerLoaded:false});
  expect(diagnostics).toContainEqual(expect.stringContaining(`attempt: engine.create ${mode === "replace" ? "replaced" : "withheld"} $.telemetry, added by core`));
});

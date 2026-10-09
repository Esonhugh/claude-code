import { afterEach, expect, test } from "bun:test";
import { createModEnvironmentHost } from "./environment.js";
import type { ModDeclaration } from "./types.js";
const hosts: ReturnType<typeof createModEnvironmentHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});
function declaration(source: string): ModDeclaration {
  return {
    name: "timer-fixture",
    storageId: "timer-fixture@local",
    pluginRoot: "/timer-fixture",
    entrypoints: ["/timer-fixture/register.js"],
    modules: [{ path: "/timer-fixture/register.js", source }],
    links: [],
    events: ["tool.call"],
    calls: [],
    nextTiers: [],
    options: {},
    tier: "user",
    fingerprint: source,
  };
}
async function load(
  source: string,
  options: Parameters<typeof createModEnvironmentHost>[0] = {},
) {
  const host = createModEnvironmentHost(options);
  hosts.push(host);
  const environment = await host.load(declaration(source));
  return {
    host,
    environment,
    invoke: (args: unknown[] = []) =>
      environment.invoke(environment.registrations[0]!.id, args),
  };
}
test("VM exposes the four official timer globals and numeric environment-local handles", async () => {
  const { invoke } = await load(
    `export function register(on){on('tool.call',()=>{const names=['setTimeout','clearTimeout','setInterval','clearInterval'];const types=names.map(name=>typeof globalThis[name]);if(types.some(type=>type!=='function'))return {types};const first=setTimeout(()=>{},10000),second=setInterval(()=>{},10000);clearInterval(first);clearTimeout(second);let error;try{setTimeout('no',1)}catch(e){error={name:e.name,message:e.message}}let blocked=false;try{setTimeout.constructor('return process')()}catch{blocked=true}return {types,handles:[first,second],clear:typeof clearTimeout(second),error,blocked,extra:[typeof setImmediate,typeof queueMicrotask]}})}`,
  );
  expect(await invoke()).toEqual({
    types: ["function", "function", "function", "function"],
    handles: [1, 2],
    clear: "undefined",
    error: {
      name: "HooksError",
      message: "timer-fixture: setTimeout takes a function",
    },
    blocked: true,
    extra: ["undefined", "undefined"],
  });
});
test("real timer callbacks receive extra arguments, repeat and support cross cancellation", async () => {
  const { invoke } = await load(
    `export function register(on){on('tool.call',async()=>{const args=await new Promise(resolve=>setTimeout((...args)=>resolve(args),0,'one',2,{three:3}));let count=0;const interval=await new Promise(resolve=>{const id=setInterval(arg=>{if(++count===3){clearTimeout(id);resolve({count,arg})}},0,'intervalArg')});let cancelled=false;const id=setTimeout(()=>{cancelled=true},0);clearInterval(id);await new Promise(resolve=>setTimeout(resolve,0));return {args,interval,cancelled}})}`,
  );
  expect(await invoke()).toEqual({
    args: ["one", 2, { three: 3 }],
    interval: { count: 3, arg: "intervalArg" },
    cancelled: false,
  });
});
test.each(["throw", "reject"])(
  "timer callback %s is attributed without killing the shared Worker",
  async (mode) => {
    const reported = Promise.withResolvers<{
      error: Error;
      environment: number;
    }>();
    const { host, environment, invoke } = await load(
      `export function register(on){on('tool.call',()=>{setTimeout(${mode === "reject" ? "async " : ""}()=>{throw Error('timer failed')},0);return {ready:true}})}`,
      {
        onError: (error, environment) =>
          reported.resolve({ error, environment }),
      },
    );
    expect(await invoke()).toEqual({ ready: true });
    const failure = await reported.promise;
    expect(failure.environment).toBe(environment.id);
    expect(failure.error.message).toContain(
      "setTimeout: the callback threw: Error: timer failed",
    );
    const survivor = await host.load({
      ...declaration(
        `export function register(on){on('tool.call',()=>({alive:true}))}`,
      ),
      name: "survivor",
      storageId: "survivor@local",
    });
    expect(await survivor.invoke(survivor.registrations[0]!.id, [])).toEqual({
      alive: true,
    });
  },
);

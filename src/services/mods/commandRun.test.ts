import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModsRuntime, type ModHostServices } from "./runtime.js";
let root: string;
let runtime: ReturnType<typeof createModsRuntime> | undefined;
const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
let saved: (string | undefined)[];
beforeEach(async () => {
  saved = keys.map((k) => process.env[k]);
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-cmd-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-command-run-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  keys.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  await rm(root, { recursive: true, force: true });
});
async function run(
  body: string,
  services: ModHostServices = {},
  event = "ui.message",
) {
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `export function register(on){on('${event}',async($)=>{try{return {result:{receipt:await(async()=>{${body}})()}}}catch(e){return {result:{error:String(e),name:e.name}}}})}`,
  );
  runtime = createModsRuntime({ services });
  await runtime.bind({
    cwd: root,
    surface: "terminal",
    isInteractive: true,
    sessionId: "command-fixture",
  });
  await runtime.reconcile([
    {
      name: "runner",
      storageId: "runner@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ]);
  const out = (await runtime.dispatch(event, {}, async () => ({
    result: { missed: true },
  }))) as { result: unknown };
  return out.result;
}
test("command.run validates the official author shape and rejects unknown names", async () => {
  expect(await run(`return $.command.run({})`)).toEqual({
    name: "HooksError",
    error:
      "HooksError: runner: $.command.run takes { command, args? } (the command's name without the slash)",
  });
  await runtime!.dispose();
  runtime = undefined;
  expect(await run(`return $.command.run({command:'missing'})`)).toEqual({
    name: "HooksError",
    error:
      "HooksError: runner: $.command.run: no command named /missing in this session",
  });
});
test("command.run refuses a turn-holding hook instead of deadlocking its command queue", async () => {
  expect(
    await run(`return $.command.run({command:'hello'})`, {}, "tool.call"),
  ).toEqual({
    name: "HooksError",
    error:
      "HooksError: runner: command.run: called from a tool.call hook, it would wait on the turn this hook is holding; run it from a later event (turn.complete) (host check)",
  });
});

test("command.run canonicalizes aliases and stamps its owner, args and cancellation lifetime", async () => {
  const calls: unknown[] = [];
  const receipt = { text: "from engine", context: ["model note"], exitCode: 3 };
  const result = await run(
    `return $.command.run({command:'ALIAS',args:'raw  args',origin:{kind:'composer'},presentation:{columns:1}})`,
    {
      commands: () => [
        {
          type: "local",
          name: "fixture",
          aliases: ["alias"],
          description: "fixture",
          supportsNonInteractive: true,
          load: async () => ({ call: async () => ({ type: "skip" }) }),
        },
      ],
      commandRun: async (request) => {
        calls.push({
          command: request.command,
          args: request.args,
          origin: request.origin,
          aborted: request.signal.aborted,
        });
        return receipt;
      },
    },
  );
  expect(result).toEqual({ receipt });
  expect(calls).toEqual([
    {
      command: "fixture",
      args: "raw  args",
      origin: { kind: "plugin", name: "runner" },
      aborted: false,
    },
  ]);
});

test("command.run from a startup clock callback finds a command another plugin registered in session.start", async () => {
  const dir = async (name: string, body: string) => {
    const entry = join(root, `${name}.mjs`);
    await writeFile(entry, `export function register(on){${body}}`);
    return { name, storageId: `${name}@fixture`, pluginRoot: root, entrypoints: [entry] };
  };
  const sender = await dir(
    "sender",
    `on('session.start',async($,e,next)=>{$.clock.after(0,async()=>{let out;try{out={receipt:await $.command.run({command:'hello',args:'queued'})}}catch(error){out={error:String(error)}}await $.ui.log(JSON.stringify(out))});return next(e)})`,
  );
  const provider = await dir(
    "provider",
    `on('session.start',async($,e,next)=>{await $.command.register({name:'hello',description:'command fixture'});return next(e)})`,
  );
  let logged!: (text: string) => void;
  const log = new Promise<string>((resolve) => {
    logged = resolve;
  });
  const requests: unknown[] = [];
  runtime = createModsRuntime({
    services: {
      commands: () => [],
      uiLog: (_plugin, text) => logged(text),
      commandRun: async (request) => {
        requests.push({ command: request.command, args: request.args, origin: request.origin });
        return { text: "ran" };
      },
    },
  });
  await runtime.bind({ cwd: root, surface: "terminal", isInteractive: true, sessionId: "command-startup" });
  await runtime.reconcile([sender, provider]);
  expect(JSON.parse(await log)).toEqual({ receipt: { text: "ran" } });
  expect(requests).toEqual([
    { command: "hello", args: "queued", origin: { kind: "plugin", name: "sender" } },
  ]);
});

test("command.run from turn.complete lets the turn end so the queued command can run", async () => {
  const entry = join(root, "complete.mjs");
  await writeFile(
    entry,
    `export function register(on){
      on('session.start',async($,e,next)=>{await $.command.register({name:'hello',description:'command fixture'});return next(e)});
      on('turn.complete',async($,e,next)=>{const receipt=await $.command.run({command:'hello',args:'queued'});await $.ui.log(JSON.stringify(receipt));return next(e)});
    }`,
  );
  const queue: Array<() => void> = [];
  const logs: string[] = [];
  runtime = createModsRuntime({
    services: {
      commands: () => [],
      uiLog: (_plugin, text) => logs.push(text),
      // Like the host message queue: the command only runs once the current turn has ended.
      commandRun: () => new Promise((resolve) => queue.push(() => resolve({ text: "ran", exitCode: 7 }))),
    },
  });
  await runtime.bind({ cwd: root, surface: "terminal", isInteractive: true, sessionId: "command-complete" });
  await runtime.reconcile([{ name: "complete", storageId: "complete@fixture", pluginRoot: root, entrypoints: [entry] }]);
  const release = runtime.beginPublicTurn("turn-1");
  const turn = runtime.currentTurn()!;
  expect(await turn.finish({ aborted: false, failed: false })).toBeUndefined();
  release();
  expect(queue).toHaveLength(1);
  const settled = runtime.settleTurns();
  queue.shift()!();
  await settled;
  expect(logs.map((text) => JSON.parse(text))).toEqual([{ text: "ran", exitCode: 7 }]);
});

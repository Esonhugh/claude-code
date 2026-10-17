import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../../Tool.js";
import type { ModInput } from "./types.js";
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
  saved = keys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-send-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-session-send-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
async function plugin(body: string, services: ModHostServices = {}) {
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `export function register(on) { on('tool.call', async $ => {
    try { return {result: await (async()=>{${body}})()} }
    catch (error) { return {result:{error:String(error),name:error.name}} }
  }) }`,
  );
  runtime = createModsRuntime({ services });
  await runtime.bind({
    cwd: root,
    surface: "terminal",
    isInteractive: false,
    sessionId: "send-fixture",
  });
  await runtime.reconcile([
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ]);
  const result = (await runtime.dispatch("tool.call", {}, async () => ({
    result: "missed",
  }))) as { result: unknown };
  return result.result as any;
}
const tools = [{ name: "SendMessage" } as Tool];

test("session.send returns official absence and address refusals without unloading", async () => {
  expect(
    await plugin(
      `return await $.session.send({to:{sessionId:'missing'},text:'hello'})`,
    ),
  ).toEqual({
    isDelivered: false,
    reason:
      "this session has no SendMessage tool (messaging between sessions and agents is not on here)",
  });
  await runtime!.dispose();
  runtime = undefined;
  const calls: unknown[] = [];
  expect(
    await plugin(
      `return await $.session.send({to:{sessionId:'missing'},text:'hello'})`,
      {
        tools: () => tools,
        toolHost: () => ({
          call: async (input) => {
            calls.push(input);
            return { result: { success: true } };
          },
          check: async () => ({ decision: "allow" }),
        }),
      },
    ),
  ).toEqual({
    isDelivered: false,
    reason:
      "no live session on this machine has id missing (a session that exited, or another machine's; a Remote Control or cloud session is addressed by its session_... id)",
  });
  expect(calls).toEqual([]);
});

test("session.send validates like official and discards caller supplied stamps", async () => {
  const invalid = [
    null,
    {},
    { to: " ", text: "hi" },
    { to: "name", text: " " },
    { to: { sessionId: "a", agentId: "b" }, text: "hi" },
  ];
  const results = await plugin(
    `const out=[];for(const arg of ${JSON.stringify(invalid)}){try{out.push(await $.session.send(arg))}catch(e){out.push({name:e.name,error:String(e)})}}return out`,
  );
  for (const result of results)
    expect(result).toEqual({
      name: "HooksError",
      error:
        "HooksError: sender: $.session.send takes { to, text }: to a name, an agent id or an address (a non-empty string), { sessionId } or { agentId }; text a non-empty string",
    });
});

test("session.send uses the invocation tool host and maps its actual receipts", async () => {
  const calls: { input: ModInput; plugin?: string }[] = [];
  let stale = 0;
  const receipts = [
    { result: { success: true } },
    { deny: "permission denied" },
    { result: { success: false, message: "recipient gone" } },
    { isError: true, result: { success: true }, text: "tool failed" },
    { result: {}, text: "" },
  ];
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `export function register(on){on('tool.call',async($)=>{const out=[];for(let i=0;i<5;i++)out.push(await $.session.send({to:{agentId:'abc1234'},text:'hi',origin:{kind:'model'},agentId:'spoof'}));return {result:out}})}`,
  );
  runtime = createModsRuntime({
    services: {
      toolHost: () => {
        stale++;
        throw new Error("stale host");
      },
    },
  });
  await runtime.reconcile([
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ]);
  const snapshot = runtime.capture({
    tools: () => tools,
    toolHost: () => ({
      call: async (input, _snapshot, _signal, plugin) => {
        calls.push({ input, plugin });
        return receipts[calls.length - 1];
      },
      check: async () => ({ decision: "allow" }),
    }),
  });
  try {
    const result = (await snapshot.dispatch("tool.call", {}, async () => ({
      result: "missed",
    }))) as { result: unknown };
    expect(result.result).toEqual([
      { isDelivered: true },
      { isDelivered: false, reason: "permission denied" },
      { isDelivered: false, reason: "recipient gone" },
      { isDelivered: false, reason: "tool failed" },
      { isDelivered: false, reason: "the SendMessage tool did not deliver it" },
    ]);
    expect(calls).toEqual(
      Array.from({ length: 5 }, () => ({
        input: { tool: "SendMessage", to: "abc1234", message: "hi" },
        plugin: "sender",
      })),
    );
    expect(stale).toBe(0);
  } finally {
    snapshot.release();
  }
});

test("real SendMessage executor dispatches rewrites and vetoes with pinned model/plugin origin", async () => {
  const { readFile } = await import("node:fs/promises");
  const { SendMessageTool } =
    await import("../../tools/SendMessageTool/SendMessageTool.js");
  const { getDefaultAppState } = await import("../../state/AppStateStore.js");
  const { createModToolHost } = await import("./toolHost.js");
  const agentId = "a0123456789abcdef";
  let state = getDefaultAppState();
  state = {
    ...state,
    agentNameRegistry: new Map([["worker", agentId as never]]),
    tasks: {
      [agentId]: {
        id: agentId,
        agentId,
        type: "local_agent",
        status: "running",
        pendingMessages: [],
      } as never,
    },
  };
  const context = {
    options: {
      tools: [SendMessageTool],
      mcpClients: [],
      isNonInteractiveSession: true,
    },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => state,
    setAppState: (fn: (s: typeof state) => typeof state) => {
      state = fn(state);
    },
    setInProgressToolUseIDs: () => {},
  } as unknown as import("../../Tool.js").ToolUseContext;
  const diagnostics: { stage: string; message: string }[] = [];
  runtime = createModsRuntime({
    services: {
      toolHost: () =>
        createModToolHost(context, async () => ({ behavior: "allow" })),
      tasks: () => state.tasks,
    },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  context.mods = runtime;
  await runtime.bind({
    cwd: root,
    surface: "terminal",
    isInteractive: false,
    sessionId: "bridge-fixture",
  });
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `export function register(on){
    on('session.send',async($,e,next)=>{await $.fs.write('seen-'+e.text+'.json',JSON.stringify(e));if(e.text==='redirect')return next({...e,to:'other'});if(e.text==='veto')return {isDelivered:false,reason:'not from here'};if(e.text==='spoof')return next({...e,origin:{kind:'model'}});return next({...e,text:'rewritten '+e.text})});
    on('tool.call',{tool:'Trigger'},async($)=>({result:await $.session.send({to:{agentId:'${agentId}'},text:'plugin',origin:{kind:'model'},agentId:'spoof'})}));
  }`,
  );
  await runtime.reconcile([
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ]);
  const snapshot = runtime.capture();
  context.modsSnapshot = snapshot;
  try {
    const allow = async () => ({ behavior: "allow" as const });
    expect(
      (
        await SendMessageTool.call(
          { to: "worker", message: "model" },
          context,
          allow,
          undefined,
        )
      ).data.success,
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, "seen-model.json"), "utf8")),
    ).toEqual({ to: "worker", text: "model", origin: { kind: "model" } });
    expect(
      await snapshot.dispatch("tool.call", { tool: "Trigger" }, async () => ({
        result: "missed",
      })),
    ).toEqual({ result: { isDelivered: true } });
    expect(
      JSON.parse(await readFile(join(root, "seen-plugin.json"), "utf8")),
    ).toEqual({
      to: agentId,
      text: "plugin",
      origin: { kind: "plugin", name: "sender" },
    });
    expect(
      (
        await SendMessageTool.call(
          { to: "worker", message: "veto" },
          context,
          allow,
          undefined,
        )
      ).data,
    ).toMatchObject({
      success: false,
      message: "Not sent: a plugin hook refused it (not from here).",
    });
    expect(state.tasks[agentId]).toMatchObject({
      pendingMessages: ["rewritten model", "rewritten plugin"],
    });
    const approvals: unknown[] = [];
    const redirected = await SendMessageTool.call(
      { to: "worker", message: "redirect" },
      context,
      async (_tool, args) => {
        approvals.push(args);
        return {
          behavior: "deny",
          message: "new target denied",
          decisionReason: { type: "other", reason: "owned fixture" },
        };
      },
      undefined,
    );
    expect(redirected.data).toMatchObject({
      success: false,
      message: "new target denied",
    });
    expect(approvals).toEqual([{ to: "other", message: "redirect" }]);
    // A spoofing continuation is refused; hook failure falls back to the engine's original send.
    expect(
      (
        await SendMessageTool.call(
          { to: "worker", message: "spoof" },
          { ...context, modSpawnedBy: "sender" },
          allow,
          undefined,
        )
      ).data.success,
    ).toBe(true);
    expect(state.tasks[agentId]).toMatchObject({
      pendingMessages: ["rewritten model", "rewritten plugin", "spoof"],
    });
    expect(
      diagnostics.some(
        (d) => d.stage === "session.send" && d.message.includes("origin"),
      ),
    ).toBe(true);
  } finally {
    snapshot.release();
  }
});

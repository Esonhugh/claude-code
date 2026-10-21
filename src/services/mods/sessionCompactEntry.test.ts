import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModsRuntime } from "./runtime.js";

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
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-compact-entry-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-compact-entry-placeholder";
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
async function run(body: string, turnId?: string) {
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `export function register(on){let compactHooks=0;
    on('session.compact',($,e,next)=>{compactHooks++;return next(e)});
    on('tool.call',async $=>{const values=[];${body};return {result:{values,compactHooks}}});}`,
  );
  runtime = createModsRuntime();
  await runtime.bind({
    cwd: root,
    surface: "terminal",
    isInteractive: false,
    sessionId: "compact-entry",
  });
  await runtime.reconcile([
    {
      name: "sender",
      storageId: "sender@fixture",
      pluginRoot: root,
      entrypoints: [entry],
    },
  ]);
  const release = turnId === undefined ? undefined : runtime.beginPublicTurn(turnId);
  try {
    return (
      (await runtime.dispatch("tool.call", {}, async () => ({
        result: "missed",
      }))) as { result: unknown }
    ).result;
  } finally {
    release?.();
  }
}
// Official 2.1.292's headless entry rejects before dispatching compaction hooks.
test("headless session.compact rejects catchably with the official error and leaves hooks active", async () => {
  expect(
    await run(`for(const args of [[],[{}],[{instructions:'keep plan'}],[{instructions:'keep plan',extra:1}],[{},{}]]){
    try{await $.session.compact(...args)}catch(error){values.push({name:error.name,error:String(error)})}
  }`),
  ).toEqual({
    values: Array(5).fill({
      name: "HooksError",
      error:
        "HooksError: sender: $.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on",
    }),
    compactHooks: 0,
  });
});
test("session.compact validates optional instructions before checking the headless host", async () => {
  expect(
    await run(`for(const arg of [null,'hi',[],{instructions:7},{instructions:false}]){
    try{await $.session.compact(arg)}catch(error){values.push({name:error.name,error:String(error)})}
  }`),
  ).toEqual({
    values: Array(5).fill({
      name: "HooksError",
      error:
        "HooksError: sender: $.session.compact takes { instructions } (a string) or nothing",
    }),
    compactHooks: 0,
  });
});

test("session.compact refuses while DISABLE_COMPACT is set, before the headless host", async () => {
  const saved = process.env.DISABLE_COMPACT;
  process.env.DISABLE_COMPACT = "1";
  try {
    expect(
      await run(`try{await $.session.compact()}catch(error){values.push({name:error.name,error:String(error)})}`),
    ).toEqual({
      values: [
        {
          name: "HooksError",
          error:
            "HooksError: sender: $.session.compact: compaction is switched off in this session (DISABLE_COMPACT), for /compact and plugins alike",
        },
      ],
      compactHooks: 0,
    });
  } finally {
    if (saved === undefined) delete process.env.DISABLE_COMPACT;
    else process.env.DISABLE_COMPACT = saved;
  }
});
test("session.compact refuses while a turn runs, naming it", async () => {
  expect(
    await run(
      `try{await $.session.compact()}catch(error){values.push({name:error.name,error:String(error)})}`,
      "turn-7",
    ),
  ).toEqual({
    values: [
      {
        name: "HooksError",
        error:
          "HooksError: sender: $.session.compact: a turn is running (turn-7); the conversation compacts between turns, so call it from turn.complete or later",
      },
    ],
    compactHooks: 0,
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModsRuntime } from "./runtime.js";

let root: string;
let runtime: ReturnType<typeof createModsRuntime> | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-submit-turn-")));
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  await rm(root, { recursive: true, force: true });
});

// Like the host queue: a submitted prompt only runs once the current turn has ended.
async function start(source: string, submitted: Array<() => void>, logs: string[]) {
  const entry = join(root, "register.mjs");
  await writeFile(entry, source);
  runtime = createModsRuntime({
    services: {
      uiLog: (_plugin, text) => logs.push(text),
      submitPrompt: (input) => new Promise((resolve) => submitted.push(() => resolve({ text: input.text }))),
    },
  });
  await runtime.bind({ cwd: root, surface: "terminal", isInteractive: true, sessionId: "submit-turn" });
  await runtime.reconcile([{ name: "submitter", storageId: "submitter@fixture", pluginRoot: root, entrypoints: [entry] }]);
  return runtime;
}

const report = "catch(error){await $.ui.log(error.message)}";

test("prompt.submit from turn.start is refused instead of waiting on the turn", async () => {
  const submitted: Array<() => void> = [];
  const logs: string[] = [];
  const value = await start(
    `export function register(on){on('turn.start',async($,e,next)=>{try{await $.prompt.submit({text:'later'})}${report};return next(e)})}`,
    submitted,
    logs,
  );
  expect(await value.dispatch("turn.start", { turnId: "t", text: "hi" }, async () => ({ turnId: "t" }))).toEqual({ turnId: "t" });
  expect(submitted).toHaveLength(0);
  expect(logs).toEqual([
    "prompt.submit called from a turn.start hook, it would wait on the turn this hook is holding; submit from a later event (turn.complete)",
  ]);
});

test("prompt.submit from turn.step is refused instead of waiting on the turn", async () => {
  const submitted: Array<() => void> = [];
  const logs: string[] = [];
  const value = await start(
    `export function register(on){on('turn.step',async function*($,e,next){try{await $.prompt.submit({text:'later'})}${report};return yield* next(e)})}`,
    submitted,
    logs,
  );
  const result = { turnId: "t", index: 0, answer: "core", toolUses: [], stopReason: "end_turn", usage: null };
  // eslint-disable-next-line require-yield -- The core finishes without chunks.
  const stream = value.stream("turn.step", { turnId: "t", index: 0, messageCount: 1, model: "fake" }, async function* () { return result });
  await Array.fromAsync(stream);
  expect(await stream.result).toEqual(result);
  expect(submitted).toHaveLength(0);
  expect(logs).toEqual([
    "prompt.submit called from a turn.step hook, it would wait on the turn this hook is holding; submit from a later event (turn.complete)",
  ]);
});

test("prompt.submit from turn.complete lets the turn end so the submitted prompt can run", async () => {
  const submitted: Array<() => void> = [];
  const logs: string[] = [];
  const value = await start(
    `export function register(on){on('turn.complete',async($,e,next)=>{await $.ui.log(JSON.stringify(await $.prompt.submit({text:'follow up'})));return next(e)})}`,
    submitted,
    logs,
  );
  const release = value.beginPublicTurn("turn-1");
  expect(await value.currentTurn()!.finish({ aborted: false, failed: false })).toBeUndefined();
  release();
  expect(submitted).toHaveLength(1);
  const settled = value.settleTurns();
  submitted.shift()!();
  await settled;
  expect(logs.map((text) => JSON.parse(text))).toEqual([{ text: "follow up" }]);
});

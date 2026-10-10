import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModCommandQueue } from "./commandRunQueue.js";
import { createModCommands } from "./commands.js";
import type { ProcessUserInputContext } from "../../utils/processUserInput/processUserInput.js";
import { processSlashCommand } from "../../utils/processUserInput/processSlashCommand.js";
import {
  getCommandQueue,
  dequeue,
  resetCommandQueue,
  clearCommandQueue,
  enqueue,
} from "../../utils/messageQueueManager.js";
let root: string;
const keys = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
let saved: (string | undefined)[];
beforeEach(async () => {
  saved = keys.map((k) => process.env[k]);
  root = await realpath(await mkdtemp(join(tmpdir(), "mods-command-queue-")));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-command-queue-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  resetCommandQueue();
});
afterEach(async () => {
  resetCommandQueue();
  keys.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  await rm(root, { recursive: true, force: true });
});
test("author command waits for actual slash execution, retaining text, context and status", async () => {
  const owner = Symbol("conversation");
  const origin = { kind: "plugin", name: "runner" } as const;
  const pending = createModCommandQueue({ owner })({
    command: "registered",
    args: "raw args",
    origin,
    signal: new AbortController().signal,
  });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  const queued = dequeue((item) => item.promptSubmitOwner === owner)!;
  expect(queued.value).toBe("/registered raw args");
  expect(queued.promptSubmitMetadata?.origin).toEqual(origin);
  const commands = createModCommands({
    getBuiltinCommands: () => [],
    run: async (name, args, context) => {
      expect([name, args, context.modCommand?.origin]).toEqual([
        "registered",
        "raw args",
        origin,
      ]);
      return { text: "executed", context: ["hidden", "hidden"], exitCode: 7 };
    },
  });
  const activation = {};
  commands.register(activation, { name: "registered", description: "fixture" });
  commands.commit(activation);
  const context = {
    options: {
      commands: commands.list(),
      tools: [],
      isNonInteractiveSession: true,
      mcpResources: {},
    },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      sessionState: { sessionHooks: {} },
      fileHistory: { snapshots: [] },
    }),
    setAppState() {},
    modCommand: { origin, presentation: { isFullscreen: false, columns: 91 } },
  } as unknown as ProcessUserInputContext;
  const result = await processSlashCommand(
    queued.value as string,
    [],
    [],
    [],
    context,
    () => {},
  );
  queued.commandRunReceipt!.admit(result);
  expect(await pending).toEqual({
    text: "executed",
    context: ["hidden", "hidden"],
    exitCode: 7,
  });
  expect(settled).toBe(true);
});
test("cancellation removes only this command and queue clearing rejects its receipt", async () => {
  enqueue({ value: "user input", mode: "prompt" });
  const controller = new AbortController();
  const reason = new Error("author cancelled");
  const pending = createModCommandQueue()({
    command: "hello",
    args: "",
    origin: { kind: "plugin", name: "runner" },
    signal: controller.signal,
  });
  const rejected = pending.catch((error) => {
    expect(error).toBe(reason);
  });
  controller.abort(reason);
  await rejected;
  expect(getCommandQueue().map((item) => item.value)).toEqual(["user input"]);
  const cleared = createModCommandQueue()({
    command: "hello",
    args: "",
    origin: { kind: "plugin", name: "runner" },
    signal: new AbortController().signal,
  });
  const cancelled = cleared.catch((error) => {
    expect(error).toBeInstanceOf(Error);
  });
  clearCommandQueue();
  await cancelled;
  expect(getCommandQueue()).toHaveLength(0);
});

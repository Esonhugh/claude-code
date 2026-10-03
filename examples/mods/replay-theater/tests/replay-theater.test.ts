// tests/replay-theater.test.ts
import { describe, expect, test } from "claude-code/testing";

const PANE_PROPS = { title: "Replay Theater", isFocused: true, bodyColumns: 80, placement: "inline" };
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 };

// Hooks registered here run after the mod and stub what Claude Code would answer.
function world(on: any) {
  const opened: string[] = [];
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  on("command.register", ($: any, e: any) => ({ value: { command: e.name } }));
  on("turn.start", ($: any, e: any) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("fs.read", () => ({ value: "export function greet() {}\n" }));
  on("tool.call", () => ({ result: { type: "update" } }));
  on("ui.open", ($: any, e: any) => {
    opened.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({})); // what Claude Code draws when the mod yields
  return opened;
}

const replay = (command: any) => command.run({ command: "replay", args: "", origin: { kind: "composer" } } as any);

describe("replay-theater", () => {
  test("/replay with no edits says so and opens nothing", async ($, on) => {
    const opened = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const { text } = await replay($.command);
    expect(text).toBe("No edits");
    expect(opened).toEqual([]);
  });

  test("a turn's edits become one replay, stepped through in a pane", async ($, on) => {
    const opened = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.turn.start({ text: "rename greet to welcome", turnId: "t1" } as any);
    await $.tool.call({ tool: "Edit", file_path: "/work/a.js", old_string: "greet()", new_string: "welcome()" } as any);
    await $.tool.call({ tool: "Write", file_path: "/work/b.js", content: "export function welcome() {}\n" } as any);
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1 } as any);

    const band = await $.ui.mount({ plugin: "replay-theater", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS } as any);
    expect(await band.find({ type: "Text", text: /2 edits across 2 files/ })).toBeDefined();

    const { text } = await replay($.command);
    expect(text).toBe("Replaying");
    expect(opened).toEqual(["replay-theater"]);
    expect(await band.find({ type: "Text", text: /2 edits/ })).toBeUndefined();

    const pane = await $.ui.mount({ plugin: "replay-theater", surface: "terminal", component: "Pane", requestId: "replay-theater", props: PANE_PROPS } as any);
    expect(await pane.find({ type: "Text", text: /1\/2 {2}\/work\/a\.js/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /^\+ welcome\(\)$/ })).toBeDefined();
    await pane.press({ key: "next" });
    expect(await pane.find({ type: "Text", text: /2\/2 {2}\/work\/b\.js/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /^- export function greet\(\) \{\}$/ })).toBeDefined();
    await pane.unmount();
    await band.unmount();
  });

  test("subagent turns neither reset nor close the main turn's replay", async ($, on) => {
    world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    await $.turn.start({ text: "edit", turnId: "t1" } as any);
    await $.tool.call({ tool: "Edit", file_path: "/work/a.js", old_string: "a", new_string: "b" } as any);
    await $.turn.start({ text: "subtask", turnId: "t2", agentId: "sub-1" } as any);
    await $.turn.complete({ reason: "answer", answer: "done", durationMs: 1, agentId: "sub-1" } as any);
    const band = await $.ui.mount({ plugin: "replay-theater", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS } as any);
    expect(await band.find({ type: "Text", text: /edit/ })).toBeUndefined();
    await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1 } as any);
    expect(await band.find({ type: "Text", text: /1 edit across 1 file/ })).toBeDefined();
    await band.unmount();
  });
});

// tests/blast-radius.test.ts
import { describe, expect, test } from "claude-code/testing";

const PANE_PROPS = { title: "Blast Radius", isFocused: true, bodyColumns: 60, placement: "dock" };
const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 };

const LIMIT = { timeoutMs: 20_000 };
const done = { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false };

// Hooks registered here run after the mod and stub what Claude Code would answer.
// `sleep` waits until the test lets the held loop look again, as a real sleep would.
function world(on: any, { isPlaced = true } = {}) {
  const ran: string[][] = [];
  const waiting: (() => void)[] = [];
  on("session.start", ($: any, e: any) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/work" }));
  on("process.run", async ($: any, e: any) => {
    if (e.argv[0] === "sleep") {
      await new Promise<void>((resolve) => waiting.push(resolve));
      return { value: done };
    }
    ran.push([...e.argv]);
    const stdout = e.argv[0] === "find" ? "build/app.js\nbuild/app.css\n" : "";
    return { value: { ...done, stdout } };
  });
  on("ui.open", () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: "too narrow" } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.render", ($: any, e: any) => $.ui.resolve(e).Box({})); // what Claude Code draws when the mod yields
  on("tool.call", ($: any, e: any) => ({ result: { stdout: `ran ${e.command}`, stderr: "", interrupted: false } }));
  const wake = () => waiting.splice(0).forEach((resolve) => resolve());
  return { ran, wake, isHolding: () => waiting.length > 0 };
}

// The held call answers only after a press: wait until the mod sleeps, then read the drawing.
async function held(world: { isHolding: () => boolean }, ui: any, text: RegExp) {
  for (let i = 0; i < 1000 && !world.isHolding(); i += 1) await ui.drawn();
  if (!world.isHolding()) throw new Error("the call was never held");
  await ui.redraw();
  expect(await ui.find({ type: "Text", text })).toBeDefined();
}

describe("blast-radius", () => {
  test("an ordinary command runs as written", LIMIT, async ($, on) => {
    const w = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const r: any = await $.tool.call({ tool: "Bash", command: "ls -la" } as any);
    expect(r.result.stdout).toBe("ran ls -la");
    expect(w.ran).toEqual([]);
  });

  test("rm -r is held in a pane and Cancel refuses it with the dry run", LIMIT, async ($, on) => {
    const w = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ plugin: "blast-radius", surface: "terminal", component: "Pane", requestId: "blast-radius", props: PANE_PROPS } as any);
    const pending = $.tool.call({ tool: "Bash", command: "rm -rf build" } as any);
    await held(w, ui, /delete 2 files under build/);
    expect(await ui.find({ type: "Text", text: /build\/app\.css/ })).toBeDefined();
    await ui.press({ key: "cancel" });
    w.wake();
    const r: any = await pending;
    expect(r.deny).toContain("the user pressed Cancel");
    expect(r.deny).toContain("delete 2 files under build");
    expect(w.ran[0]).toEqual(["find", "build", "-type", "f"]);
    await ui.unmount();
  });

  test("Proceed lets the command run", LIMIT, async ($, on) => {
    const w = world(on);
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ plugin: "blast-radius", surface: "terminal", component: "Pane", requestId: "blast-radius", props: PANE_PROPS } as any);
    const pending = $.tool.call({ tool: "Bash", command: "git reset --hard" } as any);
    await held(w, ui, /discard uncommitted changes/);
    await ui.press({ key: "proceed" });
    w.wake();
    const r: any = await pending;
    expect(r.result.stdout).toBe("ran git reset --hard");
    await ui.unmount();
  });

  test("too narrow for a pane: the same card is drawn above the prompt", LIMIT, async ($, on) => {
    const w = world(on, { isPlaced: false });
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
    const ui = await $.ui.mount({ plugin: "blast-radius", surface: "terminal", component: "AbovePrompt", props: BAND_PROPS } as any);
    const pending = $.tool.call({ tool: "Bash", command: "git clean -fd" } as any);
    await held(w, ui, /git clean/);
    await ui.press({ key: "cancel" });
    w.wake();
    const r: any = await pending;
    expect(r.deny).toContain("remove 0 untracked paths");
    await ui.unmount();
  });
});

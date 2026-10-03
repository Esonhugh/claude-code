// Replay Theater: step through the last turn's edits, one diff at a time.

const PANE = "replay-theater";
const EDIT_TOOLS = new Set(["Edit", "Write"]);
const MAX_TEXT = 20_000;
const MAX_DIFF_LINES = 40;

// Held by the host, so the last replay survives a hot reload of this file.
const replay = { plugin: "replay-theater", key: "replay" };
const step = { plugin: "replay-theater", key: "step" };

// Edits of the turn in progress; a reload mid-turn only loses this turn's partial record.
let pending = [];

export function register(on) {
  // Observe: record the edit, never block or change it.
  on("tool.call", async ($, e, next) => {
    const steps = EDIT_TOOLS.has(e.tool) ? await stepsFor($, e) : [];
    const result = await next(e); // the edit runs untouched
    if (steps.length && !("deny" in result) && !result.isError) pending.push(...steps);
    return result;
  });

  // Pair turn.start and turn.complete into one replay per turn; subagent turns stay out.
  on("turn.start", ($, e, next) => {
    if (!e.agentId) pending = [];
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && pending.length) {
      await $.state.set(replay, { steps: pending, seen: false });
      await $.state.set(step, 0);
      pending = [];
    }
    return result;
  });

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: "replay", description: "Step through the last turn's file edits" });
    return result;
  });

  on("command.run", { command: "replay" }, async ($) => ({ text: (await openReplay($)) ? "Replaying" : "No edits" }));

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value } = await $.state.get(replay);
    if (e.props.hasSurvey || !value || value.seen) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const files = new Set(value.steps.map((s) => s.file)).size;
    return Box({
      flexDirection: "row",
      paddingX: 1,
      gap: 2,
      children: [
        Text({ color: "magenta", bold: true, children: "↺ Replay" }),
        Text({ dimColor: true, children: `${value.steps.length} edit${value.steps.length === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}` }),
        Button({ key: "replay", label: "Replay", hotkey: "r", onPress: () => void openReplay($) }),
      ],
    });
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e, next) => {
    const { value } = await $.state.get(replay);
    if (!value) return next(e);
    const { value: at = 0 } = await $.state.get(step);
    const index = Math.min(Math.max(at, 0), value.steps.length - 1);
    const current = value.steps[index];
    const { Box, Text, Button } = $.ui.resolve(e);
    const go = (to) => () => void $.state.set(step, Math.min(Math.max(to, 0), value.steps.length - 1));
    return Box({
      flexDirection: "column",
      paddingX: 1,
      children: [
        Text({
          children: value.steps.map((_, i) => (i === index ? `[${i + 1}]` : ` ${i + 1} `)).join(""),
        }),
        Text({ bold: true, color: "magenta", children: `${index + 1}/${value.steps.length}  ${current.file}` }),
        ...diff(current.before, current.after).map(([sign, line]) =>
          Text({ color: sign === "+" ? "green" : sign === "-" ? "red" : undefined, dimColor: sign === " ", children: `${sign} ${line}` }),
        ),
        Box({
          flexDirection: "row",
          gap: 2,
          children: [
            Button({ key: "prev", label: "Prev", hotkey: "p", onPress: go(index - 1) }),
            Button({ key: "next", label: "Next", hotkey: "n", onPress: go(index + 1) }),
            Button({ key: "close", label: "Close", hotkey: "q", onPress: () => void $.ui.close({ id: PANE }) }),
          ],
        }),
      ],
    });
  });
}

async function openReplay($) {
  const { value } = await $.state.get(replay);
  if (!value || value.steps.length === 0) return false;
  await $.state.set(replay, { ...value, seen: true });
  await $.state.set(step, 0);
  // Placement is the surface's job: docked beside the transcript, or inline above the prompt.
  await $.ui.open({ id: PANE, title: "Replay Theater", focus: true });
  return true;
}

// For a Write, read the old contents just before the write lands, so the diff is real.
async function stepsFor($, e) {
  if (e.tool === "Edit") {
    return [{ file: e.file_path, before: clip(e.old_string), after: clip(e.new_string) }];
  }
  let before = "";
  try {
    before = await $.fs.read(e.file_path);
  } catch {
    // a new file: nothing before it
  }
  return [{ file: e.file_path, before: clip(before), after: clip(e.content) }];
}

function clip(text) {
  const value = String(text ?? "");
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n…` : value;
}

// A line diff by longest common subsequence, trimmed to the changed region.
function diff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])].slice(0, MAX_DIFF_LINES);
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push([" ", a[i]]);
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(["+", b[j]]);
      j += 1;
    } else {
      out.push(["-", a[i]]);
      i += 1;
    }
  }
  const first = out.findIndex(([s]) => s !== " ");
  const last = out.length - 1 - [...out].reverse().findIndex(([s]) => s !== " ");
  if (first === -1) return [[" ", "(no change)"]];
  return out.slice(Math.max(0, first - 2), last + 3).slice(0, MAX_DIFF_LINES);
}

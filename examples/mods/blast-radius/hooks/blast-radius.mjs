// Blast Radius: hold a risky Bash command, show what it would change, and let the person decide.

const PANE = "blast-radius";
const MAX_LINES = 12;
const SHELL_BREAK = /^(?:;|&&|\|\||\||&|>|>>|<)$/;

// The call being held, if any. Module state is fine here: a hold never outlives the hook call.
let held = null;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const risk = classify(String(e.command ?? ""));
    if (risk === null) return next(e); // everything else runs as normal

    // One hold at a time; a second risky call waits for the first decision.
    while (held !== null && !next.signal.aborted) await $.process.run(["sleep", "0.25"]);
    if (next.signal.aborted) return { deny: "Blast Radius: the turn was interrupted before this command was reviewed." };

    const report = await measure($, risk, await $.session.cwd());
    const call = { command: String(e.command), risk, report, decision: null, where: "pane" };
    held = call;
    try {
      const opened = await $.ui.open({ id: PANE, title: "Blast Radius", focus: true });
      if (!opened.isPlaced) call.where = "band"; // too narrow for a pane: draw above the prompt
      $.ui.invalidate("ui.render");
      while (call.decision === null && !next.signal.aborted) {
        await $.process.run(["sleep", "0.25"]); // time inside $ calls doesn't count against the hook's time limit
      }
    } finally {
      held = null;
      await $.ui.close({ id: PANE });
      $.ui.invalidate("ui.render");
    }
    if (call.decision === "proceed") return next(e); // let it run
    const why = call.decision === "cancel" ? "the user pressed Cancel" : "the turn was interrupted";
    return { deny: `Blast Radius held this command: ${why}. It would have: ${report.summary}.` };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e, next) => {
    if (held === null || held.where !== "pane") return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return card(Box, Text, Button, held, { columns: e.props.bodyColumns });
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.where !== "band" || e.props.hasSurvey) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return card(Box, Text, Button, held, { columns: e.props.bodyColumns, border: true });
  });
}

function decide(call, decision) {
  return () => {
    if (call.decision === null) call.decision = decision;
  };
}

function card(Box, Text, Button, call, { columns, border = false }) {
  const width = Math.max(20, (columns ?? 80) - 4);
  return Box({
    flexDirection: "column",
    paddingX: 1,
    ...(border ? { borderStyle: "round", borderColor: "yellow" } : {}),
    children: [
      Text({ color: "yellow", bold: true, children: `⚠  ${call.risk.label}` }),
      Text({ children: clip(`$ ${call.command}`, width) }),
      Text({ children: `It would ${call.report.summary}.` }),
      ...call.report.lines.map((line) => Text({ dimColor: true, children: clip(`  ${line}`, width) })),
      Box({
        flexDirection: "row",
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", onPress: decide(call, "proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", onPress: decide(call, "cancel") }),
        ],
      }),
    ],
  });
}

function classify(command) {
  const words = command.trim().split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const at = i === 0 || SHELL_BREAK.test(words[i - 1]) ? words[i] : null;
    if (at === "rm") {
      const args = untilBreak(words, i + 1);
      const flags = args.filter((a) => a.startsWith("-") && a !== "--");
      if (flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive")) {
        return { kind: "remove", label: "rm -r", targets: args.filter((a) => !a.startsWith("-")) };
      }
    }
    if (at === "git") {
      const args = untilBreak(words, i + 1);
      const sub = args.find((a) => !a.startsWith("-"));
      if (sub === "reset" && args.includes("--hard")) return { kind: "reset", label: "git reset --hard", targets: [] };
      if (sub === "clean") return { kind: "clean", label: "git clean", targets: args.filter((a) => /^-[a-zA-Z]*[dx]/.test(a)) };
      if (sub === "push" && args.some((a) => a === "-f" || a.startsWith("--force"))) {
        return { kind: "force-push", label: "git push --force", targets: [] };
      }
    }
  }
  if (/\b(?:manage\.py\s+migrate|rails\s+db:migrate|rake\s+db:migrate|prisma\s+migrate\s+deploy|alembic\s+upgrade)\b/.test(command)) {
    return { kind: "migrate", label: "database migration", targets: [] };
  }
  return null;
}

function untilBreak(words, from) {
  const out = [];
  for (let i = from; i < words.length && !SHELL_BREAK.test(words[i]); i += 1) out.push(words[i]);
  return out;
}

// Each report comes from the tools' own dry runs. Arguments go in as an argv array,
// so nothing in a path is run as shell code.
async function measure($, risk, cwd) {
  const run = (argv) => $.process.run(argv, { cwd });
  if (risk.kind === "remove") {
    const files = [];
    for (const target of risk.targets) {
      const found = await run(["find", target, "-type", "f"]);
      if (found.exitCode === 0) files.push(...lines(found.stdout));
    }
    return report(`delete ${files.length} file${files.length === 1 ? "" : "s"} under ${risk.targets.join(" ") || "nothing"}`, files);
  }
  if (risk.kind === "reset") {
    const status = await run(["git", "status", "--porcelain"]);
    const changed = lines(status.stdout).filter((l) => !l.startsWith("??"));
    return report(`discard uncommitted changes in ${changed.length} file${changed.length === 1 ? "" : "s"}`, changed);
  }
  if (risk.kind === "clean") {
    const flags = risk.targets.join("").replace(/[^dx]/g, "");
    const dry = await run(["git", "clean", `-n${flags}`]);
    const paths = lines(dry.stdout).map((l) => l.replace(/^Would remove /, ""));
    return report(`remove ${paths.length} untracked path${paths.length === 1 ? "" : "s"}`, paths);
  }
  if (risk.kind === "force-push") {
    const log = await run(["git", "log", "--oneline", "HEAD..@{upstream}"]);
    const commits = log.exitCode === 0 ? lines(log.stdout) : [];
    return report(`overwrite ${commits.length} commit${commits.length === 1 ? "" : "s"} on the remote`, commits);
  }
  return report("run database migrations, which have no dry run here", []);
}

function report(summary, all) {
  const shown = all.slice(0, MAX_LINES);
  if (all.length > shown.length) shown.push(`… and ${all.length - shown.length} more`);
  return { summary, lines: shown };
}

function lines(text) {
  return String(text ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

function clip(text, width) {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

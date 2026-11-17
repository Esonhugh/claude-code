function Vjs() {
  return R() !== "windows";
}
function iZ(e, o, r = "command") {
  {
    let s = o === void 0 ? "claude" : `claude ${o}`;
    return Vjs() ? `${r === "step" ? "run " : ""}${ND}=${e} ${s}` : `set the environment variable ${ND} to ${e}, then run ${s}`;
  }
  return "";
}
var n = fe({ settled: void 0, open: !1, foresee: void 0 }, (e) => {
  ((e.settled = void 0), (e.open = !1), (e.foresee = void 0));
});
function aZ() {
  return n.settled ?? { state: "not_asked" };
}
function o$r(e) {
  if (n.settled !== void 0) return;
  if (((n.settled = e), (n.open = !1), e.state === "on")) RNa(!0);
}
function Bfa() {
  n.open = n.settled === void 0;
}
function s$r() {
  return n.open;
}
function i$r() {
  return n.settled === void 0 || n.settled.state === "on";
}
function jfa(e) {
  n.foresee = e;
}
function Wfa() {
  try {
    return n.foresee === void 0 || n.settled === void 0 ? "unknown" : n.foresee();
  } catch {
    return "unknown";
  }
  return "unknown";
}
function F0o(e) {
  switch (e) {
    case "bad_value":
      return `${ND} must be 1 to turn it on`;
    case "own_settings":
      return "it has to be turned on in ~/.claude/settings.json, because managed settings or ~/.claude.json also set the variable";
    case "admin":
      return "your organization's settings don't allow it";
    case "admin_unread":
      return "Claude Code couldn't read your organization's settings or policy (starting Claude Code again may help)";
    case "credential_changed":
      return "Claude Code checked your organization's policy with a different credential than the one it now uses (starting Claude Code again will check it with this one)";
    case "compliance":
      return "it isn't offered yet to organizations under HIPAA or zero data retention";
    case "otel":
      return `OpenTelemetry is on (CLAUDE_CODE_ENABLE_TELEMETRY or ENABLE_BETA_TRACING_DETAILED), and ${Mm} doesn't yet send it an event for each tool call`;
    case "runtime":
      return "it needs Claude Code's native build (see code.claude.com/docs/en/setup)";
    case "engine":
      return `this version of Claude Code didn't pass a check that only ${Mm} needs (updating Claude Code may help)`;
    case "no_bash":
      return "for now it needs Git for Windows (Bash) on Windows";
    case "entrypoint":
      return "for now it only works in the interactive terminal";
    case "unattended":
      return "for now it doesn't work in background jobs, in teammates' panes or with Remote Control";
    case "no_setup":
      return "Claude Code skipped the start-up steps that check for it (it skips them while CI or IS_DEMO is set)";
    case "tools":
      return "this launch's tool options (--restricted, --tools, --disallowedTools or a deny rule) leave it out";
    case "agent_teams":
      return "it can't be used together with agent teams yet";
    case "credentials":
      return "for now it doesn't work with an API key helper, ANTHROPIC_AUTH_TOKEN or custom auth headers";
    case "provider":
      return "for now it only works with the Anthropic API";
    case "model":
      return "for now it only works with Opus 5.5, Sonnet 5.5 and later models";
    case "no_flags":
      return `it needs settings that Claude Code downloads from Anthropic, and this session doesn't download them (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or ${Ete() ?? "CLAUDE_CODE_DISABLE_FEATURE_FLAGS"} turns that off)`;
    case "gate":
      return "it isn't open to your account yet, or Claude Code couldn't check whether it is";
    case "mods":
      return "it doesn't yet work with an installed mod (a plugin with JavaScript hooks) that checks tool calls";
    case "declined":
      return "you chose not to turn it on";
    case "unsaved":
      return "Claude Code couldn't save your answer in ~/.claude.json";
  }
  return "";
}
function a$r(e) {
  if (e === "declined")
    return `${BS} is off for this session, as you chose. To stop being asked, remove ${ND} from your shell or settings.json.`;
  return `${BS} isn't available: ${F0o(e)}. Starting with the ordinary tools.`;
}
function Gfa() {
  return `${BS} is on \xB7 this session can be resumed only with ${Mm} on`;
}
function uot() {
  return `This session is in ${BS}, which background sessions can't use yet, so it can't be moved or copied to the background.`;
}
function qjs() {
  return `To use Remote Control, quit Claude Code and start it again with ${ND} set to 0.`;
}
function zfa() {
  return `Remote Control isn't available in ${BS} yet, so this session isn't connected. ${qjs()}`;
}
function Kjs() {
  return `Signed in. Restarting Claude Code to check ${BS} for this account\u2026`;
}
function Yjs(e) {
  return `Signed in. Claude Code has to restart to check ${BS} for this account, and ${e}, so this session is ending instead. Your sign-in is saved. To go on with this conversation, ${iZ(1, "--resume", "step")} and choose it.`;
}
function i(e) {
  switch (e) {
    case "shell":
      return "the shell environment";
    case "userSettings":
      return "user settings";
    case "flagSettings":
      return "--settings";
  }
  return "";
}
function Vfa(e) {
  {
    let o = aZ();
    switch (o.state) {
      case "on":
        return `${e ? "on (experimental)" : "on (experimental), but this session uses the ordinary tools"} \xB7 ${ND} in ${i(o.source)}`;
      case "refused":
        return `off \xB7 ${F0o(o.why)}`;
      case "not_asked":
        return;
    }
  }
  return;
}
export { Vjs, iZ, aZ, o$r, Bfa, s$r, i$r, jfa, Wfa, F0o, a$r, Gfa, uot, qjs, zfa, Kjs, Yjs, Vfa };

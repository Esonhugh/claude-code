import { randomUUID as a } from "crypto";
var u = "repl-error-";
function uJt(e, { clientsDrawCalls: t, shownOnCall: s, stoppedBy: o, withheldScriptToolUseId: r }) {
  let n = `${u}${a()}`,
    i = t && { visibleToRemoteClients: !0 };
  return [
    { ...Ha({ content: [{ type: "tool_use", id: n, name: Co, input: {} }], isVirtual: !0 }), ...i, ...(s && { scriptErrorCopy: !0 }) },
    {
      ...Ie({
        content: [{ type: "tool_result", tool_use_id: n, content: e, is_error: !0 }],
        toolUseResult: { error: e, ...(o !== void 0 && { stoppedBy: o }), ...(s && { shownOnCall: !0 }) },
        isVirtual: !0,
      }),
      turnCompanion: !0,
      ...i,
      ...(t && { remoteToolResult: { kind: "stored", text: e } }),
      ...(r !== void 0 && { withheldScriptToolUseId: r }),
    },
  ];
}
export { uJt };

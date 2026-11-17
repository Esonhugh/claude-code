var p = [Re, gt, ft, ou, gs],
  l = 80;
function c(t) {
  if (!p.includes(t.toolName)) return {};
  let e = P(t.toolInput) ? t.toolInput.description : void 0,
    r = pt(kpe(e, l), l);
  return r === "" ? {} : { description: r };
}
var n = fe(new Map(), (t) => t.clear());
function Kds(t) {
  if (t === void 0 || !NUe() || !Rlo()) return;
  let e = { state: "holding", held: new Map() };
  return {
    awaitReceipt() {
      n.set(t, e);
    },
    tick(r) {
      if (r.type !== "progress" || e.state === "ended") return;
      try {
        let o = Yds({ toolUseID: r.toolUseID, parentToolUseID: r.parentToolUseID ?? t, data: r.data, withheldInput: c(r.data) });
        if (o === void 0) return;
        if (e.state === "released") js(o);
        else e.held.set(o.tool_use_id, o);
      } catch (o) {
        a(o);
      }
    },
    ended(r, o) {
      if (e.state === "ended") return;
      let s = e.state === "released";
      if (((e.state = "ended"), e.held.clear(), !s)) return;
      (n.delete(t), (e.sentEnd = !0), i(t, r, o));
    },
    lost() {
      if (e.sentEnd === !0) ((e.sentEnd = void 0), i(t, void 0, [], !0));
    },
  };
}
function N5a(t) {
  if (n.size === 0 || t.type !== "user" || !Array.isArray(t.message.content)) return;
  try {
    for (let e of t.message.content) {
      if (e.type !== "tool_result") continue;
      let r = n.get(e.tool_use_id);
      if (r?.state === "ended") {
        (n.delete(e.tool_use_id), i(e.tool_use_id, void 0, []));
        continue;
      }
      if (r?.state !== "holding") continue;
      r.state = "released";
      for (let o of r.held.values()) js(o);
      r.held.clear();
    }
  } catch (e) {
    a(e);
  }
}
function i(t, e, r, o = !1) {
  try {
    js({
      type: "tool_progress",
      tool_use_id: t,
      tool_name: Co,
      parent_tool_use_id: null,
      elapsed_time_seconds: 0,
      script_ended: !0,
      ...(o && { settle_lost: !0 }),
      final_tool_use_ids: (e ?? []).flatMap((s) =>
        s.type === "assistant" && Array.isArray(s.message.content)
          ? s.message.content.flatMap((d) => (d.type === "tool_use" ? [d.id] : []))
          : [],
      ),
      detached_tool_use_ids: [...r],
    });
  } catch (s) {
    a(s);
  }
}
export { Kds, N5a };

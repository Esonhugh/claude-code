var J = 1000,
  Oso = p(() => He({})),
  X = p(() =>
    We([
      u({
        type: T("image"),
        source: u({ type: T("base64"), media_type: B(["image/jpeg", "image/png", "image/gif", "image/webp"]), data: o() }),
      }),
      u({ type: T("document"), source: u({ type: T("base64"), media_type: T("application/pdf"), data: o() }) }),
    ]),
  );
var Iso = p(() =>
    u({
      content: o().describe(`Rendered event envelopes, or "${wBe}"`),
      eventCount: k().int().describe("Number of events delivered in this result"),
      remainingWakeCount: k().int().describe("Wake events still queued after this chunk; they follow in the next delivery"),
      media: A(A(X())).optional().describe("Each delivered event's images and documents, 1:1 with the events. Absent when none has any"),
      toolsUsed: A(o()).optional(),
      ...{},
      provenance: A(u({ authority: B(PKe), senderId: o().optional(), senderText: o().optional() }).nullable()).optional(),
      declared: A(w6i().nullable()).optional(),
    }),
  ),
  s5a = mn({
    registryToolId: "a0b1dc01-4837-5be1-b545-3b6e0c621b82",
    name: xi,
    searchHint: "wait for and receive queued harness events",
    backgrounding: "never",
    maxResultSizeChars: 200000,
    persistenceThresholdCeiling: 200000,
    skipAggregateToolResultBudget: !0,
    get inputSchema() {
      return Oso();
    },
    get outputSchema() {
      return Iso();
    },
    isEnabled() {
      return HR();
    },
    isConcurrencySafe() {
      return !0;
    },
    isReadOnly() {
      return !0;
    },
    async description() {
      return "Wait for pending harness events";
    },
    async prompt() {
      let e = fbs(ZHn());
      if (le()) {
        let { isReplSpliceWaitEnabled: t } = import.meta.require("/$bunfs/root/chunk-06mzczcc.js"),
          i = Qvr() ? v6i() : void 0,
          c =
            e === void 0 || i === void 0
              ? (e ?? i)
              : `${e}

${i}`;
        return mLo(t() ? t_a() : pLo, n_a(), c, i === void 0 ? void 0 : r_a());
      }
      return e === void 0 ? o_a : mLo(pLo, void 0, e);
    },
    isTransparentWrapper() {
      return le() && jy();
    },
    mapToolResultToToolResultBlockParam(e, t) {
      return { tool_use_id: t, type: "tool_result", content: G6t(e.content, e.media) };
    },
    stripForStorage(e) {
      return e;
    },
    renderToolUseMessage() {
      return "";
    },
    extractSearchText() {
      return "";
    },
    create(e) {
      let { agentId: t, messageQueue: i, toolState: c, taskRegistry: w, unlayeredPermissions: P } = e;
      return {
        async call(z, a) {
          let { signal: N, parentMessage: v, onProgress: E } = a,
            d =
              le() && jy() && t !== void 0 && lAt({ agentId: t, agentContext: e.agentContext, teammateContext: e.teammateContext })
                ? t
                : void 0;
          if (t !== void 0 && d === void 0)
            throw new C(
              le() && jy()
                ? `${xi} isn't available here and isn't needed: each ${Co} call you make here waits for its script to finish and returns the result.`
                : "Poll is available on the main thread only",
              "Poll refused for this agent",
            );
          let h = d ?? qx,
            x = i;
          if (!x.tryBeginPollCall(d)) {
            if ((Q("duplicate_call", 0, 0), le() && jy()))
              return { data: { content: wBe, eventCount: 0, remainingWakeCount: 0 }, hideRow: !0 };
            return { data: { content: wBe, eventCount: 0, remainingWakeCount: 0 } };
          }
          let S = le() && jy(),
            j = le() && import.meta.require("/$bunfs/root/chunk-06mzczcc.js").isReplSpliceWaitEnabled(),
            r;
          try {
            let y = le() ? import.meta.require("/$bunfs/root/chunk-18z4c769.js").getReplSessions({ toolState: c }) : void 0;
            if (le() && S && Ul() && y !== void 0 && E !== void 0 && !j) {
              let s = ({ startedAt: m, tick: b }) => E({ type: "progress", toolUseID: b.toolUseId, data: { ...b, scriptStartedAt: m } });
              for (let m of y.ticks(h)) s(m);
              r = y.onTick(h, s);
            }
            let F = Date.now(),
              W = await Mso(x, N, y, {
                messages: e.messages,
                ...te({
                  ingress: D9t(),
                  permissionMode: P().mode,
                  cacheTtlMs: d === void 0 ? lq() : null,
                  ...(le()
                    ? {
                        codeModeExperiment: S,
                        besideReplCall: [v, ...(a.sameTurnToolUses ?? []).filter((s) => s.message.id === v?.message.id)].some(
                          (s) => Array.isArray(s?.message.content) && s.message.content.some((m) => m.type === "tool_use" && ja(m.name)),
                        ),
                        printInputClosed: yte(),
                        selfArmed: Qga(),
                      }
                    : {}),
                }),
                ...(d !== void 0 && { ownWorkOnly: !0, inputClosed: !1, idleWaitMs: void 0, agentId: d }),
                liveTasks:
                  le() && S
                    ? () =>
                        Object.values(w.all())
                          .filter((s) => ee(s) && (d === void 0 || ne(s, d)))
                          .map((s) => s.description)
                    : () => [],
                ...(le() && { deliveryTurn: e.deliveryTurn }),
              }),
              { endReason: _, ...M } = W;
            if ((Q(_, Date.now() - F, _ === "delivered" ? M.data.eventCount : 0), le() && j && y !== void 0)) {
              if (M.data.eventCount > 0) y.takeUnwaited(h);
              else if (_ === "queued_input_for_turn_end") {
                let s = new Set(y.pending(h).map((m) => m.id));
                if (s.size > 0) (y.takeUnwaited(h, s), y.noteStatusLine(h));
              }
            }
            return le() && S && M.data.eventCount === 0 ? { ...M, hideRow: !0 } : M;
          } finally {
            if (le()) r?.();
            x.endPollCall(d);
          }
        },
      };
    },
  });
function ee(e) {
  return !es(e.status) && e.type !== "in_process_teammate" && !WOe(e) && !a$(e) && !(le() && A4(e));
}
function ne(e, t) {
  return (e.type === "local_agent" || e.type === "local_workflow" ? e.ownerAgentId : "agentId" in e ? e.agentId : void 0) === t;
}
function V(e) {
  return Math.min(e ?? HM, HM) - CWt;
}
function te(e) {
  let { ingress: t, permissionMode: i, cacheTtlMs: c } = e;
  return {
    ownWorkOnly:
      t === "evals" || (le() && e.codeModeExperiment && (t === "terminal" || (t === "host" && i !== "auto") || e.besideReplCall)),
    inputClosed: le() && e.codeModeExperiment && e.printInputClosed,
    waitMs: (c ?? HM) - CWt,
    idleWaitMs: le() && e.codeModeExperiment && e.selfArmed ? V(c) : void 0,
  };
}
async function Mso(e, t, i, c) {
  let { ownWorkOnly: w, inputClosed: P, liveTasks: z, waitMs: a, idleWaitMs: N, agentId: v, yieldWait: E } = c,
    d = v ?? qx;
  if (le()) i?.takeStatusLineGiven(d);
  let h = Date.now(),
    x = () =>
      (w || (P && e.pollEventAdmissionsPending() === 0)) && (le() && i !== void 0 ? i.outstanding(d) === 0 : !0) && z().length === 0,
    S = Math.min(a, V(null));
  function j() {
    return le() && i !== void 0 && i.ledger(qx).length > 0 && Date.now() - h < S;
  }
  for (;;) {
    if (t.aborted) return R("aborted");
    let { commands: r, remainingWakeCount: y } = e.drainPollEventChunk(v);
    if (r.length > 0) {
      let m = r.map(U6t),
        b = B6t(r);
      (g("poll_event_delivery"), ylt(r), OKe(r));
      let L = Itn(r, c.messages?.() ?? []),
        O = {
          content: nce(m, y, L),
          eventCount: r.length,
          remainingWakeCount: y,
          ...(L.length > 0 && { toolsUsed: L }),
          ...(r.some((D) => D.pollEvent?.media !== void 0) && { media: r.map((D) => D.pollEvent?.media ?? []) }),
          provenance: r.map((D) => D.pollEvent?.provenance ?? null),
          ...(b !== void 0 && { declared: b }),
        };
      if (le()) {
        let D = kpr(r),
          { clearPollEventFollowing: H, pollEventFollowingOf: q } = import.meta.require("/$bunfs/root/chunk-fhek580b.js"),
          { messages: Z, contextLayers: Y } = q(r, c.deliveryTurn?.());
        H(r);
        let G = [...D, ...Z];
        return {
          data: O,
          endReason: r.every((U) => U.pollEvent?.kind === Cge) ? "status_work_running" : "delivered",
          ...e_a(r),
          ...(G.length > 0 && { newMessages: G }),
          ...(Y.length > 0 && { contextLayers: Y }),
          ...(import.meta.require("/$bunfs/root/chunk-bj9gm18j.js").clientsDrawScriptCalls() &&
            r.every((U) => (U.pollEvent?.kind === Zk || U.pollEvent?.kind === Cge) && U.pollEvent?.keepsRow !== !0) && { hideRow: !0 }),
        };
      }
      return { data: O, endReason: "delivered" };
    }
    if (K(e, j(), v)) return R(K(e, !0, v) ? "queued_input" : "queued_input_for_turn_end", E?.whatArrived());
    if (E?.scheduledFireDue()) return R("scheduled_fire_due", oLr);
    if (E?.ownMessageArrived()) return R("own_message", rLr);
    if (E?.messageForTurnEnd !== void 0 && (await E.messageForTurnEnd())) return R("teammate_message", Loa);
    if (x())
      return P && !w
        ? { data: { content: gzs(), eventCount: 0, remainingWakeCount: 0 }, endReason: "nothing_to_wait_for_input_closed" }
        : R("nothing_to_wait_for", E && Poa);
    let F = Date.now() - h,
      W = le() && i !== void 0 ? i.ledger(d) : [],
      _ = W.length > 0 ? [] : z(),
      M = E?.limitMs() ?? a;
    if (F >= M) {
      if (E !== void 0 && _.length > 0)
        return {
          data: {
            content: `nothing has reported yet; ${_.length} background ${I(_.length, "task")} still running. Call ${LC} again to keep waiting.`,
            eventCount: 0,
            remainingWakeCount: 0,
          },
          endReason: "status_work_running",
        };
      if (le() && W.length > 0) {
        (import.meta.require("/$bunfs/root/chunk-2p8jywjd.js").enqueueReplStatus(e, W, v), i?.noteStatusLine(d));
        continue;
      }
      if (le() && _.length > 0)
        return {
          data: {
            content: `No events yet \u2014 ${_.length} background ${I(_.length, "task")} still running: ${_.map((m) => A3n(m)).join("; ")}. Poll again to keep waiting.`,
            eventCount: 0,
            remainingWakeCount: 0,
          },
          endReason: "status_work_running",
        };
    }
    let s = W.length === 0 && _.length === 0;
    if (s && N !== void 0 && F >= N) return R("wait_limit_nothing_running");
    await new Promise((m) => {
      let b = s ? N : K(e, !1, v) ? S : M,
        L = b !== void 0 ? setTimeout(O, Math.min(Math.max(0, b - F), E === void 0 ? 1 / 0 : J)) : void 0;
      function O() {
        if (L !== void 0) clearTimeout(L);
        (D(), H(), t.removeEventListener("abort", O), m());
      }
      let D = e.subscribe(O),
        H = le() && i !== void 0 ? i.onOutstandingChange(O) : () => {};
      if ((t.addEventListener("abort", O), t.aborted || K(e, j(), v) || x())) O();
    });
  }
}
function K(e, t, i) {
  if (i !== void 0)
    return !e.isMidTurnFoldSuspended() && Ume(e.getCommandsByMaxPriority("next"), { isMainThread: !1, currentAgentId: i }).length > 0;
  let c = e.isMidTurnFoldSuspended(),
    w = t && !c,
    P = e.getCommandsByMaxPriority("next").findIndex((a) => a.drainOnly === !0),
    z = new Set(
      P < 0
        ? []
        : e
            .getCommandsByMaxPriority("next")
            .slice(P)
            .filter((a) => a.drainOnly === !0 || a.mode === "prompt"),
    );
  return (
    e.peek((a) => Sc(a) && !(w && (a.priority === "later" || z.has(a)) && a.mode !== "poll-event")) !== void 0 ||
    (c
      ? !_n() && e.peek(TK) !== void 0
      : Ume(e.getCommandsByMaxPriority("next"), { isMainThread: !0, currentAgentId: void 0 }).some(
          (a) => !z.has(a) && a.screeningPending !== !0,
        ))
  );
}
function R(e, t = wBe) {
  return { data: { content: t, eventCount: 0, remainingWakeCount: 0 }, endReason: e };
}
function Q(e, t, i) {
  l("tengu_poll_call_end", { reason: f(e), waitedMs: t, deliveredEventCount: i });
}
export { Oso, Iso, s5a, Mso };

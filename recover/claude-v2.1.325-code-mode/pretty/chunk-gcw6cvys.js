function W(t) {
  return Hvt(t) && ru(t);
}
function j(t) {
  return t.mode === "poll-event" && t.pollEvent?.kind === Cge && ru(t);
}
function L(t) {
  (t.setPassive?.(W, !0), c0(t.removeByFilter(j), "a stop ended the scripts this status line describes"));
}
var sLo = 8;
class Q {
  context = void 0;
  running = new Set();
  attached = void 0;
  deliveryChain = Promise.resolve();
  depth = 0;
  pending = new Map();
  ranEvals = !1;
  epoch = 0;
  conversation = 0;
  holdReportsEpoch = 0;
  declined = void 0;
  rewoundToolUses = new Set();
  kept = void 0;
  evalIdByToolUseId = new Map();
  ticks = Le();
  unwaited = new Set();
  undelivered = new Set();
  statusLineGiven = !1;
  settling = new Map();
  onRunningChange = () => {};
  runningCache = { at: -1, value: new Map() };
  runningChanges = 0;
}
var G = 100,
  z = 50,
  F = 256,
  iLo = { list: () => [], abort: () => (le() ? "no such eval" : "") };
class vge {
  #e = new Map();
  #d = 1;
  #t = 0;
  #i = 0;
  #r = Le();
  #a = Le();
  #l = new WeakMap();
  takeScriptNumber() {
    return this.#d++;
  }
  dispatch(t, n, i, r = "") {
    if (!le()) throw Error("unreachable");
    let e = this.#n(t);
    if (e.depth >= sLo)
      throw new C(
        `async REPL dispatch rejected: ${e.depth} evals already waiting or running on this context \u2014 wait for their settles (Poll) before dispatching more`,
        "async REPL dispatch rejected: unsettled evals cap",
      );
    let o = this.#d++,
      { epoch: l, conversation: E } = e,
      p = () => (e.conversation !== E && e.kept?.(o) !== !0) || (i.toolUseId !== void 0 && e.rewoundToolUses.has(i.toolUseId)),
      y = () => e.holdReportsEpoch > l;
    if (i.toolUseId !== void 0) {
      if ((e.evalIdByToolUseId.set(i.toolUseId, o), e.evalIdByToolUseId.size > F)) {
        for (let [u, f] of e.evalIdByToolUseId)
          if (!e.pending.has(f) && !e.settling.has(f)) {
            e.evalIdByToolUseId.delete(u);
            break;
          }
      }
    }
    ((e.ranEvals = !0), e.depth++);
    let g = 2,
      I = () => {},
      Y = new Promise((u) => {
        I = u;
      }),
      w = () => {
        if ((g--, g === 0)) I();
      },
      T = () => {
        (e.unwaited.delete(o), e.undelivered.delete(o), e.settling.delete(o), c(e), w());
      },
      d = {
        startedAt: void 0,
        detached: !1,
        description: i.description,
        replyId: i.replyId,
        snippet: r.replace(/\s+/g, " ").trim().slice(0, G),
        controller: void 0,
        abortRequested: void 0,
        epoch: e.epoch,
        late: void 0,
        ticks: new Map(),
        finished: new Set(),
        callReturned: !1,
        readNotYetStarted: void 0,
        left: () => {
          (i.signal.removeEventListener("abort", R), w());
        },
        retired: p,
        stopped: new AbortController(),
      };
    function R() {
      if (!gpn(i.signal.reason)) d.stopped.abort();
    }
    if (i.signal.aborted) R();
    else i.signal.addEventListener("abort", R, { once: !0 });
    if (e.declined !== void 0)
      if (i.replyId !== void 0 && e.declined.replyIds.has(i.replyId)) (d.stopped.abort(e.declined.reason), (d.abortRequested = "declined"));
      else e.declined = void 0;
    (e.pending.set(o, d), e.unwaited.add(o), e.undelivered.add(o), (e.statusLineGiven = !1), c(e), this.#s(this.#t + 1));
    let q = e.attached ?? Promise.resolve(),
      v = () => {},
      S = new Promise((u) => {
        v = u;
      });
    ((e.attached = S),
      S.then(() => {
        if (e.attached === S) e.attached = void 0;
      }));
    let D = !1,
      H = async () => {
        let u,
          f = !1,
          b,
          O = () => i.signal.aborted && !gpn(i.signal.reason);
        if (O())
          ((f = !0),
            (b = "person"),
            (u =
              "cancelled before start \u2014 the dispatching turn was aborted while this eval waited for its turn; the script never ran"));
        else if (e.epoch !== l)
          ((f = !0),
            (b = "person"),
            (u = "cancelled before start \u2014 the session was interrupted while this eval waited for its turn; the script never ran"));
        else if (d.abortRequested !== void 0)
          ((f = !0),
            (b = d.abortRequested === "person" ? "person" : "other"),
            (u =
              d.abortRequested === "person"
                ? "cancelled before start \u2014 the user stopped this eval while it waited for its turn; the script never ran"
                : d.abortRequested === "declined"
                  ? "cancelled before start \u2014 the user declined the permission dialog for an earlier script's call (a No or an Esc), which also cancels the scripts behind that one; the script never ran"
                  : d.abortRequested === "taskStop"
                    ? "cancelled before start \u2014 a TaskStop call stopped this eval while it waited for its turn; the script never ran"
                    : d.abortRequested === "session"
                      ? "cancelled before start \u2014 Claude Code stopped this eval while it waited for its turn; the script never ran"
                      : "cancelled before start \u2014 a script aborted this eval (self.running().abort()) while it waited for its turn; it never ran"));
        else {
          if (_n()) await nd();
          let h = ar(),
            A,
            k = !1,
            P = () => {
              if (k) return;
              (clearTimeout(A), (d.detached = !0), v());
            },
            _ = () => {
              if (O()) h.abort(i.signal.reason);
              else if (i.staysAttachedOnTurnAbort !== !0) P();
            };
          if (i.signal.aborted) _();
          else i.signal.addEventListener("abort", _, { once: !0 });
          if ((e.running.add(h), (d.startedAt = Date.now()), c(e), (d.controller = h), !d.detached)) A = setTimeout(P, i.detachAfterMs);
          try {
            u = await n(h, {
              reportNotYetStarted: (m) => {
                d.readNotYetStarted = m;
              },
            });
          } catch (m) {
            ((f = !0), (u = fW(m) ? m.message : "host-side failure before settling (non-Error rejection; detail withheld from coercion)"));
          } finally {
            ((k = !0), clearTimeout(A), e.running.delete(h));
          }
        }
        ((D = !0), this.#p(t, o, u, f, i, v, p, T, y, b));
      },
      M = q.then(async () => {
        try {
          await H();
        } finally {
          if (!D) (this.#s(this.#t - 1), v(), T());
        }
      });
    M.catch(a);
    let V = M.then(
      () => {},
      () => {},
    ).then(() => {
      if ((e.depth--, d.late === void 0)) U(e, o, d);
      c(e);
    });
    return { evalId: o, finished: V, retired: p, ended: Y, stopped: d.stopped.signal };
  }
  pending(t) {
    if (!le()) return [];
    return this.ledger(t).filter((n) => n.state !== "late");
  }
  ledger(t) {
    if (!le()) return [];
    let n = this.#e.get(t);
    if (n === void 0) return [];
    let i = Date.now();
    return [...n.pending].map(([r, e]) => ({
      id: r,
      state: e.late !== void 0 ? "late" : e.startedAt === void 0 ? "waiting" : e.detached ? "detached" : "running",
      runningMs: e.startedAt === void 0 ? 0 : i - e.startedAt,
      snippet: e.snippet,
      notYetStarted: e.readNotYetStarted?.() ?? [],
    }));
  }
  holdLate(t, n, i) {
    if (!le()) {
      i.abort();
      return;
    }
    let r = this.#e.get(t),
      e = r?.pending.get(n);
    if (r === void 0 || e === void 0 || e.late !== void 0) {
      i.abort();
      return;
    }
    ((e.late = { abort: i.abort, discard: i.discard }), e.ticks.clear(), e.finished.clear(), c(r), this.#c(this.#i + 1));
    let o = () => this.#o(r, n, e);
    i.idle.then(o, o);
  }
  #o(t, n, i) {
    if (t.pending.get(n) !== i) return;
    (U(t, n, i), c(t), this.#c(this.#i - 1));
  }
  stopAskerOf(t) {
    return this.#l.get(t);
  }
  recordTick(t, n, i) {
    if (!le()) return;
    let r = this.#e.get(t),
      e = r?.pending.get(n);
    if (r === void 0 || e === void 0) return;
    let o;
    try {
      o = aLo(i);
    } catch {
      return;
    }
    if ((e.ticks.set(o.toolUseId, o), X(o))) {
      if ((e.finished.add(o.toolUseId), e.finished.size > z)) {
        let l = e.finished.values().next().value;
        if (l !== void 0) (e.finished.delete(l), e.ticks.delete(l));
      }
    } else e.finished.delete(o.toolUseId);
    if (e.callReturned && e.startedAt !== void 0) B(r, { evalId: n, startedAt: e.startedAt, tick: o });
  }
  callReturned(t, n) {
    if (!le()) return;
    let i = this.#e.get(t),
      r = i?.pending.get(n);
    if (i === void 0 || r === void 0 || r.callReturned) return;
    if (((r.callReturned = !0), r.startedAt === void 0)) return;
    for (let e of r.ticks.values()) B(i, { evalId: n, startedAt: r.startedAt, tick: e });
  }
  ticks(t) {
    if (!le()) return [];
    let n = this.#e.get(t);
    if (n === void 0) return [];
    let i = [];
    for (let [r, e] of n.pending) {
      if (!e.callReturned || e.startedAt === void 0) continue;
      for (let o of e.ticks.values()) i.push({ evalId: r, startedAt: e.startedAt, tick: o });
    }
    return i;
  }
  takeUnwaited(t, n) {
    if (!le()) return [];
    let i = this.#e.get(t);
    if (i === void 0) return [];
    let r = [...i.unwaited].filter((e) => n?.has(e) ?? !0);
    for (let e of r) i.unwaited.delete(e);
    return r;
  }
  noteStatusLine(t) {
    if (!le()) return;
    this.#n(t).statusLineGiven = !0;
  }
  takeStatusLineGiven(t) {
    if (!le()) return !1;
    let n = this.#e.get(t);
    if (n === void 0) return !1;
    let i = n.statusLineGiven;
    return ((n.statusLineGiven = !1), i);
  }
  undelivered(t) {
    if (!le()) return N;
    return this.#e.get(t)?.undelivered ?? N;
  }
  runningScripts(t) {
    if (!le()) return x;
    let n = this.#e.get(t);
    if (n === void 0) return x;
    if (n.runningCache.at === n.runningChanges) return n.runningCache.value;
    let i = new Map();
    for (let [r, e] of n.evalIdByToolUseId) {
      let o = n.pending.get(e),
        l = o ?? n.settling.get(e);
      if (l === void 0 || (o !== void 0 && (o.epoch !== n.epoch || o.retired()))) continue;
      i.set(r, { evalId: e, description: l.description, startedAt: l.startedAt, late: o?.late !== void 0 && !n.undelivered.has(e) });
    }
    return ((n.runningCache = { at: n.runningChanges, value: i }), i);
  }
  onRunningScriptsChange(t) {
    if (!le()) return () => {};
    return this.#a.subscribe(t);
  }
  onTick(t, n) {
    if (!le()) return () => {};
    return this.#n(t).ticks.subscribe(n);
  }
  abort(t, n, i = "script") {
    if (!le()) return "";
    let r = this.#e.get(t),
      e = r?.pending.get(n);
    if (r === void 0 || e === void 0) return "no such eval (it may have settled already)";
    if ((e.stopped.abort(), e.late !== void 0)) (e.late.abort(), this.#o(r, n, e));
    else if (e.controller !== void 0) {
      if (i !== "person" && !e.controller.signal.aborted) this.#l.set(e.controller.signal, i);
      e.controller.abort(cl("user-cancel"));
    } else e.abortRequested = i;
    return "";
  }
  cancelWaiting(t, n, i) {
    if (!le()) return;
    let r = this.#e.get(t);
    if (r === void 0) return;
    let e = r.declined?.replyIds ?? new Set();
    (e.add(i), (r.declined = { reason: n, replyIds: e }));
    for (let o of r.pending.values())
      if (o.controller === void 0 && o.abortRequested === void 0) {
        if ((o.stopped.abort(n), (o.abortRequested = "declined"), o.replyId !== void 0)) e.add(o.replyId);
      }
  }
  access(t, n) {
    if (!le()) return iLo;
    return {
      list: () => {
        let i = n();
        return this.ledger(t).map((r) => ({ ...r, self: r.id === i }));
      },
      abort: (i) => this.abort(t, i),
    };
  }
  outstanding(t) {
    if (t === void 0) return this.#t + this.#i;
    let n = this.#e.get(t);
    if (n === void 0) return 0;
    let i = 0;
    for (let r of n.pending.values()) if (r.late !== void 0) i++;
    return n.undelivered.size + i;
  }
  unsettled(t) {
    if (t === void 0) return this.#t;
    return this.#e.get(t)?.undelivered.size ?? 0;
  }
  #u;
  mainThreadStoppableWork() {
    return (
      (this.#u ??= {
        outstanding: () => this.outstanding(I6t),
        stoppable: () => this.stoppable([I6t]),
        onOutstandingChange: (t) => this.onOutstandingChange(t),
        interrupt: () => {
          this.interrupt([I6t]);
        },
      }),
      this.#u
    );
  }
  stoppable(t) {
    if (!le()) return 0;
    let n = t === void 0 ? void 0 : new Set(t),
      i = 0;
    for (let [r, e] of this.#e) {
      if (n !== void 0 && !n.has(r)) continue;
      for (let o of e.pending.values()) if (o.epoch === e.epoch && !o.abortRequested && o.controller?.signal.aborted !== !0) i++;
    }
    return i;
  }
  onOutstandingChange(t) {
    return this.#r.subscribe(t);
  }
  #s(t) {
    ((this.#t = t), this.#r.emit());
  }
  #c(t) {
    ((this.#i = t), this.#r.emit());
  }
  depth(t) {
    return this.#e.get(t)?.depth ?? 0;
  }
  attached(t) {
    return this.#e.get(t)?.attached;
  }
  #p(t, n, i, r, e, o, l, E, p, y) {
    if (!le()) return;
    let g = this.#n(t);
    g.deliveryChain = g.deliveryChain
      .then(() => e.deliver(n, i, r, l(), p, y))
      .catch(a)
      .finally(() => {
        (o(), this.#s(this.#t - 1), E());
      });
  }
  clear(t, n) {
    let i = t === void 0 ? void 0 : Array.from(t);
    for (let r of this.#f(i)) if ((r.conversation++, (r.kept = n), le())) for (let e of r.pending.values()) e.late?.discard();
    this.interrupt(i, { keepsNamed: n });
  }
  dropRewound(t, n) {
    let i = this.#e.get(t);
    if (i === void 0) return;
    for (let r of n) {
      i.rewoundToolUses.add(r);
      let e = i.evalIdByToolUseId.get(r);
      if (e !== void 0) i.settling.delete(e);
    }
    c(i);
  }
  bringBackRewound(t, n) {
    let i = this.#e.get(t);
    if (i === void 0) return;
    for (let r of n) i.rewoundToolUses.delete(r);
    c(i);
  }
  tracks(t, n) {
    let i = this.#e.get(t);
    return i !== void 0 && (i.pending.has(n) || i.undelivered.has(n) || i.settling.has(n));
  }
  evalIdsOf(t, n) {
    let i = this.#e.get(t)?.evalIdByToolUseId,
      r = new Set();
    if (i === void 0) return r;
    for (let e of n) {
      let o = i.get(e);
      if (o !== void 0) r.add(o);
    }
    return r;
  }
  interrupt(t, { holdReportsIn: n, keepsNamed: i } = {}) {
    let r = t === void 0 ? void 0 : Array.from(t);
    for (let e of this.#f(r)) {
      if ((e.epoch++, (e.statusLineGiven = !1), n !== void 0)) e.holdReportsEpoch = e.epoch;
      for (let o of e.running) o.abort(cl("user-cancel"));
      for (let o of e.settling.keys()) if (i?.(o) !== !0) e.settling.delete(o);
      if ((c(e), le())) {
        for (let [o, l] of e.pending) if ((l.stopped.abort(), l.late !== void 0)) (l.late.abort(), this.#o(e, o, l));
      }
      (e.context?.clearAllTimers(), (e.declined = void 0));
    }
    if (le() && n !== void 0 && (r === void 0 || r.includes(I6t))) L(n);
    this.#r.emit();
  }
  #f(t) {
    return t === void 0 ? this.#e.values() : Array.from(t, (n) => this.#e.get(n)).filter((n) => n !== void 0);
  }
  get(t) {
    return this.#e.get(t)?.context;
  }
  has(t) {
    return this.#e.get(t)?.context !== void 0;
  }
  set(t, n) {
    this.#n(t).context = n;
  }
  release(t) {
    let n = this.#e.get(t);
    if (n?.context === void 0) return !1;
    if ((n.context.clearAllTimers(), (n.context = void 0), !n.ranEvals)) this.#e.delete(t);
    return !0;
  }
  forget(t) {
    let n = this.#e.get(t);
    if (n === void 0) return;
    let i = () => n.depth === 0 && n.pending.size === 0 && n.undelivered.size === 0 && n.settling.size === 0,
      r = () => this.#e.get(t) === n && n.context === void 0,
      e = n.onRunningChange,
      o = () => {
        if (!r() || i()) n.onRunningChange = e;
        if (r() && i())
          n.deliveryChain.finally(() => {
            if (r() && i()) this.#e.delete(t);
          });
      };
    ((n.onRunningChange = () => {
      (e(), o());
    }),
      o());
  }
  #n(t) {
    let n = this.#e.get(t);
    if (n === void 0) ((n = new Q()), (n.onRunningChange = () => this.#a.emit()), this.#e.set(t, n));
    return n;
  }
}
function _Ya(t) {
  return t.mainThreadStoppableWork();
}
function kge(t) {
  return t.toolState.get(vge);
}
function X(t) {
  return t.phase === "complete" || t.phase === "error";
}
var x = new Map(),
  N = new Set();
function U(t, n, i) {
  if ((t.pending.delete(n), i.left(), i.startedAt !== void 0 && !i.stopped.signal.aborted && !i.retired() && t.undelivered.has(n)))
    t.settling.set(n, { description: i.description, startedAt: i.startedAt });
}
function c(t) {
  (t.runningChanges++, t.onRunningChange());
}
function B(t, n) {
  try {
    t.ticks.emit(n);
  } catch (i) {
    a(i);
  }
}
export { sLo, iLo, vge, _Ya, kge };

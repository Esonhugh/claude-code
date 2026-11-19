import * as t from "vm";
var l = `(() => {
  'use strict'
  Object.defineProperty(globalThis, 'pinned', { value: 0 })
  const isOwn = e => Object.getPrototypeOf(e) === TypeError.prototype
  let first = false
  let second = false
  let third = true
  try {
    Object.defineProperty(globalThis, 'pinned', { value: 1 })
  } catch (e) {
    first = isOwn(e)
  }
  try {
    class Base { constructor() { return globalThis } }
    class Derived extends Base { pinned = 1 }
    new Derived()
  } catch (e) {
    second = isOwn(e)
  }
  try {
    let receiver
    Object.defineProperty(globalThis, 'getter', { get() { receiver = this } })
    void globalThis.getter
    Object.preventExtensions(receiver)
    Object.defineProperty(globalThis, 'fresh', { value: 1 })
  } catch (e) {
    third = isOwn(e)
  }
  return first && second && third
})()`,
  h = `(pending, report) => {
  void (async () => {
    await pending
    await {
      then(resolve) {
        report(Object.getPrototypeOf(resolve) === Function.prototype)
        resolve()
      },
    }
  })()
}`,
  n;
function Cun() {
  return ((n ??= d()), n);
}
function Sjs(e) {
  return e !== "passed" && !Mp();
}
function bjs() {
  return n !== void 0;
}
function d() {
  if (!Dm()) return "not_bun";
  try {
    let { drainMicrotasks: e } = Ve("bun:jsc"),
      o = SY({ __proto__: null }, { codeGeneration: { strings: !1, wasm: !1 } }),
      r = t.runInContext(l, o) === !0,
      i,
      { promise: c, resolve: a } = Promise.withResolvers();
    (t.runInContext(h, o)(c, (u) => {
      i = u;
    }),
      queueMicrotask(a),
      e());
    let s = i === !0;
    if (r && s) return "passed";
    if (!r && !s) return "both";
    return r ? "thenable_after_await" : "rejected_definitions";
  } catch (e) {
    switch (typeof e === "object" && e !== null && "name" in e && e.name) {
      case "TypeError":
        return "threw_type_error";
      case "ReferenceError":
        return "threw_reference_error";
      case "SyntaxError":
        return "threw_syntax_error";
      case "RangeError":
        return "threw_range_error";
      default:
        return "threw_other";
    }
  }
}
export { Cun, Sjs, bjs };

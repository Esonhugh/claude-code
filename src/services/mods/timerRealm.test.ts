import { expect, test } from "bun:test";
import * as vm from "node:vm";
import { createModTimerRealm } from "./timerRealm.js";
function fixture() {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const jobs: { callback: () => void; delay: number; repeat: boolean }[] = [];
  const cancelled: unknown[] = [];
  const reports: string[] = [];
  const realm = vm.runInContext(`(${createModTimerRealm.toString()})`, context)(
    {
      schedule: (callback: () => void, delay: number, repeat: boolean) => {
        const job = { callback, delay, repeat };
        jobs.push(job);
        return job;
      },
      cancel: (handle: unknown) => cancelled.push(handle),
      report: (message: string) => reports.push(message),
    },
    "fixture",
  ) as { dispose(): void };
  return {
    context,
    jobs,
    cancelled,
    reports,
    realm,
    run: (code: string) => vm.runInContext(code, context),
  };
}
test("unloading cancels both timer kinds and prevents already queued callbacks from firing", () => {
  const f = fixture();
  expect(
    f.run(
      `globalThis.fired=0;[setTimeout(()=>fired++,100),setInterval(()=>fired++,100)]`,
    ),
  ).toEqual([1, 2]);
  f.realm.dispose();
  f.realm.dispose();
  expect(f.cancelled).toEqual(f.jobs);
  for (const job of f.jobs) job.callback();
  expect(f.run("fired")).toBe(0);
  expect(() => f.run("setTimeout(()=>{},0)")).toThrow(
    "fixture: setTimeout: its environment was unloaded",
  );
});
test("official delay normalization and numeric-only cancellation stay within each VM", () => {
  const a = fixture(),
    b = fixture();
  const values = a.run(
    `[undefined,'10',-1,NaN,Infinity,Symbol('delay'),{valueOf(){throw Error('not coerced')}},2.5].map(delay=>setTimeout(()=>{},delay))`,
  );
  expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(a.jobs.map((job) => job.delay)).toEqual([0, 0, 0, 0, 0, 0, 0, 2.5]);
  expect(b.run("setTimeout(()=>{},1)")).toBe(1);
  a.run(`clearInterval('1');clearTimeout({valueOf(){return 1}})`);
  expect(a.cancelled).toHaveLength(0);
  a.run("clearInterval(1)");
  expect(a.cancelled).toEqual([a.jobs[0]]);
  expect(b.cancelled).toHaveLength(0);
  a.realm.dispose();
  b.realm.dispose();
});

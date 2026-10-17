type TimerHost = {
  schedule(
    callback: () => void,
    milliseconds: number,
    repeat: boolean,
  ): unknown;
  cancel(handle: unknown, repeat: boolean): void;
  report(message: string): void;
};

/** Runs inside one Mod VM; native handles and host functions never leave its closure. */
export function createModTimerRealm(host: TimerHost, plugin: string) {
  let nextId = 0;
  let disposed = false;
  const timers = new Map<number, { handle: unknown; repeat: boolean }>();
  const error = (message: string) =>
    Object.assign(new Error(`${plugin}: ${message}`), { name: "HooksError" });
  const start = (repeat: boolean) =>
    Object.freeze(
      (
        callback: (...args: unknown[]) => unknown,
        milliseconds?: unknown,
        ...args: unknown[]
      ) => {
        const api = repeat ? "setInterval" : "setTimeout";
        if (typeof callback !== "function")
          throw error(`${api} takes a function`);
        if (disposed) throw error(`${api}: its environment was unloaded`);
        // Official 2.1.292 accepts only non-negative finite numbers; every other delay reads as zero.
        const delay =
          typeof milliseconds === "number" &&
          Number.isFinite(milliseconds) &&
          milliseconds >= 0
            ? milliseconds
            : 0;
        const id = ++nextId;
        const report = (failure: unknown) => {
          let text = "an unknown error";
          try {
            text = String(failure);
          } catch {
            /* An unprintable thrown value still gets an attributed diagnostic. */
          }
          host.report(`${api}: the callback threw: ${text}`);
        };
        const handle = host.schedule(
          () => {
            if (disposed || !timers.has(id)) return;
            if (!repeat) timers.delete(id);
            try {
              void Promise.resolve(callback(...args)).catch(report);
            } catch (failure) {
              report(failure);
            }
          },
          delay,
          repeat,
        );
        timers.set(id, { handle, repeat });
        return id;
      },
    );
  const clear = Object.freeze((id: unknown) => {
    if (typeof id !== "number") return;
    const timer = timers.get(id);
    if (!timer) return;
    timers.delete(id);
    host.cancel(timer.handle, timer.repeat);
  });
  Object.assign(globalThis, {
    setTimeout: start(false),
    setInterval: start(true),
    clearTimeout: clear,
    clearInterval: clear,
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of timers.values())
        host.cancel(timer.handle, timer.repeat);
      timers.clear();
    },
  };
}

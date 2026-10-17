import { randomUUID } from "node:crypto";
import { enqueueTracked, remove } from "../../utils/messageQueueManager.js";
import type { ProcessUserInputBaseResult } from "../../utils/processUserInput/processUserInput.js";
import type { QueuedCommand } from "../../types/textInputTypes.js";
import type { CommandRunResult } from "./commandAdapter.js";
export type ModCommandRequest = {
  command: string;
  args: string;
  origin: { kind: "plugin"; name: string };
  signal: AbortSignal;
};

export function commandRunReceipt(
  result: ProcessUserInputBaseResult,
): CommandRunResult {
  const context = result.commandContext ?? [];
  return {
    text: result.commandRunText ?? result.resultText,
    ...(context.length ? { context } : {}),
    ...(result.commandExitCode === undefined
      ? {}
      : { exitCode: result.commandExitCode }),
  };
}
/** Uses the same queue and slash executor as Enter; the receipt settles after command execution. */
export function createModCommandQueue({
  owner,
  wake,
}: { owner?: symbol; wake?: () => void | Promise<void> } = {}) {
  return ({
    command,
    args,
    origin,
    signal,
  }: ModCommandRequest): Promise<CommandRunResult> =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        fn();
      };
      const fail = (reason: unknown) => {
        finish(() => reject(reason));
        if (queued) remove([queued]);
      };
      const cancel = () => fail(signal.reason);
      const queued: QueuedCommand = enqueueTracked({
        uuid: randomUUID(),
        value: args === "" ? `/${command}` : `/${command} ${args}`,
        mode: "prompt",
        priority: "later",
        ...(owner ? { promptSubmitOwner: owner } : {}),
        promptSubmitMetadata: { origin, wait: false },
        commandRunReceipt: {
          admit: (result) => finish(() => resolve(commandRunReceipt(result))),
          cancel: fail,
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else
        try {
          void Promise.resolve(wake?.()).catch(fail);
        } catch (error) {
          fail(error);
        }
    });
}

import { isDeepStrictEqual } from "node:util";
import type { AppState } from "../../state/AppState.js";
import { isTerminalTaskStatus } from "../../taskStatus.js";
import { listAllLiveSessions } from "../../utils/udsClient.js";
import { formatPeerAddress } from "../../utils/peerProtocol.js";
import type { ModInput } from "./types.js";
import type { ModSnapshot } from "./runtime.js";
import type { ToolCallResult } from "./toolAdapter.js";

export type SessionSendAddress =
  | string
  | { sessionId: string }
  | { agentId: string };
export type SessionSendArgs = { to: SessionSendAddress; text: string };
export type SessionSendInput = {
  to: string;
  text: string;
  origin: { kind: "model" } | { kind: "plugin"; name: string };
  agentId?: string;
};
export type SessionSendResult =
  | { isDelivered: true; reason?: undefined }
  | { isDelivered: false; reason: string };
const argumentProblem =
  "takes { to, text }: to a name, an agent id or an address (a non-empty string), { sessionId } or { agentId }; text a non-empty string";

export function modSessionSendArgs(
  value: unknown,
  plugin?: string,
): SessionSendArgs {
  const arg =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as ModInput)
      : undefined;
  const to = arg?.to;
  const address =
    typeof to === "string"
      ? to
      : to &&
          typeof to === "object" &&
          !Array.isArray(to) &&
          Object.hasOwn(to, "sessionId") !== Object.hasOwn(to, "agentId")
        ? ((to as ModInput).sessionId ?? (to as ModInput).agentId)
        : undefined;
  if (
    typeof address !== "string" ||
    !address.trim() ||
    typeof arg?.text !== "string" ||
    !arg.text.trim()
  )
    throw Object.assign(
      new Error(
        `${plugin ? `${plugin}: ` : ""}$.session.send ${argumentProblem}`,
      ),
      { name: "HooksError" },
    );
  return {
    to:
      typeof to === "string"
        ? to
        : Object.hasOwn(to as object, "sessionId")
          ? { sessionId: address }
          : { agentId: address },
    text: arg.text,
  };
}

export async function resolveModSessionSendAddress(
  to: SessionSendAddress,
  tasks: AppState["tasks"] = {},
): Promise<{ to: string } | { reason: string }> {
  if (typeof to === "string") return { to };
  if ("agentId" in to) {
    for (const task of Object.values(tasks)) {
      if (
        task.type === "in_process_teammate" &&
        !isTerminalTaskStatus(task.status) &&
        (task.identity.agentId === to.agentId ||
          ("resumableAgentId" in task.identity &&
            task.identity.resumableAgentId === to.agentId))
      )
        return { to: task.identity.agentName };
    }
    return to.agentId.includes("@")
      ? {
          reason: `no live teammate of this session has the address ${to.agentId}`,
        }
      : { to: to.agentId };
  }
  const live = (await listAllLiveSessions()).find(
    (session) => session.sessionId === to.sessionId,
  );
  if (live) return { to: formatPeerAddress(live.messagingSocketPath) };
  if (to.sessionId.startsWith("session_") || to.sessionId.startsWith("cse_"))
    return { to: `bridge:${to.sessionId}` };
  return {
    reason: `no live session on this machine has id ${to.sessionId} (a session that exited, or another machine's; a Remote Control or cloud session is addressed by its session_... id)`,
  };
}

export function sessionSendToolResult(
  receipt: ToolCallResult,
): SessionSendResult {
  if (receipt.deny !== undefined)
    return { isDelivered: false, reason: receipt.deny };
  const data =
    receipt.result &&
    typeof receipt.result === "object" &&
    !Array.isArray(receipt.result)
      ? (receipt.result as ModInput)
      : undefined;
  if (!receipt.isError && data?.success === true) return { isDelivered: true };
  return {
    isDelivered: false,
    reason:
      typeof data?.message === "string" && data.message !== ""
        ? data.message
        : receipt.text || "the SendMessage tool did not deliver it",
  };
}

export function validateSessionSendResult(
  value: unknown,
): asserts value is SessionSendResult {
  const result =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as ModInput)
      : undefined;
  if (result?.isDelivered === true) return;
  if (
    result?.isDelivered !== false ||
    typeof result.reason !== "string" ||
    result.reason === ""
  )
    throw new TypeError(
      "session.send requires isDelivered true or false with a non-empty reason",
    );
}

export async function runModSessionSend(
  snapshot: ModSnapshot | undefined,
  input: SessionSendInput,
  send: (
    input: SessionSendInput,
    signal?: AbortSignal,
  ) => Promise<SessionSendResult>,
  signal: AbortSignal,
): Promise<SessionSendResult> {
  signal.throwIfAborted();
  const initial = structuredClone(input);
  const result = snapshot
    ? await snapshot.dispatch(
        "session.send",
        initial,
        (value, branch) => send(value as SessionSendInput, branch),
        {
          signal,
          validateResult: validateSessionSendResult,
          restoreInput: (value, received) => ({
            ...value,
            ...(received.agentId === undefined
              ? {}
              : { agentId: value.agentId ?? received.agentId }),
          }),
          validateInput(value) {
            if (!isDeepStrictEqual(value.origin, initial.origin))
              throw new Error("session.send cannot rewrite origin");
            if (value.agentId !== initial.agentId)
              throw new Error("session.send cannot rewrite agentId");
            if (
              typeof value.to !== "string" ||
              !value.to.trim() ||
              typeof value.text !== "string" ||
              !value.text.trim()
            )
              throw new TypeError(
                "session.send requires non-empty to and text",
              );
          },
        },
      )
    : await send(initial, signal);
  signal.throwIfAborted();
  validateSessionSendResult(result);
  return result;
}

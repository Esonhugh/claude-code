import { isAnthropicTelemetryEnabled } from "../analytics/config.js";
import { isTelemetryDisabled } from "../../utils/privacyLevel.js";
import { getSettings_DEPRECATED } from "../../utils/settings/settings.js";
import type { ModInput, ModOrigin } from "./types.js";

export type ModTelemetryEvent = "telemetry.log" | "telemetry.mark";
const entryShape = {
  "telemetry.log": "({ to?, event, props? } or a collector record)",
  "telemetry.mark": "({ feature, kind, reason?, props? })",
};
export function modTelemetryArgs(
  event: ModTelemetryEvent,
  value: unknown,
  plugin?: string,
): ModInput {
  const prefix = plugin ? `${plugin}: ` : "";
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(
      new Error(`${prefix}$.${event} takes an entry ${entryShape[event]}`),
      { name: "HooksError" },
    );
  const entry = value as ModInput;
  const keys =
    event === "telemetry.log"
      ? ["to", "event", "props", "attributes", "loggedAt", "span"]
      : ["feature", "kind", "reason", "props"];
  const input = Object.fromEntries(
    keys
      .filter((key) => entry[key] !== undefined)
      .map((key) => [key, entry[key]]),
  );
  if (event === "telemetry.log") {
    if (
      input.to !== undefined &&
      input.to !== "anthropic" &&
      input.to !== "collector"
    )
      throw Object.assign(
        new Error(
          `${prefix}telemetry.log: takes an entry ({ to?, event, ... }, to "anthropic" or "collector") (host check)`,
        ),
        { name: "HooksError" },
      );
    input.to ??= "anthropic";
  }
  return input;
}

/** The public API does not send rows itself; the first-party plugin owns sending.
 * Local analytics remains opt-in, and Privacy Mode suppresses that plugin.
 */
export function modTelemetryCoreResult(
  origin: ModOrigin,
): { value: undefined } | { deny: string } {
  if (
    isAnthropicTelemetryEnabled() &&
    !isTelemetryDisabled() &&
    getSettings_DEPRECATED()?.enabledPlugins?.[
      "cc-plugin-telemetry@builtin"
    ] !== false &&
    origin.tier !== "builtin" &&
    origin.tier !== "core"
  )
    return {
      deny: "$.telemetry serves the plugins built into Claude Code alone",
    };
  return { value: undefined };
}

export function modTelemetryResult(
  event: ModTelemetryEvent,
  result: { deny?: string },
  plugin: string,
): undefined {
  if (result.deny !== undefined)
    throw Object.assign(new Error(`${plugin}: $.${event}: ${result.deny}`), {
      name: "HooksError",
    });
  // Even a hook supplying a non-undefined value cannot change this void API.
  return undefined;
}

export function validateModTelemetryResult(
  event: ModTelemetryEvent,
  result: unknown,
): void {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new TypeError(`${event} must return value or deny`);
  const value = result as ModInput;
  if (
    value.deny === undefined
      ? !Object.hasOwn(value, "value")
      : typeof value.deny !== "string" || Object.hasOwn(value, "value")
  )
    throw new TypeError(`${event} must return value or deny`);
}

import type { AppState } from "../../state/AppStateStore.js";
import {
  getPluginErrorMessage,
  type LoadedPlugin,
  type PluginError,
} from "../../types/plugin.js";
import { getPluginMcpServers } from "../../utils/plugins/mcpPluginIntegration.js";
import { isBareMode } from "../../utils/envUtils.js";
import { logForDebugging } from "../../utils/debug.js";
import { errorMessage } from "../../utils/errors.js";
import {
  connectToServer,
  clearServerCache,
  fetchToolsForClient,
  fetchCommandsForClient,
  fetchResourcesForClient,
} from "../mcp/client.js";
import {
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getMcpServerSignature,
  isMcpServerDisabled,
} from "../mcp/config.js";
import { commandBelongsToServer } from "../mcp/utils.js";
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from "../mcp/types.js";

export type ModMcpConnectResult =
  | { isConnected: true; server: string }
  | {
      isConnected: false;
      reason:
        | "unlisted"
        | "unapproved"
        | "disabled"
        | "policy"
        | "auth"
        | "failed";
      message: string;
    };
export function unlistedModMcpServer(key: string): ModMcpConnectResult {
  return {
    isConnected: false,
    reason: "unlisted",
    message: `This plugin's manifest lists no MCP server named "${key}".`,
  };
}

/** Uses the session's existing credentials, connection cache, and tool catalogs. */
export function createModMcpConnections({
  getState,
  setState,
  policyReason,
}: {
  getState(): AppState;
  setState(update: (state: AppState) => AppState): void;
  policyReason?(): string | undefined;
}) {
  const pending = new Map<string, Promise<MCPServerConnection>>();
  const owned = new Map<string, Set<string>>();
  const refusal = (
    reason: Extract<ModMcpConnectResult, { isConnected: false }>["reason"],
    message: string,
  ): ModMcpConnectResult => ({ isConnected: false, reason, message });
  const stateResult = (client: MCPServerConnection): ModMcpConnectResult => {
    if (client.type === "connected")
      return { isConnected: true, server: client.name };
    if (client.type === "needs-auth")
      return refusal(
        "auth",
        `The MCP server "${client.name}" needs you to sign in; run /mcp to authenticate.`,
      );
    if (client.type === "disabled")
      return refusal(
        "failed",
        `The MCP server "${client.name}" is turned off in this session.`,
      );
    return refusal(
      "failed",
      `The MCP server "${client.name}" did not connect: ${client.type === "failed" ? (client.error ?? "no reason given") : "still connecting"}.`,
    );
  };
  async function remove(name: string) {
    const client = getState().mcp.clients.find((row) => row.name === name);
    setState((state) => ({
      ...state,
      mcp: {
        ...state.mcp,
        clients: state.mcp.clients.filter((row) => row.name !== name),
        tools: state.mcp.tools.filter(
          (tool) => tool.mcpInfo?.serverName !== name,
        ),
        commands: state.mcp.commands.filter(
          (command) => !commandBelongsToServer(command, name),
        ),
        resources: Object.fromEntries(
          Object.entries(state.mcp.resources).filter(
            ([server]) => server !== name,
          ),
        ),
      },
    }));
    if (client) await clearServerCache(name, client.config);
  }
  return {
    async connect(
      plugin: LoadedPlugin | undefined,
      key: string,
      signal: AbortSignal,
    ): Promise<ModMcpConnectResult> {
      const run = async (): Promise<ModMcpConnectResult> => {
        try {
          if (!plugin) return unlistedModMcpServer(key);
          const name = `plugin:${plugin.name}:${key}`;
          const errors: PluginError[] = [];
          const config = (await getPluginMcpServers(plugin, errors))?.[name];
          if (!config) {
            const problem = errors.find(
              (error) =>
                "source" in error &&
                (error.source === key || error.source === name),
            );
            return problem
              ? refusal(
                  "failed",
                  `The MCP server "${name}" cannot be resolved: ${getPluginErrorMessage(problem)}`,
                )
              : unlistedModMcpServer(key);
          }
          if (isMcpServerDisabled(name))
            return refusal(
              "disabled",
              `The MCP server "${name}" is turned off; turn it on in /mcp.`,
            );
          const blocked =
            policyReason?.() ??
            (isBareMode()
              ? "This session runs with --bare, which connects no plugin servers."
              : doesEnterpriseMcpConfigExist()
                ? "Your organization's managed MCP config has exclusive control over MCP servers in this session."
                : undefined);
          if (blocked) return refusal("policy", blocked);
          if (filterMcpServersByPolicy({ [name]: config }).blocked.length)
            return refusal(
              "policy",
              `Your organization's MCP policy does not allow "${name}".`,
            );
          signal.throwIfAborted();
          const signature = getMcpServerSignature(config);
          const existing = getState().mcp.clients.find(
            (client) =>
              client.name === name ||
              (client.type !== "disabled" &&
                signature !== null &&
                getMcpServerSignature(client.config) === signature),
          );
          if (
            existing?.type === "connected" ||
            existing?.type === "needs-auth" ||
            existing?.type === "disabled"
          )
            return stateResult(existing as MCPServerConnection);
          const target = existing?.name ?? name;
          const targetConfig = existing?.config ?? config;
          let connection = pending.get(target);
          if (!connection) {
            connection = connectToServer(
              target,
              targetConfig as ScopedMcpServerConfig,
            ).finally(() => pending.delete(target));
            pending.set(target, connection);
          }
          const client = await connection;
          const result = stateResult(client);
          if (client.type === "connected") {
            const [tools, commands, resources] = await Promise.all([
              fetchToolsForClient(client),
              fetchCommandsForClient(client),
              client.capabilities.resources
                ? fetchResourcesForClient(client)
                : Promise.resolve([]),
            ]);
            setState((state) => ({
              ...state,
              mcp: {
                ...state.mcp,
                clients: [
                  ...state.mcp.clients.filter((row) => row.name !== target),
                  client,
                ],
                tools: [
                  ...state.mcp.tools.filter(
                    (tool) => tool.mcpInfo?.serverName !== target,
                  ),
                  ...tools,
                ],
                commands: [
                  ...state.mcp.commands.filter(
                    (command) => !commandBelongsToServer(command, target),
                  ),
                  ...commands,
                ],
                resources: { ...state.mcp.resources, [target]: resources },
              },
            }));
            if (!existing) {
              const names = owned.get(plugin.source) ?? new Set<string>();
              names.add(target);
              owned.set(plugin.source, names);
            }
          }
          return result;
        } catch (error) {
          return refusal(
            "failed",
            `The MCP server "${key}" did not connect: ${errorMessage(error)}.`,
          );
        }
      };
      const result = await run();
      logForDebugging(
        `[Mods:${plugin?.name ?? "engine"}] $.mcp.connect(${key}): ${result.isConnected === true ? result.server : result.reason}`,
      );
      return result;
    },
    async release(source: string) {
      const names = owned.get(source);
      owned.delete(source);
      if (names) await Promise.all([...names].map(remove));
    },
  };
}

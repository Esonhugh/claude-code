import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModsRuntime } from "./runtime.js";

test("mcp.connect returns the official unlisted refusal without disabling the plugin", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "mods-mcp-connect-")),
  );
  const keys = [
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const saved = keys.map((key) => process.env[key]);
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-mcp-connect-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const runtime = createModsRuntime();
  try {
    const path = join(root, "register.mjs");
    await writeFile(
      path,
      `export function register(on){on('tool.call',async($)=>({result:await $.mcp.connect('missing')}));}`,
    );
    await runtime.reconcile([
      {
        name: "mcp-test",
        storageId: "mcp-test@local",
        pluginRoot: root,
        entrypoints: [path],
      },
    ]);
    expect(
      await runtime.dispatch("tool.call", {}, async () => ({
        result: "fallback",
      })),
    ).toEqual({
      result: {
        isConnected: false,
        reason: "unlisted",
        message: 'This plugin\'s manifest lists no MCP server named "missing".',
      },
    });
  } finally {
    await runtime.dispose();
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("listed servers connect through the real cache, publish catalogs, and release only owned connections", async () => {
  const { createModMcpConnections } = await import("./mcpConnect.js");
  const { getDefaultAppState } = await import("../../state/AppStateStore.js");
  const { getPluginMcpServers } =
    await import("../../utils/plugins/mcpPluginIntegration.js");
  const {
    connectToServer,
    getServerCacheKey,
    fetchToolsForClient,
    fetchCommandsForClient,
    fetchResourcesForClient,
  } = await import("../mcp/client.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-mcp-host-")));
  const keys = [
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const saved = keys.map((key) => process.env[key]);
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-mcp-connect-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const { resetSettingsCache } =
    await import("../../utils/settings/settingsCache.js");
  resetSettingsCache();
  let cacheKey: string | undefined;
  try {
    const plugin = {
      name: "cache-probe",
      source: "cache-probe@inline",
      repository: "cache-probe@inline",
      path: root,
      manifest: { name: "cache-probe" },
      enabled: true,
      mcpServers: {
        browser: {
          type: "stdio" as const,
          command: "unused-cache-probe",
          args: [],
        },
      },
    };
    const name = "plugin:cache-probe:browser";
    const config = (await getPluginMcpServers(plugin))![name]!;
    let cleanups = 0;
    const requests: string[] = [];
    const connected = {
      name,
      type: "connected" as const,
      config,
      capabilities: { tools: {}, prompts: {}, resources: {} },
      cleanup: async () => {
        cleanups++;
      },
      client: {
        request: async ({ method }: { method: string }) => {
          requests.push(method);
          if (method === "tools/list")
            return {
              tools: [
                {
                  name: "ping",
                  description: "ping",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            };
          if (method === "prompts/list")
            return { prompts: [{ name: "help", description: "help" }] };
          if (method === "resources/list")
            return { resources: [{ uri: "test://page", name: "page" }] };
          throw Error("Unexpected MCP request: " + method);
        },
      },
    } as unknown as import("../mcp/types.js").ConnectedMCPServer;
    cacheKey = getServerCacheKey(name, config);
    const pending =
      Promise.withResolvers<import("../mcp/types.js").MCPServerConnection>();
    connectToServer.cache.set(cacheKey, pending.promise);
    let state = getDefaultAppState();
    const host = createModMcpConnections({
      getState: () => state,
      setState: (update) => {
        state = update(state);
      },
    });
    const a = host.connect(plugin, "browser", new AbortController().signal);
    const b = host.connect(plugin, "browser", new AbortController().signal);
    pending.resolve(connected);
    expect(await a).toEqual({ isConnected: true, server: name });
    expect(await b).toEqual({ isConnected: true, server: name });
    expect(state.mcp.clients.map((client) => client.name)).toEqual([name]);
    expect(state.mcp.tools.map((tool) => tool.name)).toEqual([
      "mcp__plugin_cache-probe_browser__ping",
    ]);
    expect(state.mcp.commands).toHaveLength(1);
    expect(state.mcp.resources[name]?.map((resource) => resource.uri)).toEqual([
      "test://page",
    ]);
    expect(requests.toSorted()).toEqual([
      "prompts/list",
      "resources/list",
      "tools/list",
    ]);
    expect(
      await host.connect(plugin, "browser", new AbortController().signal),
    ).toEqual({ isConnected: true, server: name });
    await host.release(plugin.source);
    expect(cleanups).toBe(1);
    expect(connectToServer.cache.has(cacheKey)).toBe(false)
    expect(state.mcp.clients).toEqual([]);
    expect(state.mcp.tools).toEqual([]);
    expect(state.mcp.commands).toEqual([]);
    expect(state.mcp.resources).toEqual({});
    fetchToolsForClient.cache.delete(name);
    fetchCommandsForClient.cache.delete(name);
    fetchResourcesForClient.cache.delete(name);
  } finally {
    if (cacheKey) connectToServer.cache.delete(cacheKey);
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    resetSettingsCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("a listed twin keeps its existing name and ownership; policy and authentication are structured refusals", async () => {
  const { createModMcpConnections } = await import("./mcpConnect.js");
  const { getDefaultAppState } = await import("../../state/AppStateStore.js");
  const { getPluginMcpServers } =
    await import("../../utils/plugins/mcpPluginIntegration.js");
  const { resetSettingsCache } =
    await import("../../utils/settings/settingsCache.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "mods-mcp-twin-")));
  const keys = [
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const saved = keys.map((key) => process.env[key]);
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  process.env.ANTHROPIC_API_KEY = "sk-mcp-connect-placeholder";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  resetSettingsCache();
  try {
    const plugin = {
      name: "twin-probe",
      source: "twin-probe@inline",
      repository: "twin-probe@inline",
      path: root,
      manifest: { name: "twin-probe" },
      enabled: true,
      mcpServers: {
        browser: {
          type: "stdio" as const,
          command: "unused-twin-probe",
          args: [],
        },
      },
    };
    const config = (await getPluginMcpServers(plugin))![
      "plugin:twin-probe:browser"
    ]!;
    let state = getDefaultAppState(),
      cleanups = 0;
    const existing = {
      name: "manual-browser",
      type: "connected" as const,
      config,
      capabilities: {},
      cleanup: async () => {
        cleanups++;
      },
      client: {},
    } as unknown as import("../mcp/types.js").ConnectedMCPServer;
    state = { ...state, mcp: { ...state.mcp, clients: [existing] } };
    const host = createModMcpConnections({
      getState: () => state,
      setState: (update) => {
        state = update(state);
      },
    });
    expect(
      await host.connect(plugin, "browser", new AbortController().signal),
    ).toEqual({ isConnected: true, server: "manual-browser" });
    await host.release(plugin.source);
    expect(state.mcp.clients).toEqual([existing]);
    expect(cleanups).toBe(0);
    const blocked = createModMcpConnections({
      getState: () => state,
      setState: (update) => {
        state = update(state);
      },
      policyReason: () =>
        "This session runs with --strict-mcp-config, which connects no plugin servers.",
    });
    expect(
      await blocked.connect(plugin, "browser", new AbortController().signal),
    ).toEqual({
      isConnected: false,
      reason: "policy",
      message:
        "This session runs with --strict-mcp-config, which connects no plugin servers.",
    });
    state = {
      ...state,
      mcp: {
        ...state.mcp,
        clients: [{ name: "manual-browser", type: "needs-auth", config }],
      },
    };
    expect(
      await host.connect(plugin, "browser", new AbortController().signal),
    ).toEqual({
      isConnected: false,
      reason: "auth",
      message:
        'The MCP server "manual-browser" needs you to sign in; run /mcp to authenticate.',
    });
    expect(
      await host.connect(plugin, "other", new AbortController().signal),
    ).toEqual({
      isConnected: false,
      reason: "unlisted",
      message: 'This plugin\'s manifest lists no MCP server named "other".',
    });
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    resetSettingsCache();
    await rm(root, { recursive: true, force: true });
  }
});

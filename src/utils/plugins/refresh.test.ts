import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppState } from "../../state/AppState.js";
import type { Command } from "../../commands.js";
import type { LoadedPlugin as Plugin } from "../../types/plugin.js";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("explicit MCP reload invalidates unchanged plugin connections only", async () => {
  const { excludeStalePluginClients } =
    await import("../../services/mcp/utils.js");
  const config = { command: "fixture", args: [], scope: "dynamic" as const };
  const clients = ["plugin:fixture:server", "other"].map((name) => ({
    name,
    type: "pending" as const,
    config,
  }));
  const configs = Object.fromEntries(
    clients.map((client) => [client.name, config]),
  );
  const result = excludeStalePluginClients(
    { clients, tools: [], commands: [], resources: {} },
    configs,
    true,
  );
  expect(result.stale.map((client) => client.name)).toEqual([
    "plugin:fixture:server",
  ]);
  expect(result.clients.map((client) => client.name)).toEqual(["other"]);
  const removed = excludeStalePluginClients(
    { clients, tools: [], commands: [], resources: {} },
    {},
    true,
  );
  expect(removed.clients.map((client) => client.name)).toEqual(["other"]);
});

test("explicit MCP reload removes plugin capabilities but preserves other servers and local commands", async () => {
  const { excludeStalePluginClients } =
    await import("../../services/mcp/utils.js");
  const clients = [
    { name: "plugin:fixture:server", scope: "dynamic" as const },
    { name: "other", scope: "dynamic" as const },
    { name: "plugin:user:server", scope: "user" as const },
  ].map(({ name, scope }) => ({
    name,
    type: "pending" as const,
    config: { command: "fixture", args: [], scope },
  }));
  type McpState = Parameters<typeof excludeStalePluginClients>[0];
  const tools = [
    { name: "mcp__plugin_fixture_server__tool" },
    { name: "mcp__other__tool" },
    { name: "local-tool" },
  ] as McpState["tools"];
  const commands = [
    { name: "mcp__plugin_fixture_server__prompt" },
    { name: "catalog-skill", mcpServerName: "plugin:fixture:server" },
    { name: "mcp__other__prompt" },
    { name: "local-command" },
  ] as Command[];
  const resources = {
    "plugin:fixture:server": [
      {
        uri: "fixture://plugin",
        name: "plugin",
        server: "plugin:fixture:server",
      },
    ],
    other: [{ uri: "fixture://other", name: "other", server: "other" }],
  };
  const mcp = { clients, tools, commands, resources };
  for (const configs of [
    Object.fromEntries(clients.map((c) => [c.name, c.config])),
    {},
  ]) {
    const result = excludeStalePluginClients(mcp, configs, true);
    expect(result.stale).toEqual([clients[0]!]);
    expect(result.clients).toEqual(clients.slice(1));
    expect(result.tools).toEqual(tools.slice(1));
    expect(result.commands).toEqual(commands.slice(2));
    expect(result.resources).toEqual({ other: resources.other });
  }
  expect(mcp.tools).toHaveLength(3);
  expect(mcp.commands).toHaveLength(4);
  expect(Object.keys(mcp.resources)).toHaveLength(2);
});

const childProcessEnv = "CLAUDE_CODE_PLUGIN_REFRESH_TEST_CHILD";

if (process.env[childProcessEnv] === "install-update") {
  await runInstallUpdateTests();
} else if (process.env[childProcessEnv] === "1") {
  await runIsolatedTests();
} else {
  test("passes isolated refresh behavior tests", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "--timeout", "30000", import.meta.path],
      {
        cwd: import.meta.dir,
        env: { ...process.env, [childProcessEnv]: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Isolated refresh tests failed (${exitCode})\n${stdout}\n${stderr}`,
      );
    }
    expect(exitCode).toBe(0);
  }, 35000);
}

if (!process.env[childProcessEnv]) {
  test("real local install v1 → update v2 → cache-only reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-refresh-install-"));
    try {
      const child = Bun.spawn(
        [process.execPath, "test", "--timeout", "30000", import.meta.path],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            CLAUDE_CONFIG_DIR: join(root, "config"),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            [childProcessEnv]: "install-update",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `Real install/update tests failed (${exitCode})\n${stdout}\n${stderr}`,
        );
      }
      expect(exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35000);
}

async function runInstallUpdateTests(): Promise<void> {
  (globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: "test",
  };
  test("materializes the new version before refresh replaces active components", async () => {
    const root = process.env.HOME!;
    const marketplace = join(root, "marketplace");
    const plugin = join(marketplace, "fixture");
    const write = (path: string, content: unknown) => {
      writeFileSync(
        path,
        typeof content === "string" ? content : JSON.stringify(content),
      );
    };
    for (const path of [
      join(marketplace, ".claude-plugin"),
      join(plugin, ".claude-plugin"),
      join(plugin, "commands"),
      join(plugin, "skills", "standalone"),
      join(plugin, "agents"),
    ])
      mkdirSync(path, { recursive: true });
    write(join(marketplace, ".claude-plugin", "marketplace.json"), {
      name: "refresh-local",
      owner: { name: "fixture" },
      plugins: [{ name: "fixture", source: "./fixture" }],
    });
    const writeVersion = (version: string) => {
      write(join(plugin, ".claude-plugin", "plugin.json"), {
        name: "fixture",
        version,
      });
      write(
        join(plugin, "commands", "version.md"),
        `---\ndescription: command ${version}\n---\ncommand ${version}\n`,
      );
      write(
        join(plugin, "skills", "standalone", "SKILL.md"),
        `---\nname: standalone\ndescription: skill ${version}\n---\nskill ${version}\n`,
      );
      write(
        join(plugin, "agents", "version.md"),
        `---\nname: version-agent\ndescription: agent ${version}\n---\nagent ${version}\n`,
      );
    };
    writeVersion("1.0.0");
    const { setOriginalCwd } = await import("../../bootstrap/state.js");
    setOriginalCwd(root);
    const { addMarketplaceSource } = await import("./marketplaceManager.js");
    const { installPluginOp, updatePluginOp } =
      await import("../../services/plugins/pluginOperations.js");
    const installed = await import("./installedPluginsManager.js");
    const { refreshActivePlugins } = await import("./refresh.js");
    const id = "fixture@refresh-local";
    expect(
      (await addMarketplaceSource({ source: "directory", path: marketplace }))
        .name,
    ).toBe("refresh-local");
    const installation = await installPluginOp(id, "user");
    expect(installation.success).toBe(true);
    const diskV1 = installed.loadInstalledPluginsFromDisk().plugins[id]![0]!;
    expect(diskV1.version).toBe("1.0.0");
    let state = {
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: {
        pluginReconnectKey: 0,
        clients: [],
        tools: [],
        commands: [],
        resources: {},
      },
      agentDefinitions: { allAgents: [], activeAgents: [] },
    } as unknown as AppState;
    const setAppState = (update: (previous: AppState) => AppState) => {
      state = update(state);
    };
    const v1 = await refreshActivePlugins(setAppState);
    expect(v1.error_count).toBe(0);
    expect(v1.enabled_count).toBe(1);
    expect(v1.command_count).toBe(1);
    expect(v1.skill_count).toBe(1);
    writeVersion("2.0.0");
    // Editing the marketplace alone must not advance the installed version.
    const beforeUpdate = await refreshActivePlugins(setAppState);
    expect(beforeUpdate.error_count).toBe(0);
    expect(state.plugins.enabled[0]!.manifest.version).toBe("1.0.0");
    expect(
      state.plugins.commands.map((command) => command.description),
    ).toEqual(["command 1.0.0", "skill 1.0.0"]);
    const refreshedSnapshot = installed.getInMemoryInstalledPlugins();
    const commandsBeforeUpdate = state.plugins.commands;
    const update = await updatePluginOp(id, "user");
    expect(update).toMatchObject({
      success: true,
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
    });
    const diskV2 = installed.loadInstalledPluginsFromDisk().plugins[id]![0]!;
    expect(diskV2.version).toBe("2.0.0");
    expect(diskV2.installPath).not.toBe(diskV1.installPath);
    expect(
      readFileSync(join(diskV2.installPath, "commands", "version.md"), "utf8"),
    ).toContain("command 2.0.0");
    expect(installed.getInMemoryInstalledPlugins()).toBe(refreshedSnapshot);
    expect(refreshedSnapshot.plugins[id]![0]!.version).toBe("1.0.0");
    expect(state.plugins.commands).toBe(commandsBeforeUpdate);
    // Keep marketplace metadata, but remove source: refresh cannot reinstall it.
    rmSync(plugin, { recursive: true, force: true });
    const v2 = await refreshActivePlugins(setAppState);
    expect(state.plugins.errors).toEqual([]);
    expect(v2.error_count).toBe(0);
    expect(v2.enabled_count).toBe(1);
    expect(v2.command_count).toBe(1);
    expect(v2.skill_count).toBe(1);
    expect(state.plugins.enabled[0]!.manifest.version).toBe("2.0.0");
    expect(
      state.plugins.commands.map((command) => command.description),
    ).toEqual(["command 2.0.0", "skill 2.0.0"]);
    expect(
      state.agentDefinitions.allAgents.some(
        (agent) => agent.whenToUse === "agent 2.0.0",
      ),
    ).toBe(true);
    expect(state.mcp.pluginReconnectKey).toBe(3);
    expect(state.plugins.needsRefresh).toBe(false);
    expect(
      installed.getInMemoryInstalledPlugins().plugins[id]![0]!.version,
    ).toBe("2.0.0");
  });
}

describe("plugin reload session wiring", () => {
  // REPL owns this inline useMemo; exercising the component requires a full session.
  test("REPL filters startup plugin commands after reload (source guard only)", () => {
    const repl = source("../../screens/REPL.tsx");
    expect(repl).toContain("mcp.pluginReconnectKey > 0");
    expect(repl).toContain(
      "command.type !== 'prompt' || command.source !== 'plugin'",
    );
  });
});

async function runIsolatedTests(): Promise<void> {
  (globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: "test",
  };
  // Keep the real manager: both its file cache and session snapshot must expire.
  const installed = await import("./installedPluginsManager.js");
  const fsOperations = await import("../fsOperations.js");
  const pluginLoader = await import("./pluginLoader.js");
  const bootstrap = await import("../../bootstrap/state.js");
  const settingsSync = await import("../../services/settingsSync/index.js");
  let diskVersion = "old";
  let reads: string[] = [];
  let observations: string[] = [];
  let commands: Command[] = [];
  let skills: Command[] = [];
  let enabled: Plugin[] = [];
  let disabled: Plugin[] = [];
  let agents = {
    allAgents: [{ agentType: "fixture-agent" }],
    activeAgents: [],
  } as AppState["agentDefinitions"];
  const reinitialize = mock(() => {});
  const loadHooks = mock(async () => {});
  const readSnapshot = () =>
    installed.getInMemoryInstalledPlugins().plugins["fixture@market"]![0]!
      .version!;

  mock.module("../fsOperations.js", () => ({
    ...fsOperations,
    getFsImplementation: () => ({
      readFileSync: (path: string) => {
        expect(path).toBe(installed.getInstalledPluginsFilePath());
        reads.push(diskVersion);
        return JSON.stringify({
          version: 2,
          plugins: {
            "fixture@market": [
              {
                scope: "user",
                installPath: "/fixture/plugin",
                version: diskVersion,
                installedAt: "2026-09-01T00:00:00.000Z",
                lastUpdated: "2026-09-01T00:00:00.000Z",
              },
            ],
          },
        });
      },
    }),
  }));
  mock.module("./cacheUtils.js", () => ({
    clearAllCaches: () => {
      observations.push(`caches:${readSnapshot()}`);
    },
  }));
  mock.module("./orphanedPluginFilter.js", () => ({
    clearPluginCacheExclusions: () => {},
  }));
  mock.module("./pluginLoader.js", () => ({
    ...pluginLoader,
    loadAllPluginsCacheOnly: async () => {
      observations.push(`plugins:${readSnapshot()}`);
      return { enabled, disabled, errors: [] };
    },
  }));
  mock.module("./loadPluginCommands.js", () => ({
    getPluginCommands: async () => commands,
    getPluginSkills: async () => skills,
  }));
  mock.module("../../tools/AgentTool/loadAgentsDir.js", () => ({
    getAgentDefinitionsWithOverrides: async () => agents,
  }));
  mock.module("../../services/lsp/manager.js", () => ({
    reinitializeLspServerManager: reinitialize,
  }));
  mock.module("./loadPluginHooks.js", () => ({ loadPluginHooks: loadHooks }));
  mock.module("./mcpPluginIntegration.js", () => ({
    loadPluginMcpServers: async () => ({
      one: { command: "fixture", args: [] },
      two: { command: "fixture", args: [] },
    }),
  }));
  mock.module("./lspPluginIntegration.js", () => ({
    loadPluginLspServers: async () => ({ language: { command: "fixture" } }),
  }));
  mock.module("../../bootstrap/state.js", () => ({
    ...bootstrap,
    getIsRemoteMode: () => false,
  }));
  mock.module("../../services/settingsSync/index.js", () => ({
    ...settingsSync,
    redownloadUserSettings: async () => false,
  }));
  const { refreshActivePlugins } = await import("./refresh.js");
  const { call } =
    await import("../../commands/reload-plugins/reload-plugins.js");

  const command = (name: string) =>
    ({
      name,
      type: "prompt",
      source: "plugin",
    }) as Command;
  const initialState = () =>
    ({
      plugins: {
        enabled: [{ name: "old" }],
        disabled: [],
        commands: [command("old:command"), command("old:skill")],
        errors: [],
        needsRefresh: true,
      },
      mcp: {
        pluginReconnectKey: 4,
        clients: [],
        tools: [],
        commands: [],
        resources: {},
      },
      agentDefinitions: { allAgents: [], activeAgents: [] },
      verbose: true,
    }) as unknown as AppState;

  beforeEach(() => {
    installed.clearInstalledPluginsCache();
    diskVersion = "old";
    reads = [];
    observations = [];
    commands = [command("new:command")];
    skills = [command("new:skill-a"), command("new:skill-b")];
    enabled = [
      {
        name: "new",
        hooksConfig: {
          PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      },
    ] as Plugin[];
    disabled = [{ name: "disabled" }] as Plugin[];
    agents = {
      allAgents: [{ agentType: "fixture-agent" }],
      activeAgents: [],
    } as AppState["agentDefinitions"];
    reinitialize.mockClear();
    loadHooks.mockClear();
  });

  test("refresh reloads the real installed snapshot before caches and loaders", async () => {
    const startupSnapshot = installed.getInMemoryInstalledPlugins();
    expect(readSnapshot()).toBe("old");
    diskVersion = "new";
    expect(installed.getInMemoryInstalledPlugins()).toBe(startupSnapshot);
    expect(installed.loadInstalledPluginsV2()).toBe(startupSnapshot);
    let state = initialState();
    await refreshActivePlugins((update) => {
      state = update(state);
    });
    expect(observations).toEqual(["caches:new", "plugins:new"]);
    expect(readSnapshot()).toBe("new");
    expect(installed.getInMemoryInstalledPlugins()).not.toBe(startupSnapshot);
    expect(installed.loadInstalledPluginsV2()).toBe(
      installed.getInMemoryInstalledPlugins(),
    );
    expect(reads).toEqual(["old", "new"]);
  });

  test("refresh replaces AppState commands with commands plus standalone skills and returns separate counts", async () => {
    let state = initialState();
    const previous = state;
    const result = await refreshActivePlugins((update) => {
      state = update(state);
    });
    expect(state.plugins.commands).toEqual([...commands, ...skills]);
    expect(state.plugins.enabled).toBe(enabled);
    expect(state.plugins.disabled).toBe(disabled);
    expect(state.plugins.needsRefresh).toBe(false);
    expect(state.agentDefinitions).toBe(agents);
    expect(state.mcp).toEqual({ ...previous.mcp, pluginReconnectKey: 5 });
    expect(state.mcp.clients).toBe(previous.mcp.clients);
    expect(state.verbose).toBe(true);
    expect(previous.plugins.commands.map((c) => c.name)).toEqual([
      "old:command",
      "old:skill",
    ]);
    expect(result).toEqual({
      enabled_count: 1,
      disabled_count: 1,
      command_count: 1,
      skill_count: 2,
      agent_count: 1,
      hook_count: 1,
      mcp_count: 2,
      lsp_count: 1,
      error_count: 0,
      agentDefinitions: agents,
      pluginCommands: [...commands, ...skills],
    });
    expect(enabled[0]!.mcpServers).toEqual({
      one: { command: "fixture", args: [] },
      two: { command: "fixture", args: [] },
    });
    expect(enabled[0]!.lspServers).toEqual({
      language: { command: "fixture" },
    });
    expect(reinitialize).toHaveBeenCalledTimes(1);
    expect(loadHooks).toHaveBeenCalledTimes(1);
  });

  test("refresh removes the last plugin command and skill on a subsequent empty reload", async () => {
    let state = initialState();
    const setAppState = (update: (prev: AppState) => AppState) => {
      state = update(state);
    };
    await refreshActivePlugins(setAppState);
    commands = [];
    skills = [];
    enabled = [];
    disabled = [];
    agents = { allAgents: [], activeAgents: [] };
    const result = await refreshActivePlugins(setAppState);
    expect(state.plugins.commands).toEqual([]);
    expect(state.plugins.enabled).toEqual([]);
    expect(state.plugins.disabled).toEqual([]);
    expect(state.plugins.needsRefresh).toBe(false);
    expect(state.mcp.pluginReconnectKey).toBe(6);
    expect(result).toEqual({
      enabled_count: 0,
      disabled_count: 0,
      command_count: 0,
      skill_count: 0,
      agent_count: 0,
      hook_count: 0,
      mcp_count: 0,
      lsp_count: 0,
      error_count: 0,
      agentDefinitions: agents,
      pluginCommands: [],
    });
    expect(reinitialize).toHaveBeenCalledTimes(2);
    expect(loadHooks).toHaveBeenCalledTimes(2);
  });

  test("reload command reports actual command and standalone skill counts separately", async () => {
    let state = initialState();
    const context = {
      setAppState: (update: (prev: AppState) => AppState) => {
        state = update(state);
      },
    } as Parameters<typeof call>[1];
    expect(await call("", context)).toEqual({
      type: "text",
      value:
        "Reloaded: 1 plugin · 1 command · 2 skills · 1 agent · 1 hook · 2 plugin MCP servers · 1 plugin LSP server",
    });
    expect(state.plugins.commands).toEqual([...commands, ...skills]);
  });
}

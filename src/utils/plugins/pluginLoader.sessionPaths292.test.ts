import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zipSync, strToU8 } from "fflate";
import { loadSessionOnlyPlugins } from "./pluginLoader.js";
import { cleanupSessionPluginCache } from "./zipCache.js";

let root: string | undefined;
afterEach(async () => {
  await cleanupSessionPluginCache();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  return (root = await realpath(
    await mkdtemp(join(tmpdir(), "session-path-specs-")),
  ));
}
async function plugin(path: string, name: string) {
  await mkdir(join(path, ".claude-plugin"), { recursive: true });
  await mkdir(join(path, "commands"));
  await writeFile(
    join(path, ".claude-plugin/plugin.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  await writeFile(
    join(path, "commands/hello.md"),
    "---\ndescription: Path probe\n---\nHELLO\n",
  );
}
function archive(name: string, prefix = "", version = "1.0.0") {
  return zipSync({
    [prefix + ".claude-plugin/plugin.json"]: strToU8(
      JSON.stringify({ name, version }),
    ),
    [prefix + `commands/${version}.md`]: strToU8(
      "---\ndescription: Path probe\n---\nHELLO\n",
    ),
  });
}

// Official 2.1.292 native captures: parent folders load visible child manifests;
// .zip is case-insensitive and accepts one wrapper directory.
test("parent folder expands sorted child manifests and propagates no-MCP admission", async () => {
  const dir = await fixture();
  await plugin(join(dir, "b"), "beta");
  await plugin(join(dir, "a"), "alpha");
  await plugin(join(dir, ".hidden"), "hidden");
  await mkdir(join(dir, "not-a-plugin"));
  const result = await loadSessionOnlyPlugins([dir], {}, false, new Set([dir]));
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.name)).toEqual(["alpha", "beta"]);
  expect(
    result.plugins.every(
      (p) => p.skipMcpDiscovery && Object.keys(p.mcpServers ?? {}).length === 0,
    ),
  ).toBe(true);
});

test("marketplace container expands children without reading its marketplace entries", async () => {
  const dir = await fixture();
  await mkdir(join(dir, ".claude-plugin"));
  await writeFile(
    join(dir, ".claude-plugin/marketplace.json"),
    "not valid JSON: not consulted",
  );
  await plugin(join(dir, "a"), "alpha");
  const result = await loadSessionOnlyPlugins([dir], {});
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.name)).toEqual(["alpha"]);
});

test.each(["plugin.zip", "PLUGIN.ZIP"])(
  "ZIP loads its actual plugin manifest and command tree: %s",
  async (name) => {
    const dir = await fixture(),
      zip = join(dir, name);
    await writeFile(zip, archive("alpha"));
    const result = await loadSessionOnlyPlugins([zip], {});
    expect(result.errors).toEqual([]);
    expect(result.plugins.map((p) => p.name)).toEqual(["alpha"]);
    expect(
      await readFile(
        join(result.plugins[0]!.path, "commands/1.0.0.md"),
        "utf8",
      ),
    ).toContain("HELLO");
    expect(result.plugins[0]!.source).toBe("alpha@inline");
  },
);

test("single wrapper ZIP ignores macOS metadata and remains readable in contract-only mode", async () => {
  const dir = await fixture(),
    zip = join(dir, "wrapped.zip");
  const bytes = archive("alpha", "wrapper/");
  const { unzipSync } = await import("fflate");
  await writeFile(
    zip,
    zipSync({
      ...unzipSync(bytes),
      "__MACOSX/._wrapper": strToU8("metadata"),
      ".DS_Store": strToU8("metadata"),
    }),
  );
  const result = await loadSessionOnlyPlugins([zip], {}, true, new Set([zip]));
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.name)).toEqual(["alpha"]);
  expect(result.plugins[0]!.path.endsWith("/wrapper")).toBe(true);
  expect(result.plugins[0]!.skipMcpDiscovery).toBe(true);
});

test("archive refresh replaces complete trees, while unchanged bytes preserve the published inode", async () => {
  const dir = await fixture(),
    zip = join(dir, "reload.zip");
  await writeFile(zip, archive("alpha"));
  const first = await loadSessionOnlyPlugins([zip], {});
  expect(first.errors).toEqual([]);
  const path = first.plugins[0]!.path,
    inode = (await stat(path)).ino;
  const same = await loadSessionOnlyPlugins([zip], {});
  expect(same.errors).toEqual([]);
  expect((await stat(same.plugins[0]!.path)).ino).toBe(inode);
  await writeFile(zip, archive("alpha", "", "2.0.0"));
  const refreshed = await loadSessionOnlyPlugins([zip], {});
  expect(refreshed.errors).toEqual([]);
  expect(refreshed.plugins[0]!.path).toBe(path);
  expect(refreshed.plugins[0]!.manifest.version).toBe("2.0.0");
  expect(await Bun.file(join(path, "commands/1.0.0.md")).exists()).toBe(false);
  expect(await Bun.file(join(path, "commands/2.0.0.md")).exists()).toBe(true);
});

test("component names distinguish a collection child from a plugin command directory", async () => {
  const dir = await fixture();
  await plugin(join(dir, "commands"), "child");
  const collection = await loadSessionOnlyPlugins([dir], {});
  expect(collection.errors).toEqual([]);
  expect(collection.plugins.map((p) => p.name)).toEqual(["child"]);
  await mkdir(join(dir, ".claude-plugin"));
  await writeFile(
    join(dir, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "root" }),
  );
  const direct = await loadSessionOnlyPlugins([dir], {});
  expect(direct.errors).toEqual([]);
  expect(direct.plugins.map((p) => p.name)).toEqual(["root"]);
});

test("corrupt and traversal refreshes preserve the previous complete extraction", async () => {
  const dir = await fixture(),
    zip = join(dir, "safe.zip");
  await writeFile(zip, archive("alpha"));
  const loaded = await loadSessionOnlyPlugins([zip], {});
  const path = loaded.plugins[0]!.path;
  const inode = (await stat(path)).ino;
  for (const invalid of [
    strToU8("invalid ZIP"),
    zipSync({ "../escaped": strToU8("ESCAPE") }),
  ]) {
    await writeFile(zip, invalid);
    const failed = await loadSessionOnlyPlugins([zip], {});
    expect(failed.plugins).toEqual([]);
    expect(failed.errors).toHaveLength(1);
    expect((await stat(path)).ino).toBe(inode);
    expect(await readFile(join(path, "commands/1.0.0.md"), "utf8")).toContain(
      "HELLO",
    );
  }
  expect(await Bun.file(join(dir, "escaped")).exists()).toBe(false);
});

test("contract previews keep the published tree and retain the latest two preview generations", async () => {
  const dir = await fixture(),
    zip = join(dir, "preview.zip");
  await writeFile(zip, archive("alpha"));
  const loaded = await loadSessionOnlyPlugins([zip], {});
  const path = loaded.plugins[0]!.path;
  const inode = (await stat(path)).ino;
  const paths: string[] = [];
  for (const version of ["2.0.0", "3.0.0", "4.0.0"]) {
    await writeFile(zip, archive("alpha", "", version));
    const preview = await loadSessionOnlyPlugins([zip], {}, true);
    expect(preview.errors).toEqual([]);
    expect(preview.plugins[0]!.manifest.version).toBe(version);
    paths.push(preview.plugins[0]!.path);
    expect((await stat(path)).ino).toBe(inode);
    expect(
      await readFile(join(path, ".claude-plugin/plugin.json"), "utf8"),
    ).toContain("1.0.0");
  }
  expect(
    await stat(paths[0]!).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(
    await stat(paths[1]!).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
  expect(
    await stat(paths[2]!).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
});

import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { setInlinePluginUrls } from "../../bootstrap/state.js";
import { resetSettingsCache, setCachedSettingsForSource } from "../settings/settingsCache.js";
import {
  clearPluginCache,
  loadAllPluginsCacheOnly,
  loadSessionOnlyPlugins,
} from "./pluginLoader.js";
import { cleanupSessionPluginCache, getSessionPluginCachePath } from "./zipCache.js";

// Official 2.1.292 Ckn kind==="url": fetch with AbortSignal.timeout(30000), cap at
// 268435456 bytes, write url-<i>-<name>.zip via a .part file in the 0700 session
// directory, reuse the cached archive when a re-fetch fails, redact the URL.
function archive(name: string) {
  return zipSync({
    ".claude-plugin/plugin.json": strToU8(JSON.stringify({ name, version: "1.0.0" })),
    "commands/hello.md": strToU8("---\ndescription: URL probe\n---\nHELLO FROM URL\n"),
  });
}

let status = 200;
let hits = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    hits++;
    const path = new URL(request.url).pathname;
    if (status !== 200 || path.startsWith("/missing"))
      return new Response("nope", { status: status !== 200 ? status : 404 });
    return new Response(Buffer.from(archive("url-alpha")));
  },
});
const base = `http://127.0.0.1:${server.port}`;
let root: string | undefined;

afterEach(async () => {
  status = 200;
  hits = 0;
  setInlinePluginUrls([]);
  resetSettingsCache();
  clearPluginCache("test cleanup");
  await cleanupSessionPluginCache();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function cacheEntries() {
  return (await readdir(await getSessionPluginCachePath())).sort();
}

test("a plugin URL downloads into the private session directory and loads its commands", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "plugin-url-")));
  const local = join(root, "local.zip");
  await writeFile(local, archive("local-one"));
  const result = await loadSessionOnlyPlugins([local], {}, false, new Set(), [
    `${base}/dl/alpha.zip?token=secret`,
  ]);
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.source)).toEqual([
    "local-one@inline",
    "url-alpha@inline",
  ]);
  const plugin = result.plugins[1]!;
  expect(plugin.enabled).toBe(true);
  expect(await readFile(join(plugin.path, "commands/hello.md"), "utf8")).toContain(
    "HELLO FROM URL",
  );
  const cache = await getSessionPluginCachePath();
  expect((await stat(cache)).mode & 0o777).toBe(0o700);
  const entries = await cacheEntries();
  expect(entries).toContain("url-1-alpha.zip");
  expect(entries.some((name) => name.endsWith(".part"))).toBe(false);
});

test("a failed re-fetch reuses the archive downloaded earlier in the session", async () => {
  const url = `${base}/dl/alpha.zip`;
  expect((await loadSessionOnlyPlugins([], {}, false, new Set(), [url])).errors).toEqual([]);
  status = 500;
  const result = await loadSessionOnlyPlugins([], {}, false, new Set(), [url]);
  expect(hits).toBe(2);
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.name)).toEqual(["url-alpha"]);
});

test("a failed first fetch reports the HTTP status without URL credentials or query", async () => {
  const result = await loadSessionOnlyPlugins([], {}, false, new Set(), [
    `http://user:hunter2@127.0.0.1:${server.port}/missing/p.zip?sig=TOPSECRET`,
  ]);
  expect(result.plugins).toEqual([]);
  expect(result.errors).toHaveLength(1);
  const error = result.errors[0]!;
  expect(error.source).toBe("inline[0]");
  const message = "error" in error ? String(error.error) : "";
  expect(message).toContain("HTTP 404");
  expect(message).toContain(`http://127.0.0.1:${server.port}/missing/p.zip`);
  expect(JSON.stringify(result.errors)).not.toMatch(/TOPSECRET|hunter2/);
});

test("a declared size above the 256 MiB limit is rejected before the body is read", async () => {
  const raw = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: 268435457\r\n\r\nPK",
        );
      },
    },
  });
  try {
    const result = await loadSessionOnlyPlugins([], {}, false, new Set(), [
      `http://127.0.0.1:${raw.port}/big.zip`,
    ]);
    expect(result.plugins).toEqual([]);
    const message = JSON.stringify(result.errors);
    expect(message).toContain("Plugin archive too large (268435457 bytes, max 268435456)");
    expect((await cacheEntries()).some((name) => name.startsWith("url-0-big.zip"))).toBe(false);
  } finally {
    raw.stop(true);
  }
});

test("only http and https plugin URLs are fetched", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "plugin-url-")));
  const local = join(root, "local.zip");
  await writeFile(local, archive("file-scheme"));
  const result = await loadSessionOnlyPlugins([], {}, false, new Set(), [
    `file://${local}`,
  ]);
  expect(result.plugins).toEqual([]);
  expect(JSON.stringify(result.errors)).toContain("http");
});

test("contract-only discovery loads the URL without publishing the session archive", async () => {
  const result = await loadSessionOnlyPlugins([], {}, true, new Set(), [`${base}/dl/alpha.zip`]);
  expect(result.errors).toEqual([]);
  expect(result.plugins.map((p) => p.name)).toEqual(["url-alpha"]);
  const entries = await cacheEntries();
  expect(entries).not.toContain("url-0-alpha.zip");
  expect(entries.some((name) => name.endsWith(".part"))).toBe(false);
});

test("session plugin URLs load through the shared loader unless sideload flags are disabled", async () => {
  setInlinePluginUrls([`${base}/dl/alpha.zip`]);
  clearPluginCache("test");
  const loaded = await loadAllPluginsCacheOnly();
  expect(loaded.enabled.map((p) => p.source)).toContain("url-alpha@inline");

  resetSettingsCache();
  setCachedSettingsForSource("policySettings", { disableSideloadFlags: true });
  clearPluginCache("test");
  hits = 0;
  const restricted = await loadAllPluginsCacheOnly();
  expect(restricted.enabled.map((p) => p.source)).not.toContain("url-alpha@inline");
  expect(hits).toBe(0);
});

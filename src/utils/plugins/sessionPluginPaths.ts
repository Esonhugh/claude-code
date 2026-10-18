import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { registerCleanup } from "../cleanupRegistry.js";
import { logForDebugging } from "../debug.js";
import { getErrnoCode } from "../errors.js";
import { getProxyFetchOptions } from "../proxy.js";
import { publishDirectory } from "./stagingDirectory.js";
import {
  cleanupSessionPluginCache,
  extractZipToDirectory,
  getSessionPluginCachePath,
} from "./zipCache.js";

const componentDirectories = new Set([
  "commands",
  "skills",
  "agents",
  "hooks",
  "themes",
  "output-styles",
  "monitors",
  "workflows",
]);
const pluginMarkers = new Set([
  ".claude-plugin",
  ...componentDirectories,
  "SKILL.md",
  ".mcp.json",
  ".lsp.json",
]);
const manifestPath = ".claude-plugin/plugin.json";

async function presence(
  path: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    const file = await open(path, "r");
    await file.close();
    return "present";
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(getErrnoCode(error) ?? "")
      ? "absent"
      : "unknown";
  }
}

export type SessionPluginPath = { path: string; skipMcpDiscovery: boolean };

/** Official 2.1.292: a plugin wins over a collection; only visible manifest children expand. */
export async function expandSessionPluginPaths(
  paths: readonly string[],
  noMcpPaths: ReadonlySet<string>,
): Promise<SessionPluginPath[]> {
  const expanded: SessionPluginPath[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const spec = { path: absolute, skipMcpDiscovery: noMcpPaths.has(absolute) };
    if (absolute.toLowerCase().endsWith(".zip")) {
      expanded.push(spec);
      continue;
    }
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      // Preserve the original path so the loader reports its normal path/read error.
      expanded.push(spec);
      continue;
    }
    const marketplace =
      entries.some((e) => e.name === ".claude-plugin") &&
      (await presence(join(absolute, manifestPath))) === "absent" &&
      (await presence(join(absolute, ".claude-plugin/marketplace.json"))) ===
        "present";
    if (marketplace)
      entries = entries.filter((e) => e.name !== ".claude-plugin");
    let isPlugin = false;
    for (const entry of entries.filter((e) => pluginMarkers.has(e.name))) {
      if (
        !componentDirectories.has(entry.name) ||
        (await presence(join(absolute, entry.name, manifestPath))) === "absent"
      ) {
        isPlugin = true;
        break;
      }
    }
    if (isPlugin) {
      expanded.push(spec);
      continue;
    }
    const children = entries
      .filter(
        (e) =>
          !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()),
      )
      .map((e) => e.name)
      .sort();
    for (const child of children) {
      const childPath = join(absolute, child);
      if ((await presence(join(childPath, manifestPath))) !== "absent") {
        expanded.push({ ...spec, path: childPath });
      }
    }
    logForDebugging(
      `[Plugins:inline] expanded ${absolute}: ${expanded.filter((p) => p.path.startsWith(absolute + "/")).length} plugins`,
    );
  }
  return expanded;
}

async function unwrapArchive(path: string): Promise<string> {
  const visible = (name: string) => name !== "__MACOSX" && name !== ".DS_Store";
  const entries = (await readdir(path, { withFileTypes: true })).filter((e) =>
    visible(e.name),
  );
  if (entries.some((e) => e.name === ".claude-plugin")) return path;
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    const entry = entries[0]!;
    const inner = join(path, entry.name);
    try {
      await stat(join(inner, ".claude-plugin"));
      return inner;
    } catch {
      if (
        !pluginMarkers.has(entry.name) &&
        (await readdir(inner))
          .filter(visible)
          .some((name) => pluginMarkers.has(name))
      )
        return inner;
    }
  }
  return path;
}

type Extraction = { hash: string; sequence: number };
const published = new Map<string, Extraction>();
const queues = new Map<string, Promise<void>>();
const previews = new Map<string, string[]>();
let nextSequence = 0;
registerCleanup(async () => {
  await cleanupSessionPluginCache();
  published.clear();
  queues.clear();
  previews.clear();
});

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const MAX_PLUGIN_URL_BYTES = 268435456;
const PLUGIN_URL_TIMEOUT_MS = 30000;

/** Official 2.1.292: logs and errors name a plugin URL by origin + path only. */
export function redactPluginUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return "<invalid URL>";
  }
}

export function redactPluginUrlText(text: string, url: string): string {
  const raw = [url];
  try {
    raw.push(new URL(url).href);
  } catch {
    // An unparsable URL only appears verbatim.
  }
  const display = redactPluginUrl(url);
  return raw.reduce((result, value) => result.split(value).join(display), text);
}

/**
 * Official 2.1.292 --plugin-url: download into the session cache as
 * url-<index>-<name>.zip via a .part file. A failed re-fetch reuses the
 * archive from an earlier load; preview loads never replace that archive.
 * `source` is the file holding this load's bytes (a .part file in preview).
 */
export async function fetchSessionPluginUrl(
  url: string,
  index: number,
  preview: boolean,
): Promise<{ path: string; source: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(
      `Unsupported plugin URL scheme "${parsed.protocol}" (only http and https are allowed)`,
    );
  const display = redactPluginUrl(url);
  const name = basename(parsed.pathname).replace(/\.zip$/i, "") || "download";
  const archive = join(
    await getSessionPluginCachePath(),
    `url-${index}-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}.zip`,
  );
  const partial = `${archive}.${preview ? "preview-" : ""}${randomBytes(4).toString("hex")}.part`;
  try {
    const response = await fetch(url, {
      ...getProxyFetchOptions({ url }),
      signal: AbortSignal.timeout(PLUGIN_URL_TIMEOUT_MS),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `HTTP ${response.status} ${response.statusText} from ${display}`,
      );
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_PLUGIN_URL_BYTES)
      throw new Error(
        `Plugin archive too large (${declared} bytes, max ${MAX_PLUGIN_URL_BYTES}) from ${display}`,
      );
    let received = 0;
    const body = Readable.fromWeb(response.body as never);
    body.on("data", (chunk: Uint8Array) => {
      received += chunk.byteLength;
      if (received > MAX_PLUGIN_URL_BYTES)
        body.destroy(
          new Error(
            `Plugin archive exceeded ${MAX_PLUGIN_URL_BYTES} bytes from ${display}`,
          ),
        );
    });
    await pipeline(body, createWriteStream(partial));
    logForDebugging(`Downloaded inline plugin from ${display}`);
    if (preview) return { path: archive, source: partial };
    await rename(partial, archive);
    return { path: archive, source: archive };
  } catch (error) {
    await rm(partial, { force: true });
    if ((await presence(archive)) !== "present") throw error;
    logForDebugging(
      `Re-fetch of inline plugin from ${display} failed; reusing cached ${archive}`,
      { level: "warn" },
    );
    return { path: archive, source: archive };
  }
}

/** Extract captured bytes, preserving the previous complete tree on any failure. */
export async function resolveSessionPluginPath(
  path: string,
  index: number,
  preview: boolean,
  source = path,
): Promise<{ path: string; fallbackName: string }> {
  const fallbackName = basename(path).replace(/\.zip$/i, "");
  if (!path.toLowerCase().endsWith(".zip")) return { path, fallbackName };
  const sequence = ++nextSequence;
  const bytes = await readFile(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cache = await getSessionPluginCachePath();
  const destination = join(
    cache,
    `inline-${index}-${fallbackName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  );
  let extracted = destination;
  const previous = queues.get(destination) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
      const current = published.get(destination);
      if (current?.hash === hash && (await directoryExists(destination)))
        return;
      if (preview) {
        extracted = `${destination}.preview-${hash.slice(0, 32)}`;
        if (!(await directoryExists(extracted)))
          await publishDirectory(extracted, (staging) =>
            extractZipToDirectory(path, staging, bytes),
          );
        const retained = (previews.get(destination) ?? []).filter(
          (p) => p !== extracted,
        );
        retained.push(extracted);
        const obsolete = retained.splice(0, Math.max(0, retained.length - 2));
        previews.set(destination, retained);
        for (const old of obsolete)
          await rm(old, { recursive: true, force: true });
        return;
      }
      if (current && current.sequence > sequence) return;
      await publishDirectory(destination, (staging) =>
        extractZipToDirectory(path, staging, bytes),
      );
      published.set(destination, { hash, sequence });
      logForDebugging(
        `[Plugins:inline] published ${path} at ${destination} (${hash})`,
      );
    });
  queues.set(destination, work);
  try {
    await work;
  } finally {
    if (queues.get(destination) === work) queues.delete(destination);
  }
  return { path: await unwrapArchive(extracted), fallbackName };
}

import { createHash } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import { packageOfficialDiff } from "./package-official-diff.mjs";
import { copyRuntimeAssets } from "./build.mjs";
const archiveName = "builtin-diff-2.1.292.zip";
test("actual runtime asset producer copies latest diff beside the preserved legacy archive", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "diff-assets-292-"));
  try {
    await fs.mkdir(path.join(root, "assets"));
    await fs.writeFile(
      path.join(root, "assets", "builtin-mods-2.1.277.zip"),
      "legacy",
    );
    await fs.writeFile(path.join(root, "assets", archiveName), "latest");
    await copyRuntimeAssets({
      projectDir: root,
      nodeModulesDir: path.join(root, "node_modules"),
      distDir: path.join(root, "dist"),
      isolated: true,
    });
    expect(existsSync(path.join(root, "dist", "assets", archiveName))).toBe(
      true,
    );
    expect(
      await fs.readFile(path.join(root, "dist", "assets", archiveName), "utf8"),
    ).toBe("latest");
    expect(
      await fs.readFile(
        path.join(root, "dist", "assets", "builtin-mods-2.1.277.zip"),
        "utf8",
      ),
    ).toBe("legacy");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("actual offline producer reproduces the pinned archive from its genuine full module inputs", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "diff-package-292-"));
  try {
    const original = await fs.readFile(
      new URL("../assets/" + archiveName, import.meta.url),
    );
    const entries = unzipSync(original);
    for (const name of ["chunk-01whafa0.js", "chunk-cnv756hy.js"])
      await fs.writeFile(path.join(root, name), entries["official/" + name]);
    const output = path.join(root, "out.zip");
    await packageOfficialDiff({ modulesDir: root, output });
    expect(await fs.readFile(output)).toEqual(original);
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "745c46dae5714492d5fe0351df623579f82000d132db8df365bf690031d1cc65",
    );
    await expect(
      packageOfficialDiff({ modulesDir: root, output }),
    ).rejects.toThrow("EEXIST");
    expect(await fs.readFile(output)).toEqual(original);
    for (const name of ["chunk-01whafa0.js", "chunk-cnv756hy.js"]) {
      const clean = entries["official/" + name];
      const tampered = clean.slice();
      tampered[tampered.length - 1] ^= 1;
      await fs.writeFile(path.join(root, name), tampered);
      const bad = path.join(root, name + ".bad.zip");
      await expect(
        packageOfficialDiff({ modulesDir: root, output: bad }),
      ).rejects.toThrow("SHA-256 mismatch");
      expect(existsSync(bad)).toBe(false);
      await fs.writeFile(path.join(root, name), clean);
    }
    await fs.rm(path.join(root, "chunk-cnv756hy.js"));
    const missing = path.join(root, "missing.zip");
    await expect(
      packageOfficialDiff({ modulesDir: root, output: missing }),
    ).rejects.toThrow("ENOENT");
    expect(existsSync(missing)).toBe(false);
    expect(await fs.readFile(output)).toEqual(original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("actual binary packaging control embeds the latest archive as a file asset", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "diff-embed-292-"));
  try {
    const source = await fs.readFile(
      new URL("./package-binary.mjs", import.meta.url),
      "utf8",
    );
    const template = await fs.readFile(
      new URL("./shims/embedded-ripgrep.js", import.meta.url),
      "utf8",
    );
    const sharp = await fs.readFile(
      new URL("./shims/embedded-sharp.js", import.meta.url),
      "utf8",
    );
    const writes = [],
      calls = [];
    const context = {
      scriptUrl: new URL("./package-binary.mjs", import.meta.url).href,
      fileURLToPath,
      path,
      process: {
        env: { CLAUDE_CODE_BUILD_DIR: root },
        platform: "darwin",
        arch: "arm64",
      },
      console: { log() {} },
      prepareBuildDirectory: (value) => value,
      buildCli: async () => {},
      fs: {
        existsSync: () => true,
        readdirSync: () => ["libvips-cpp.test.dylib"],
        promises: {
          readFile: async (file) => {
            if (file.endsWith("package.json"))
              return JSON.stringify({ version: "0.0.0-dev" });
            if (file.endsWith("embedded-ripgrep.js")) return template;
            if (file.endsWith("embedded-sharp.js")) return sharp;
            throw Error("Unexpected read " + file);
          },
          writeFile: async (file, contents) => writes.push({ file, contents }),
          mkdir: async () => {},
          chmod: async () => {},
        },
      },
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    };
    const body = source
      .replace(/^import .*;\n/gm, "")
      .replaceAll("import.meta.url", "scriptUrl");
    await runInNewContext("(async()=>{" + body + "})()", context);
    const entry = writes.find(({ file }) => file.endsWith("embedded-cli.js"));
    expect(entry.contents).toContain(
      JSON.stringify(
        fileURLToPath(new URL("../assets/" + archiveName, import.meta.url)),
      ),
    );
    expect(entry.contents).toContain("import builtinDiffArchivePath from ");
    expect(entry.contents).toContain("with { type: 'file' }");
    expect(entry.contents).toContain(
      "process.env.CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE = builtinDiffArchivePath",
    );
    expect(entry.contents).not.toContain(
      "__CLAUDE_CODE_BUILTIN_DIFF_ARCHIVE__",
    );
    expect(calls.some(({ args }) => args.includes("--compile"))).toBe(true);
    context.fs.existsSync = (file) => !file.endsWith(archiveName);
    await expect(
      runInNewContext("(async()=>{" + body + "})()", context),
    ).rejects.toThrow("Missing builtin diff archive");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

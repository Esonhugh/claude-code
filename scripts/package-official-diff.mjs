import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";

// Byte ranges are from the verified 2.1.295 darwin-arm64 release, without executing it.
export const officialDiffPackageProvenance = Object.freeze({
  version: "2.1.295",
  name: "cc-plugin-diff",
  binarySha256: "0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70",
  module: "chunk-8mmnqsff.js",
  moduleSha256: "4d5f17d872d8a0c50a386300a4f0c8deb3823fb53717a021353231e22cbba922",
  identityModule: "chunk-56g3eekf.js",
  identityModuleSha256: "8590c66308f2aec88ef8e6e2052ff3a7394a38ec4cbdf454dedff37641267fc1",
  registerExport: "xm",
  sourceStart: 12121,
  sourceEnd: 62470,
  sourceSha256: "a703dae9955fc3884f22672a5761cd360cec59a07f67d9e48f50b5ace667176e",
  metadataStart: 5744,
  metadataEnd: 6328,
  metadataSha256: "865ed020c6db1a6b4924eaa47b85a7ba3478190e8ce19c3084f26d892ec72d5b",
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function packageOfficialDiff({ modulesDir, output }) {
  const p = officialDiffPackageProvenance;
  const module = await readFile(join(modulesDir, p.module));
  const identity = await readFile(join(modulesDir, p.identityModule));
  const source = module.subarray(p.sourceStart, p.sourceEnd);
  const scan = module.subarray(p.metadataStart, p.metadataEnd);
  for (const [label, bytes, expected] of [
    ["module", module, p.moduleSha256],
    ["identity module", identity, p.identityModuleSha256],
    ["register closure", source, p.sourceSha256],
    ["compiled scan", scan, p.metadataSha256],
  ])
    if (hash(bytes) !== expected)
      throw new Error(`Official diff ${label} SHA-256 mismatch`);
  const description =
    "The diff panel as a plugin pane: /diff, the changed files and their hunks beside the transcript, refreshed as Claude edits";
  const entries = {
    "provenance.json": strToU8(JSON.stringify(p, null, 2) + "\n"),
    ["official/" + p.module]: module,
    ["official/" + p.identityModule]: identity,
    "cc-plugin-diff/.claude-plugin/plugin.json": strToU8(
      JSON.stringify(
        { name: p.name, version: p.version, description },
        null,
        2,
      ) + "\n",
    ),
    "cc-plugin-diff/hooks/hooks.json": strToU8(
      JSON.stringify({ modules: ["./register.js"] }, null, 2) + "\n",
    ),
    "cc-plugin-diff/hooks/register.js": strToU8(
      new TextDecoder("utf-8", { fatal: true }).decode(source) +
        `\nexport {${p.registerExport} as register};\n`,
    ),
  };
  const files = Object.fromEntries(
    Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, [value, { mtime: new Date(1980, 0, 1) }]]),
  );
  const archive = zipSync(files, { level: 9 });
  await writeFile(output, archive, { flag: "wx" });
  return {
    output,
    archiveSha256: hash(archive),
    bytes: archive.length,
    provenance: p,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const [modulesDir, output] = process.argv.slice(2);
  if (!modulesDir || !output)
    throw new Error(
      "Usage: bun scripts/package-official-diff.mjs VERIFIED_DECODED_MODULE_DIR NEW_ARCHIVE_PATH",
    );
  console.log(
    JSON.stringify(await packageOfficialDiff({ modulesDir, output }), null, 2),
  );
}

import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";

// Byte ranges are from the verified 2.1.291 darwin-arm64 release, without executing it.
export const officialDiffPackageProvenance = Object.freeze({
  version: "2.1.291",
  name: "cc-plugin-diff",
  binarySha256:
    "9a1d2ed6bb4421e8fc80c892c0413f293be3ee50ae3d7dda1a7622197a056690",
  moduleSha256:
    "05350cb490432c50c1e4227a6097112c4063d710385c937e29a73cf79adddba8",
  identityModule: "chunk-apw5me5f.js",
  identityModuleSha256:
    "2400a87c0ea3f28b88133436e8816c76a183460eced1ff8accd5d2bd5ad555c6",
  sourceStart: 12069,
  sourceEnd: 62474,
  sourceSha256:
    "f1f839f6e013fd87d429f1aff688b05d4b721ad0c5666fbe94267c4541dbc70f",
  metadataStart: 5667,
  metadataEnd: 6251,
  metadataSha256:
    "3a7bf890043d50f4b01dc3a29e67be83e88ebc85ed82ca905596a2bfb267613f",
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function packageOfficialDiff({ modulesDir, output }) {
  const p = officialDiffPackageProvenance;
  const module = await readFile(join(modulesDir, "chunk-fbpekckc.js"));
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
    "official/chunk-fbpekckc.js": module,
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
        "\nexport {ym as register};\n",
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

import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";

// Byte ranges are from the verified 2.1.292 darwin-arm64 release, without executing it.
export const officialDiffPackageProvenance = Object.freeze({
  version: "2.1.292",
  name: "cc-plugin-diff",
  binarySha256:
    "97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f",
  moduleSha256:
    "6cd79b0d5118de9485b1268d64238019e3a41510c943eb17832b128fd976afd3",
  identityModule: "chunk-cnv756hy.js",
  identityModuleSha256:
    "86406ab18044de34edba1f7247b591268b86b1cff7522aaf07f1d67725f915c7",
  sourceStart: 12068,
  sourceEnd: 62473,
  sourceSha256:
    "ccafc3393958bc6e428f8909030d06af0e50e6db73f7308ec26ac286f27e97a4",
  metadataStart: 5666,
  metadataEnd: 6250,
  metadataSha256:
    "41ada677ee5d534b88f953e89e0b8261a7cc567d538b21678f41f7d3e45319ca",
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function packageOfficialDiff({ modulesDir, output }) {
  const p = officialDiffPackageProvenance;
  const module = await readFile(join(modulesDir, "chunk-01whafa0.js"));
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
    "official/chunk-01whafa0.js": module,
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

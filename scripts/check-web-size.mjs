// Fails when the web UI that `claude web` embeds (web/dist/assets.json, which
// src/web/assets.ts imports into the CLI bundle and binary) outgrows its budget.
// Run after `bun run build` or `bun run build:web`.
import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

// About 15% above the measured 11.95 MiB (with the bundled IBM Plex fonts).
const BUDGET_BYTES = 13.75 * 1024 * 1024;
const manifest = new URL('../web/dist/assets.json', import.meta.url);

let size;
try {
  size = fs.statSync(manifest).size;
} catch {
  console.error('web/dist/assets.json is missing; run `bun run build:web` first.');
  process.exit(1);
}
const mib = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(`claude web assets: ${mib(size)} (budget ${mib(BUDGET_BYTES)})`);
if (size > BUDGET_BYTES) {
  console.error('Embedded web assets exceed the budget in scripts/check-web-size.mjs.');
  process.exit(1);
}

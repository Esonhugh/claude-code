import fs from 'node:fs';
import { URL } from 'node:url';

// Documentation is an executable recipe only when its referenced tests are
// actually delivered. Do not resolve missing files from another worktree.
const root = new URL('../', import.meta.url);
const readme = fs.readFileSync(new URL('README.md', root), 'utf8');
const missing = [];
const checked = new Set();
for (const [index, line] of readme.split(/\r?\n/).entries()) {
  const paths = line.matchAll(/(?:\.\/)?((?:src|scripts)\/[\w./-]+\.test\.(?:tsx|ts|mjs))\b/g);
  for (const [, path] of paths) {
    if (checked.has(path)) continue;
    checked.add(path);
    try {
      if (!fs.statSync(new URL(path, root)).isFile()) throw new Error('not a file');
    } catch {
      missing.push(`README.md:${index + 1}: ${path}`);
    }
  }
}
if (missing.length) {
  console.error('README references tests absent from this checkout:');
  for (const entry of missing) console.error(`- ${entry}`);
  process.exitCode = 1;
} else {
  console.log(`README test paths are available (${checked.size} unique files).`);
}

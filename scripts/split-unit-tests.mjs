// Prints shard <index> of <count> of the test files on stdin, balanced by the
// per-file seconds in .github/unit-test-times.tsv (files not listed weigh the
// median), longest first so the slow files never start last.
//   git ls-files ... | bun scripts/split-unit-tests.mjs <index> <count>
import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const [index, count] = process.argv.slice(2).map(Number);
if (!(count >= 1 && index >= 1 && index <= count)) {
  throw new Error('usage: split-unit-tests.mjs <index> <count>');
}

const timesFile = new URL('../.github/unit-test-times.tsv', import.meta.url);
const times = new Map(
  fs.existsSync(timesFile)
    ? fs.readFileSync(timesFile, 'utf8').split('\n').filter(Boolean).map(line => {
        const [seconds, file] = line.split('\t');
        return [file, Number(seconds)];
      })
    : [],
);
const known = [...times.values()].sort((a, b) => a - b);
const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;

const files = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
const weighted = files
  .map(file => ({ file, seconds: times.get(file) ?? fallback }))
  .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));

const shards = Array.from({ length: count }, () => ({ seconds: 0, files: [] }));
for (const entry of weighted) {
  const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
  lightest.seconds += entry.seconds;
  lightest.files.push(entry.file);
}

const shard = shards[index - 1];
process.stderr.write(`shard ${index}/${count}: ${shard.files.length} files, ~${Math.round(shard.seconds)}s of test time\n`);
process.stdout.write(shard.files.map(file => `${file}\n`).join(''));

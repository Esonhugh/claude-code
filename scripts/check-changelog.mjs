import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

import { validateChangelog } from '../src/utils/changelog.ts';

const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const expectedVersion = process.argv[2] ?? process.env.CLAUDE_CODE_VERSION;
const result = validateChangelog(changelog, expectedVersion);

if (result.errors.length > 0) {
  console.error('CHANGELOG.md validation failed:');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const latest = result.releases[0];
console.log(
  `CHANGELOG.md is valid (${result.releases.length} releases; latest v${latest?.version ?? 'none'}).`,
);

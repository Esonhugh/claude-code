import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzePromptDump,
  comparePromptDumps,
} from './analyze-prompt-dump.mjs';

const dir = mkdtempSync(join(tmpdir(), 'prompt-dump-analysis-'));
const baselinePath = join(dir, 'baseline.jsonl');
const candidatePath = join(dir, 'candidate.jsonl');

function dump(path, systemText, description, usage) {
  const init = {
    type: 'init',
    timestamp: '2026-08-23T00:00:00.000Z',
    data: {
      model: 'claude-opus-4-6',
      system: [{ type: 'text', text: systemText }],
      tools: [
        {
          name: 'Read',
          description,
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
        },
      ],
    },
  };
  const response = {
    type: 'response',
    timestamp: '2026-08-23T00:00:01.000Z',
    data: {
      stream: true,
      chunks: [{ type: 'message_start', message: { usage } }],
    },
  };
  writeFileSync(path, `${JSON.stringify(init)}\n${JSON.stringify(response)}\n`);
}

try {
  dump(baselinePath, '12345678', 'abcdefgh', {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
  });
  dump(candidatePath, '1234', 'abcd', {
    input_tokens: 8,
    output_tokens: 2,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 30,
  });

  const baseline = await analyzePromptDump(baselinePath);
  const candidate = await analyzePromptDump(candidatePath);
  const comparison = comparePromptDumps(baseline, candidate);

  assert.equal(baseline.initCount, 1);
  assert.equal(baseline.systemUpdateCount, 0);
  assert.equal(baseline.latestRequest.systemChars, 8);
  assert.equal(baseline.latestRequest.toolDescriptionChars, 8);
  assert.equal(baseline.totalUsage.actualInputTokens, 60);
  assert.equal(candidate.totalUsage.actualInputTokens, 48);
  assert.equal(comparison.actualInputTokens.delta, -12);
  assert.equal(comparison.systemEstimatedTokens.delta, -1);
  assert.equal(comparison.toolDescriptionEstimatedTokens.delta, -1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('analyze-prompt-dump.test.mjs passed');

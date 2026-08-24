import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function getSystemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map(block => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n');
}

function getRequestMetrics(data) {
  const system = getSystemText(data.system);
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const toolDescriptionChars = tools.reduce(
    (total, tool) =>
      total + (typeof tool?.description === 'string' ? tool.description.length : 0),
    0,
  );
  const toolSchemaChars = tools.reduce(
    (total, tool) =>
      total + (tool?.input_schema === undefined ? 0 : JSON.stringify(tool.input_schema).length),
    0,
  );
  const instructionChars =
    system.length + toolDescriptionChars + toolSchemaChars;

  return {
    model: data.model ?? null,
    systemBlocks: Array.isArray(data.system) ? data.system.length : system ? 1 : 0,
    systemChars: system.length,
    systemEstimatedTokens: estimateTokens(system.length),
    toolCount: tools.length,
    toolDescriptionChars,
    toolDescriptionEstimatedTokens: estimateTokens(toolDescriptionChars),
    toolSchemaChars,
    toolSchemaEstimatedTokens: estimateTokens(toolSchemaChars),
    instructionChars,
    instructionEstimatedTokens: estimateTokens(instructionChars),
    systemHash: hash(data.system ?? null),
    toolsHash: hash(tools),
  };
}

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

function getResponseUsage(data) {
  const events = data?.stream && Array.isArray(data.chunks) ? data.chunks : [data];
  const usage = Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]));

  for (const event of events) {
    for (const candidate of [event?.usage, event?.message?.usage, event?.response?.usage]) {
      if (!candidate) continue;
      for (const field of USAGE_FIELDS) {
        const value = candidate[field];
        if (typeof value === 'number') usage[field] = Math.max(usage[field], value);
      }
    }
  }

  return usage;
}

function sumUsage(total, usage) {
  for (const field of USAGE_FIELDS) total[field] += usage[field];
}

export async function analyzePromptDump(filePath) {
  const content = await readFile(filePath, 'utf8');
  const entries = content
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });

  const requestEntries = entries.filter(
    entry => entry.type === 'init' || entry.type === 'system_update',
  );
  const requestSnapshots = requestEntries.map(entry => ({
    type: entry.type,
    timestamp: entry.timestamp ?? null,
    ...getRequestMetrics(entry.data ?? {}),
  }));
  const totalUsage = Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]));
  const responseEntries = entries.filter(entry => entry.type === 'response');
  for (const entry of responseEntries) {
    sumUsage(totalUsage, getResponseUsage(entry.data));
  }

  const actualInputTokens =
    totalUsage.input_tokens +
    totalUsage.cache_creation_input_tokens +
    totalUsage.cache_read_input_tokens;

  return {
    file: filePath,
    initCount: requestEntries.filter(entry => entry.type === 'init').length,
    systemUpdateCount: requestEntries.filter(entry => entry.type === 'system_update').length,
    responseCount: responseEntries.length,
    latestRequest: requestSnapshots.at(-1) ?? null,
    requestSnapshots,
    totalUsage: {
      ...totalUsage,
      actualInputTokens,
      cacheReadRatio:
        actualInputTokens === 0
          ? null
          : totalUsage.cache_read_input_tokens / actualInputTokens,
    },
  };
}

function numericDelta(baseline, candidate) {
  const delta = candidate - baseline;
  return {
    baseline,
    candidate,
    delta,
    percent: baseline === 0 ? null : (delta / baseline) * 100,
  };
}

export function comparePromptDumps(baseline, candidate) {
  const baselineRequest = baseline.latestRequest;
  const candidateRequest = candidate.latestRequest;
  if (!baselineRequest || !candidateRequest) {
    throw new Error('Both dumps must contain an init or system_update entry');
  }

  return {
    instructionEstimatedTokens: numericDelta(
      baselineRequest.instructionEstimatedTokens,
      candidateRequest.instructionEstimatedTokens,
    ),
    systemEstimatedTokens: numericDelta(
      baselineRequest.systemEstimatedTokens,
      candidateRequest.systemEstimatedTokens,
    ),
    toolDescriptionEstimatedTokens: numericDelta(
      baselineRequest.toolDescriptionEstimatedTokens,
      candidateRequest.toolDescriptionEstimatedTokens,
    ),
    toolSchemaEstimatedTokens: numericDelta(
      baselineRequest.toolSchemaEstimatedTokens,
      candidateRequest.toolSchemaEstimatedTokens,
    ),
    actualInputTokens: numericDelta(
      baseline.totalUsage.actualInputTokens,
      candidate.totalUsage.actualInputTokens,
    ),
    cacheReadInputTokens: numericDelta(
      baseline.totalUsage.cache_read_input_tokens,
      candidate.totalUsage.cache_read_input_tokens,
    ),
    systemUpdates: numericDelta(
      baseline.systemUpdateCount,
      candidate.systemUpdateCount,
    ),
    responses: numericDelta(baseline.responseCount, candidate.responseCount),
  };
}

async function main() {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath) {
    throw new Error(
      'Usage: node scripts/analyze-prompt-dump.mjs <dump.jsonl> [candidate.jsonl]',
    );
  }

  const baseline = await analyzePromptDump(baselinePath);
  if (!candidatePath) {
    console.log(JSON.stringify(baseline, null, 2));
    return;
  }

  const candidate = await analyzePromptDump(candidatePath);
  console.log(
    JSON.stringify(
      {
        baseline,
        candidate,
        comparison: comparePromptDumps(baseline, candidate),
        limitations: [
          'Instruction token counts are character-based estimates; totalUsage comes from API responses.',
          'Prompt dumps do not measure wall-clock latency or task correctness; pair this report with behavior tests and repeated scenario timings.',
        ],
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

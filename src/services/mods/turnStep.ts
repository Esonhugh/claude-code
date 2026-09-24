import type { ModInput, ModTurnStepChunk, ModTurnStepResult } from './types.js'

const stopReasons = new Set([null, 'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'compaction', 'refusal', 'model_context_window_exceeded'])
function validUsage(usage: unknown): boolean {
  return usage === null || Boolean(usage && typeof usage === 'object' && typeof (usage as ModInput).model === 'string' &&
    ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(key =>
      typeof (usage as ModInput)[key] === 'number' && Number.isFinite((usage as ModInput)[key]) && ((usage as ModInput)[key] as number) >= 0))
}
export function validateTurnStepInput(value: ModInput): void {
  if (typeof value.model !== 'string' || !value.model || (value.effort !== undefined &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort as string) && !(typeof value.effort === 'number' && Number.isFinite(value.effort))))
    throw new Error('Invalid turn.step model or effort')
}
export function validateTurnStepChunk(chunk: unknown): asserts chunk is ModTurnStepChunk {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('Invalid turn.step chunk')
  const c = chunk as ModInput
  if (c.ref !== undefined && (!Number.isSafeInteger(c.ref) || (c.ref as number) < 0)) throw new Error('Invalid turn.step chunk ref')
  if (c.kind === 'engine' && c.ref !== undefined) return
  if (c.kind === 'stop' && stopReasons.has(c.stopReason as string | null) && validUsage(c.usage)) return
  if (Number.isSafeInteger(c.index) && (c.index as number) >= 0 &&
    ((['text', 'thinking'].includes(c.kind as string) && typeof c.text === 'string') ||
    (c.kind === 'input' && typeof c.json === 'string') || (c.kind === 'tool' && typeof c.id === 'string' && typeof c.name === 'string'))) return
  throw new Error('Invalid turn.step chunk')
}
export function validateTurnStepResult(result: unknown, input: ModInput): asserts result is ModTurnStepResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('turn.step must return a response')
  const value = result as ModInput
  if (value.turnId !== input.turnId || value.index !== input.index || typeof value.answer !== 'string' || !Array.isArray(value.toolUses) ||
    !value.toolUses.every(tool => tool && typeof tool === 'object' && typeof tool.name === 'string' && 'input' in tool) ||
    !stopReasons.has(value.stopReason as string | null) || !validUsage(value.usage)) throw new Error('Invalid turn.step response')
}

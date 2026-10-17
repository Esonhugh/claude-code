import { isDeepStrictEqual } from 'node:util'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { createToolCatalogForContext } from './toolCatalog.js'
import { createModToolHost } from './toolHost.js'
import type { ModSnapshot } from './runtime.js'

export type SkillPromptInput = { skill: string; text: string }
export type SkillPromptResult = { text: string }

function validateInput(value: unknown): asserts value is SkillPromptInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Partial<SkillPromptInput>).skill !== 'string' ||
    typeof (value as Partial<SkillPromptInput>).text !== 'string' ||
    Object.keys(value).some(key => key !== 'skill' && key !== 'text')
  )
    throw new TypeError('skill.prompt requires skill and text')
}

function validateResult(value: unknown): asserts value is SkillPromptResult {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Partial<SkillPromptResult>).text !== 'string' ||
    Object.keys(value).some(key => key !== 'text')
  )
    throw new TypeError('skill.prompt must return only text')
}

export function captureModSkillPromptSnapshot(
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): ModSnapshot | undefined {
  return context.mods?.capture({
    toolCatalog: () => createToolCatalogForContext(context),
    toolHost: () => createModToolHost(context, canUseTool),
  })
}

export async function renderModSkillPrompt({
  snapshot,
  skill,
  text,
  signal,
}: {
  snapshot: ModSnapshot
  skill: string
  text: string
  signal: AbortSignal
}): Promise<string> {
  const input: SkillPromptInput = { skill, text }
  const result = await snapshot.dispatch(
    'skill.prompt',
    input,
    async value => ({ text: value.text }),
    {
      signal,
      validateInput(value) {
        validateInput(value)
        if (!isDeepStrictEqual(value.skill, skill))
          throw new Error('skill.prompt cannot rewrite skill')
      },
      validateResult,
    },
  )
  validateResult(result)
  return result.text
}

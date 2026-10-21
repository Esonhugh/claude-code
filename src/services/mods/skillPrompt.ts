import { isDeepStrictEqual } from 'node:util'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command, PromptCommand } from '../../types/command.js'
import { createToolCatalogForContext } from './toolCatalog.js'
import { createModToolHost } from './toolHost.js'
import type { ModSnapshot } from './runtime.js'

/** Whose words a skill's prompt is: pinned beside the rewritable text and frontmatter. */
export type SkillPromptOrigin = {
  frontmatter: Record<string, unknown>
  source: string
  pluginName?: string
  path?: string
}
export type SkillPromptInput = { skill: string; text: string } & SkillPromptOrigin
export type SkillPromptResult = { text: string }

const inputKeys = new Set(['skill', 'text', 'frontmatter', 'source', 'pluginName', 'path'])
const pinnedKeys = ['skill', 'source', 'pluginName', 'path'] as const

export function modSkillPromptOrigin(command: Command & PromptCommand): SkillPromptOrigin {
  const frontmatter: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(command.skillFile?.frontmatter ?? {}))
    if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') frontmatter[key] = structuredClone(value)
  const pluginName = command.pluginInfo?.pluginManifest.name
  return {
    frontmatter,
    source: command.source === 'builtin' || command.source === 'bundled' ? 'built-in' : command.source,
    ...(pluginName === undefined ? {} : { pluginName }),
    ...(command.skillFile === undefined ? {} : { path: command.skillFile.path }),
  }
}

function validateInput(value: unknown): asserts value is SkillPromptInput {
  const input = value as Partial<SkillPromptInput> | null
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.skill !== 'string' ||
    typeof input.text !== 'string' ||
    !input.frontmatter || typeof input.frontmatter !== 'object' || Array.isArray(input.frontmatter) ||
    typeof input.source !== 'string' ||
    Object.keys(input).some(key => !inputKeys.has(key))
  )
    throw new TypeError('skill.prompt requires skill, text, frontmatter and source')
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
  origin,
  signal,
}: {
  snapshot: ModSnapshot
  skill: string
  text: string
  origin: SkillPromptOrigin
  signal: AbortSignal
}): Promise<string> {
  const input: SkillPromptInput = { skill, text, ...origin }
  const result = await snapshot.dispatch(
    'skill.prompt',
    input,
    async value => ({ text: value.text }),
    {
      signal,
      restoreInput(value, received) {
        const restored = { ...value }
        for (const key of pinnedKeys)
          if (!(key in restored) && received[key] !== undefined) restored[key] = received[key]
        return restored
      },
      validateInput(value, received) {
        validateInput(value)
        for (const key of pinnedKeys)
          if (!isDeepStrictEqual(value[key], received[key]))
            throw new Error(`skill.prompt cannot rewrite ${key}`)
      },
      validateResult,
    },
  )
  validateResult(result)
  return result.text
}

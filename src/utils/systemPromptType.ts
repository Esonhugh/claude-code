/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

import type { PromptComposeInput } from '../services/mods/types.js'

export type SystemPromptSection = (
  | { name: string; text: string | null }
  | { text: string }
  | { sections: readonly SystemPromptSection[]; separator: string }
) & { scope?: 'shared' | 'session' }

export type SystemPromptFacts = Pick<PromptComposeInput, 'promptModel' | 'outputStyle' | 'traits'>
const systemPromptFacts = Symbol('systemPromptFacts')

export function getSystemPromptFacts(prompt: readonly string[]): SystemPromptFacts | undefined {
  return (prompt as SystemPromptMetadata)[systemPromptFacts]
}

const systemPromptRecipe = Symbol('systemPromptRecipe')
type SystemPromptRecipe = (input: PromptComposeInput) => Promise<readonly string[]>

export function hasSystemPromptRecipe(prompt: readonly string[]): boolean {
  return (prompt as SystemPromptMetadata)[systemPromptRecipe] !== undefined
}

export async function renderSystemPrompt(
  prompt: readonly string[],
  input: PromptComposeInput,
): Promise<SystemPrompt> {
  const recipe = (prompt as SystemPromptMetadata)[systemPromptRecipe]
  if (!recipe) throw new Error('Prompt generation recipe is unavailable for this prompt')
  return asSystemPrompt(await recipe(input))
}

const systemPromptSections = Symbol('systemPromptSections')

type SystemPromptMetadata = {
  readonly [systemPromptSections]?: readonly SystemPromptSection[]
  readonly [systemPromptFacts]?: SystemPromptFacts
  readonly [systemPromptRecipe]?: SystemPromptRecipe
}

export type SystemPrompt = string[] &
  SystemPromptMetadata & {
    readonly __brand: 'SystemPrompt'
  }

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

export function withSystemPromptSections(
  sections: readonly SystemPromptSection[],
  facts?: SystemPromptFacts,
  recipe?: SystemPromptRecipe,
): SystemPrompt {
  const prompt = sections.flatMap(section =>
    'sections' in section
      ? [withSystemPromptSections(section.sections).join(section.separator)]
      : section.text === null ? [] : [section.text],
  ) as SystemPrompt
  Object.defineProperty(prompt, systemPromptSections, {
    value: sections.map(section => ({ ...section })),
    enumerable: false,
  })
  if (facts) Object.defineProperty(prompt, systemPromptFacts, {
    value: structuredClone(facts), enumerable: false,
  })
  if (recipe) Object.defineProperty(prompt, systemPromptRecipe, {
    value: recipe, enumerable: false,
  })
  return prompt
}

export function getSystemPromptSections(
  prompt: readonly string[],
): readonly SystemPromptSection[] | undefined {
  return (prompt as readonly string[] & SystemPromptMetadata)[systemPromptSections]
}

export function joinSystemPrompt(
  prompt: readonly string[],
  separator: string,
): SystemPrompt {
  const sections = getSystemPromptSections(prompt)
  return sections
    ? withSystemPromptSections([{ sections, separator }], getSystemPromptFacts(prompt),
      (prompt as SystemPromptMetadata)[systemPromptRecipe]
        ? async input => joinSystemPrompt(await renderSystemPrompt(prompt, input), separator)
        : undefined)
    : asSystemPrompt([prompt.join(separator)])
}

export function concatSystemPrompts(
  ...parts: readonly (readonly string[])[]
): SystemPrompt {
  if (!parts.some(part => getSystemPromptSections(part) !== undefined)) {
    return asSystemPrompt(parts.flat())
  }

  return withSystemPromptSections(
    parts.flatMap(part =>
      getSystemPromptSections(part) ?? part.map(text => ({ text, scope: 'session' as const })),
    ),
    parts.map(getSystemPromptFacts).find(facts => facts !== undefined),
    parts.some(part => (part as SystemPromptMetadata)[systemPromptRecipe])
      ? async input => concatSystemPrompts(...await Promise.all(parts.map(part =>
        (part as SystemPromptMetadata)[systemPromptRecipe] ? renderSystemPrompt(part, input) : part,
      )))
      : undefined,
  )
}

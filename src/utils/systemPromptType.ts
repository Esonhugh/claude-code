/**
 * Branded type for system prompt arrays.
 *
 * This module is intentionally dependency-free so it can be imported
 * from anywhere without risking circular initialization issues.
 */

export type SystemPromptSection =
  | { name: string; text: string | null }
  | { text: string }
  | { sections: readonly SystemPromptSection[]; separator: string }

const systemPromptSections = Symbol('systemPromptSections')

type SystemPromptMetadata = {
  readonly [systemPromptSections]?: readonly SystemPromptSection[]
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
    ? withSystemPromptSections([{ sections, separator }])
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
      getSystemPromptSections(part) ?? part.map(text => ({ text })),
    ),
  )
}

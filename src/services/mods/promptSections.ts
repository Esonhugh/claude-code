import {
  asSystemPrompt,
  getSystemPromptSections,
  type SystemPrompt,
  type SystemPromptSection,
} from '../../utils/systemPromptType.js'
import type { ModSnapshot } from './runtime.js'

type SectionResult = { text: string | null }

function validateSection(value: unknown): asserts value is SectionResult {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('text' in value) ||
    (value.text !== null && typeof value.text !== 'string')
  )
    throw new TypeError('prompt.section must return text or null')
}

export async function renderModPromptSections(
  prompt: SystemPrompt,
  snapshot: ModSnapshot,
  signal: AbortSignal,
): Promise<SystemPrompt> {
  const sections = getSystemPromptSections(prompt)
  if (!sections) return prompt
  const cache = snapshot.promptSections ?? new Map()

  async function read(
    name: string,
    text: string | null,
  ): Promise<SectionResult> {
    signal.throwIfAborted()
    let pending = cache.get(name)
    if (!pending) {
      const result = snapshot
        .dispatch(
          'prompt.section',
          { name, text },
          async input => ({ text: input.text }),
          {
            signal,
            validateInput(input) {
              validateSection(input)
              if (!('name' in input) || typeof input.name !== 'string')
                throw new TypeError('prompt.section requires a name')
            },
            validateResult: validateSection,
          },
        )
        .then(value => {
          validateSection(value)
          return { text: value.text }
        })
      pending = { result, signal }
      cache.set(name, pending)
      const entry = pending
      void result.catch(() => {
        if (cache.get(name) === entry) cache.delete(name)
      })
    }
    const entry = pending
    const owner = entry.signal
    let abort = () => {}
    try {
      const value = await Promise.race([
        entry.result,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.aborted ? signal.reason : owner.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (owner !== signal)
            owner.addEventListener('abort', abort, { once: true })
          if (signal.aborted || owner.aborted) abort()
        }),
      ])
      signal.throwIfAborted()
      return value
    } catch (error) {
      if (!signal.aborted && owner.aborted) {
        signal.removeEventListener('abort', abort)
        owner.removeEventListener('abort', abort)
        if (cache.get(name) === entry) cache.delete(name)
        return read(name, text)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      owner.removeEventListener('abort', abort)
    }
  }

  async function render(plan: readonly SystemPromptSection[]): Promise<string[]> {
    const rendered: string[] = []
    for (const section of plan) {
      signal.throwIfAborted()
      const text = 'sections' in section
        ? (await render(section.sections)).join(section.separator)
        : 'name' in section
          ? (await read(section.name, section.text)).text
          : section.text
      if (text !== null) rendered.push(text)
    }
    return rendered
  }
  // Forks inherit the resolved bytes, not a plan to run in another generation.
  return asSystemPrompt(await render(sections))
}

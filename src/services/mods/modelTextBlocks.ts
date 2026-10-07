import type {TextBlockParam} from '@anthropic-ai/sdk/resources/messages.js'

/** The public author declaration keeps cache?: true; JavaScript's false is unmarked. */
export type ModModelTextBlock = Readonly<{text: string; cache?: boolean}>

export function isModModelTextBlocks(value: unknown): value is readonly ModModelTextBlock[] {
  return Array.isArray(value) && Array.from(value).every(block => typeof block === 'object' && block !== null &&
    'text' in block && typeof block.text === 'string' && Object.entries(block).every(([key, value]) =>
      key === 'text' || key === 'cache' && (value === undefined || typeof value === 'boolean')))
}

/** Self-contained so the same function is compiled into the author realm. */
export function normalizeModModelCompleteRequest(request: unknown): Record<string, unknown> {
  const blocks = (value: unknown): value is readonly ModModelTextBlock[] => Array.isArray(value) &&
    Array.from(value).every(block => typeof block === 'object' && block !== null && 'text' in block &&
      typeof block.text === 'string' && Object.entries(block).every(([key, value]) =>
        key === 'text' || key === 'cache' && (value === undefined || typeof value === 'boolean')))
  const {prompt, system, ...rest} = {...request as Record<string, unknown>}
  const user = blocks(prompt) ? {prompt: prompt.map(block => block.text).join(''), promptBlocks: prompt} : {prompt}
  const rules = blocks(system) ? {system: system.map(block => block.text).join(''), systemBlocks: system} : {system}
  return {...rest, ...user, ...Boolean(system) && rules}
}

export function validateModModelCompleteInput(input: unknown, plugin?: string): void {
  const value = input as Record<string, unknown> | undefined
  let reason: string | undefined
  if (!(typeof value?.model === 'string' && typeof value.prompt === 'string'))
    reason = 'takes { model, prompt }, the prompt a string or a list of blocks, each { text } and at most `cache: true`'
  else if (!(typeof value.system === 'string' || !value.system))
    reason = 'takes a system that is a string or a list of blocks, each { text } and at most `cache: true`'
  else if (![value.promptBlocks, value.systemBlocks].every(blocks => blocks === undefined || isModModelTextBlocks(blocks)))
    reason = 'takes promptBlocks and systemBlocks that are lists of blocks, each { text } and at most `cache: true`'
  if (reason) throw Object.assign(new Error(plugin ? `${plugin}: model.complete: ${reason} (host check)` : reason), {name: 'HooksError'})
}

/** Only leading blocks that still match the edited text retain their marks. */
export function projectModModelText(text: string, blocks: readonly ModModelTextBlock[] = []): string | TextBlockParam[] {
  let count = 0, offset = 0
  for (const block of blocks) {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block.text) || !text.startsWith(block.text, offset)) break
    count++;offset += block.text.length
  }
  if (count === 0 || text === '') return text
  const tail = text.slice(offset)
  return [...blocks.slice(0, count), ...tail === '' ? [] : [{text: tail}]].map(block => ({type: 'text', text: block.text,
    ...block.cache === true && {cache_control: {type: 'ephemeral'}}}))
}

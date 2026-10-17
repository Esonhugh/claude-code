import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { renderClaudeMds, type MemoryFileInfo } from '../../utils/claudemd.js'

export type InstructionFile = {
  path: string
  kind: 'managed' | 'user' | 'project' | 'local' | 'memory'
  content: string
  parent?: string
}

export type PromptContext = {
  blocks: readonly { name: string; text: string }[]
  instructionFiles?: readonly InstructionFile[]
}

const memoryTypes = {
  managed: 'Managed',
  user: 'User',
  project: 'Project',
  local: 'Local',
  memory: 'AutoMem',
} as const

export function instructionFilesFromMemory(
  files: readonly MemoryFileInfo[],
): InstructionFile[] {
  return files.map(file => ({
    path: file.path,
    kind: file.type === 'AutoMem' || file.type === 'TeamMem'
      ? 'memory'
      : file.type.toLowerCase() as InstructionFile['kind'],
    content: file.content,
    ...(file.parent === undefined ? {} : { parent: file.parent }),
  }))
}

export function validatePromptContext(value: unknown): asserts value is PromptContext {
  if (!value || typeof value !== 'object' || !('blocks' in value) || !Array.isArray(value.blocks))
    throw new Error('prompt.context requires ordered blocks')
  const names = new Set<string>()
  for (const block of value.blocks) {
    if (!block || typeof block !== 'object' || typeof block.name !== 'string' ||
      typeof block.text !== 'string' || names.has(block.name))
      throw new Error('prompt.context requires unique named text blocks')
    names.add(block.name)
  }
  if (!('instructionFiles' in value) || value.instructionFiles === undefined) return
  if (!Array.isArray(value.instructionFiles))
    throw new Error('prompt.context requires ordered instructionFiles')
  for (const file of value.instructionFiles) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !isAbsolute(file.path) ||
      typeof file.kind !== 'string' || !Object.hasOwn(memoryTypes, file.kind) || typeof file.content !== 'string' ||
      (file.parent !== undefined && (typeof file.parent !== 'string' || !isAbsolute(file.parent))))
      throw new Error('prompt.context requires absolute instruction paths, known kinds and text content')
  }
}

/** Reconcile each downward next() and upward return against its immediate predecessor. */
export function reconcilePromptContext(value: unknown, previous: PromptContext): PromptContext {
  validatePromptContext(value)
  const files = value.instructionFiles ?? previous.instructionFiles
  const oldText = previous.blocks.find(block => block.name === 'claudeMd')?.text
  const newText = value.blocks.find(block => block.name === 'claudeMd')?.text
  const blocks = value.blocks.map(block => ({ ...block }))
  if (value.instructionFiles !== undefined && !isDeepStrictEqual(value.instructionFiles, previous.instructionFiles)) {
    const text = renderClaudeMds(value.instructionFiles.map(file => ({
      ...file, type: memoryTypes[file.kind],
    })))
    const index = blocks.findIndex(block => block.name === 'claudeMd')
    if (index >= 0) blocks.splice(index, 1, ...(text ? [{ name: 'claudeMd', text }] : []))
    else if (text) blocks.unshift({ name: 'claudeMd', text })
  } else if (newText !== oldText) {
    // Text-only rewrites cannot claim the old files, even via {...received}.
    return { blocks }
  }
  return {
    blocks,
    ...(files === undefined ? {} : { instructionFiles: files.map(file => ({ ...file })) }),
  }
}

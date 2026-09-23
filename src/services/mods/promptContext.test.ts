import { describe, expect, test } from 'bun:test'
import {
  reconcilePromptContext,
  validatePromptContext,
  type InstructionFile,
  type PromptContext,
} from './promptContext.js'

const files: InstructionFile[] = [
  { path: '/fixture/import.md', kind: 'project', content: 'imported marker', parent: '/fixture/CLAUDE.md' },
  { path: '/fixture/CLAUDE.md', kind: 'project', content: 'project marker' },
  { path: '/fixture/MEMORY.md', kind: 'memory', content: 'memory marker' },
]
const empty: PromptContext = { blocks: [{ name: 'currentDate', text: 'today' }], instructionFiles: [] }
const initial = () => reconcilePromptContext({ ...empty, instructionFiles: files }, empty)

describe('prompt.context instruction reconciliation', () => {
  test('renders additions and imported files in order without changing the input', () => {
    const result = initial()
    expect(result.blocks[0]!.text).toContain('imported marker')
    expect(result.blocks[0]!.text.indexOf('imported marker')).toBeLessThan(result.blocks[0]!.text.indexOf('project marker'))
    expect(result.instructionFiles).toEqual(files)
    expect(empty.blocks).toEqual([{ name: 'currentDate', text: 'today' }])
  })

  test('renders deletion, replacement and reordering before the next reader', () => {
    const before = initial()
    const replacement = { ...files[0]!, content: 'replacement marker' }
    const result = reconcilePromptContext({ ...before, instructionFiles: [files[2]!, replacement] }, before)
    const text = result.blocks.find(block => block.name === 'claudeMd')!.text
    expect(text).not.toContain('project marker')
    expect(text).not.toContain('imported marker')
    expect(text.indexOf('memory marker')).toBeLessThan(text.indexOf('replacement marker'))
    expect(result.instructionFiles?.[1]?.parent).toBe('/fixture/CLAUDE.md')
  })

  test('an explicit empty list removes the actual claudeMd block', () => {
    expect(reconcilePromptContext({ ...initial(), instructionFiles: [] }, initial())).toEqual(empty)
  })

  test('rewriting or dropping claudeMd invalidates even an unchanged supplied list', () => {
    const before = initial()
    const changed = reconcilePromptContext({ ...before, blocks: [{ name: 'claudeMd', text: 'opaque text' }] }, before)
    expect(changed).toEqual({ blocks: [{ name: 'claudeMd', text: 'opaque text' }] })
    expect(reconcilePromptContext({ blocks: [] }, before)).toEqual({ blocks: [] })
    expect(reconcilePromptContext({ ...changed, blocks: [...changed.blocks, { name: 'note', text: 'extra' }] }, changed).instructionFiles).toBeUndefined()
  })

  test('an omitted result list preserves the files returned from below, not those originally received', () => {
    const received = initial()
    const below = reconcilePromptContext({ ...received, instructionFiles: [files[2]!] }, received)
    const result = reconcilePromptContext({ blocks: [...below.blocks, { name: 'note', text: 'extra' }] }, below)
    expect(result.instructionFiles).toEqual([files[2]!])
    expect(result.blocks[0]!.text).not.toContain('project marker')
  })

  test('unknown provenance cannot be reconstructed from text or an omitted list', () => {
    const opaque = { blocks: [{ name: 'claudeMd', text: initial().blocks[0]!.text }] }
    expect(reconcilePromptContext(opaque, opaque)).toEqual(opaque)
    const result = reconcilePromptContext({ ...opaque, instructionFiles: [files[0]!] }, opaque)
    expect(result.instructionFiles).toEqual([files[0]!])
    expect(result.blocks[0]!.text).not.toContain('memory marker')
  })

  test('unchanged lists keep block order and exact core formatting', () => {
    const before = initial()
    const reordered = { ...before, blocks: [...before.blocks].reverse() }
    expect(reconcilePromptContext(reordered, before)).toEqual(reordered)
  })

  test.each([
    { instructionFiles: null },
    { instructionFiles: [{ ...files[0], path: 'relative.md' }] },
    { instructionFiles: [{ ...files[0], parent: 'relative.md' }] },
    { instructionFiles: [{ ...files[0], kind: 'invented' }] },
    { instructionFiles: [{ ...files[0], kind: ['project'] }] },
    { instructionFiles: [{ ...files[0], content: 12 }] },
  ])('rejects malformed instruction file contracts %j', invalid => {
    expect(() => validatePromptContext({ ...empty, ...invalid })).toThrow()
  })
})

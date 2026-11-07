import { expect, test } from 'bun:test'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { checkEditableInternalPath, checkReadableInternalPath } = await import('./filesystem.js')
const { getPlansDirectory, getPlanSlug } = await import('../plans.js')

const plansDir = getPlansDirectory()
const slug = getPlanSlug()

test.each([`${slug}.md`, `${slug}-agent-abc123.md`])(
  "this session's plan file %s is editable and readable without a prompt",
  file => {
    const path = join(plansDir, file)
    expect(checkEditableInternalPath(path, { file_path: path }).behavior).toBe('allow')
    expect(checkReadableInternalPath(path, { file_path: path }).behavior).toBe('allow')
  },
)

test.each([`${slug}-other.md`, `${slug}.md.bak`, `${slug}-agent-abc123.txt`, `${slug}x.md`])(
  "another session's plan file %s is not (#808)",
  file => {
    const path = join(plansDir, file)
    expect(checkEditableInternalPath(path, { file_path: path }).behavior).toBe('passthrough')
    expect(checkReadableInternalPath(path, { file_path: path }).behavior).toBe('passthrough')
  },
)

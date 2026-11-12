import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, Tools } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

// An SDK host is asked about a patch one file at a time, as Edit and Write.

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { askApplyPatchPerFile } = await import('./askPerFile.js')
const { planPatch } = await import('./plan.js')

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'apply-patch-ask-per-file-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const p = (name: string) => join(dir, name)
function reset() {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  writeFileSync(p('a.txt'), 'alpha\nbeta\n')
  writeFileSync(p('b.txt'), 'one\ntwo\n')
  writeFileSync(p('gone.txt'), 'bye\n')
  writeFileSync(p('m.txt'), 'move me\n')
  writeFileSync(p('bom.txt'), '﻿first\nsecond')
}

const tools = [{ name: 'Edit' }, { name: 'Write' }] as unknown as Tools
const patch = (...sections: string[]) => ({ input: ['*** Begin Patch', ...sections, '*** End Patch'].join('\n') })
const UPDATE_A = `*** Update File: ${p('a.txt')}\n alpha\n-beta\n+BETA`
const ADD_NEW = `*** Add File: ${p('sub/new.txt')}\n+hello`
const UPDATE_B = `*** Update File: ${p('b.txt')}\n-two\n+TWO`
const DELETE_GONE = `*** Delete File: ${p('gone.txt')}`
const MOVE_M = `*** Update File: ${p('m.txt')}\n*** Move to: ${p('moved.txt')}\n-move me\n+moved`

type Asked = { tool: string; input: Record<string, unknown> }
function host(answer: (a: Asked) => PermissionDecision = a => ({ behavior: 'allow', updatedInput: a.input })) {
  const asked: Asked[] = []
  const ask = async (tool: Tool, input: Record<string, unknown>) => {
    asked.push({ tool: tool.name, input })
    return answer({ tool: tool.name, input })
  }
  return { asked, ask }
}
const contents = (input: unknown) =>
  planPatch((input as { input: string }).input).planned.map(f => [f.absoluteMovePath ?? f.absolutePath, f.updated])

test('each file is asked as the Edit or Write call that makes the same change', async () => {
  reset()
  const input = patch(UPDATE_A, ADD_NEW, DELETE_GONE, MOVE_M)
  const { asked, ask } = host()
  const decision = await askApplyPatchPerFile(input, tools, ask)
  expect(asked).toEqual([
    { tool: 'Edit', input: { file_path: p('a.txt'), old_string: 'alpha\nbeta\n', new_string: 'alpha\nBETA\n', replace_all: false } },
    { tool: 'Write', input: { file_path: p('sub/new.txt'), content: 'hello\n' } },
    { tool: 'Edit', input: { file_path: p('gone.txt'), old_string: 'bye\n', new_string: '', replace_all: false } },
    { tool: 'Write', input: { file_path: p('moved.txt'), content: 'moved\n' } },
    { tool: 'Edit', input: { file_path: p('m.txt'), old_string: 'move me\n', new_string: '', replace_all: false } },
  ])
  expect(decision).toEqual({ behavior: 'allow', updatedInput: input })
})

test('a denied first file denies the patch with the host message', async () => {
  reset()
  const { asked, ask } = host(() => ({ behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'host' } }))
  const decision = await askApplyPatchPerFile(patch(UPDATE_A, UPDATE_B), tools, ask)
  expect(asked.length).toBe(1)
  expect(decision).toMatchObject({ behavior: 'deny', message: 'no' })
})

test('a denied later file keeps the files before it and stops there', async () => {
  reset()
  const { asked, ask } = host(a => (String(a.input.file_path).endsWith('new.txt') ? { behavior: 'deny', message: 'protected', decisionReason: { type: 'other', reason: 'host' } } : { behavior: 'allow', updatedInput: a.input }))
  const decision = await askApplyPatchPerFile(patch(UPDATE_A, ADD_NEW, UPDATE_B), tools, ask)
  expect(asked.map(a => a.tool)).toEqual(['Edit', 'Write'])
  expect(decision.behavior).toBe('allow')
  if (decision.behavior !== 'allow') return
  expect(contents(decision.updatedInput)).toEqual([[p('a.txt'), 'alpha\nBETA\n']])
  expect(decision.acceptFeedback).toContain(`Permission to change ${p('sub/new.txt')} was denied: protected`)
  expect(decision.acceptFeedback).toContain(p('b.txt'))
})

test('content the host changes is what gets written', async () => {
  reset()
  const { ask } = host(a =>
    a.tool === 'Edit'
      ? { behavior: 'allow', updatedInput: { ...a.input, new_string: String(a.input.new_string).replace(/BETA|TWO|second/, 'HOST') } }
      : { behavior: 'allow', updatedInput: { ...a.input, content: 'from host\n' } },
  )
  const bomEdit = `*** Update File: ${p('bom.txt')}\n-second\n+SECOND`
  const decision = await askApplyPatchPerFile(patch(UPDATE_A, ADD_NEW, UPDATE_B, bomEdit), tools, ask)
  expect(decision).toMatchObject({ behavior: 'allow', userModified: true })
  if (decision.behavior !== 'allow') return
  expect(contents(decision.updatedInput)).toEqual([
    [p('a.txt'), 'alpha\nHOST\n'],
    [p('sub/new.txt'), 'from host\n'],
    [p('b.txt'), 'one\nHOST\n'],
    [p('bom.txt'), '﻿first\nSECOND\n'],
  ])
})

test('a host that changes the file path is refused', async () => {
  reset()
  const { ask } = host(a => ({ behavior: 'allow', updatedInput: { ...a.input, file_path: p('elsewhere.txt') } }))
  const decision = await askApplyPatchPerFile(patch(UPDATE_A), tools, ask)
  expect(decision?.behavior).toBe('deny')
  expect(readFileSync(p('a.txt'), 'utf8')).toBe('alpha\nbeta\n')
})

test('a file that does not apply is not asked about; the tool reports it', async () => {
  reset()
  const input = patch(UPDATE_A, `*** Update File: ${p('b.txt')}\n-missing\n+x`, ADD_NEW)
  const { asked, ask } = host()
  expect(await askApplyPatchPerFile(input, tools, ask)).toEqual({ behavior: 'allow', updatedInput: input })
  expect(asked.map(a => a.input.file_path)).toEqual([p('a.txt')])
})

test('falls back to one request when the patch cannot be split', async () => {
  reset()
  const { asked, ask } = host()
  expect(await askApplyPatchPerFile({ input: 'not a patch' }, tools, ask)).toBeNull()
  expect(await askApplyPatchPerFile(patch(UPDATE_A), [{ name: 'Edit' }] as unknown as Tools, ask)).toBeNull()
  expect(asked).toEqual([])
})

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grade, leanKeepsStatements } from './grade'
import type { Task } from './tasks'

const task = (g: Task['grade']): Task => ({ id: 't', type: 'coding', length: 'short', requires: [], grade: g, dir: '/nonexistent', prompt: '', sessions: [''] })

describe('grade', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-grade-'))
  fs.writeFileSync(path.join(ws, 'ANSWER.md'), 'math...\nCHEAPEST: **BluePeak**\n')
  test('all steps must pass', () => {
    const ok = grade(task([{ type: 'exists', path: 'ANSWER.md' }, { type: 'regex', file: 'ANSWER.md', pattern: 'CHEAPEST:[*`\\s]*bluepeak', flags: 'i' }, { type: 'cmd', run: 'test -s ANSWER.md' }]), { workspace: ws })
    expect(ok.ok).toBe(true)
    const bad = grade(task([{ type: 'exists', path: 'ANSWER.md' }, { type: 'cmd', run: 'echo nope; exit 3' }]), { workspace: ws })
    expect(bad.ok).toBe(false)
    expect(bad.steps[1].detail).toContain('nope')
  })
  test('a missing file fails a regex step instead of throwing', () => {
    expect(grade(task([{ type: 'regex', file: 'NOPE.md', pattern: '.' }]), { workspace: ws }).ok).toBe(false)
  })
  test('lab tasks fail when the agent used a side door into the target', () => {
    const t = task([{ type: 'lab' }])
    expect(grade(t, { workspace: ws, labCheck: { ok: true }, labBypass: 0 }).ok).toBe(true)
    expect(grade(t, { workspace: ws, labCheck: { ok: true }, labBypass: 2 }).ok).toBe(false)
    expect(grade(t, { workspace: ws, labCheck: null }).ok).toBe(false)
  })
})

describe('leanKeepsStatements', () => {
  const orig = 'theorem a (n : Nat) : n + 0 = n := by\n  sorry\n\ndef answer : Nat := sorry\n'
  test('proofs may replace sorry and add helpers', () => {
    expect(leanKeepsStatements(orig, 'theorem helper : True := trivial\ntheorem a (n : Nat) :  n + 0 = n := by\n  simp\ndef answer : Nat := 4\n')).toBe(true)
  })
  test('a changed statement is rejected', () => {
    expect(leanKeepsStatements(orig, 'theorem a (n : Nat) : n = n := by\n  rfl\n')).toBe(false)
  })
})
